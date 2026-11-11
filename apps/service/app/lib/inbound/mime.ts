/**
 * Read the fields of a received mail that the `email.received` event carries.
 *
 * Bounded memory: the raw mail is streamed through mailparser's streaming
 * MailParser. Attachment streams are drained and dropped chunk by chunk, so a
 * 40 MB mail (the SES maximum) never sits in memory as attachments; only the
 * header block and the text parts are held.
 *
 * Text rule: the text/plain part(s). With no text/plain part, the HTML part
 * converted to plain text (mailparser's html-to-text). With neither, "".
 * Never HTML markup. Capped at INBOUND_TEXT_MAX_CHARS.
 *
 * Sender authentication facts: the ordered raw header lines (mailparser's
 * `headerLines` event) go to `readSesAuthenticationResults`, which keeps only
 * the Authentication-Results header SES wrote. See ./authentication.ts. The
 * same lines go to `readAutoReply` for the auto-reply headers. See ./auto-reply.ts.
 *
 * Errors never quote the mail.
 */

import type { Readable } from 'node:stream';
import { MailParser, type AddressObject, type EmailAddress, type HeaderLines, type Headers } from 'mailparser';
import { readSesAuthenticationResults, type SesAuthenticationFacts } from './authentication';
import { readAutoReply, type AutoReply } from './auto-reply';

export const INBOUND_TEXT_MAX_CHARS = 100_000;

/**
 * HTML larger than this is not converted to text (html-to-text is CPU bound
 * and would block the event loop). The mail then carries text "".
 */
export const INBOUND_MAX_HTML_TO_TEXT_CHARS = 2_000_000;

/** mailparser's placeholders when it refuses to convert HTML. */
const HTML_FAILURE_PLACEHOLDERS = ['Invalid HTML content (too long)', 'Invalid HTML content'];

export interface InboundMessage {
  from: string;
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Bytes of attachment content read and dropped. Never retained. */
  attachmentBytesDiscarded: number;
  /** Exactly one From header holding exactly one mailbox. */
  hasSingleFrom: boolean;
  /** Facts from the Authentication-Results header SES wrote. Domains only. */
  sesAuthentication: SesAuthenticationFacts;
  /** Auto-Submitted, Precedence and X-Auto-Response-Suppress, as header values only. See ./auto-reply.ts. */
  autoReply: AutoReply;
}

export class InboundMimeError extends Error {
  constructor(reason: string) {
    super(`Unparseable MIME: ${reason}`);
    this.name = 'InboundMimeError';
  }
}

/** The raw mail stream failed (for example an S3 read cut short). Retryable. */
export class InboundSourceError extends Error {
  constructor() {
    super('Raw mail stream failed while reading');
    this.name = 'InboundSourceError';
  }
}

function firstAddress(entries: readonly EmailAddress[]): string {
  for (const entry of entries) {
    const address = entry.address?.trim();
    if (address) return address;
    const nested = firstAddress(entry.group ?? []);
    if (nested) return nested;
  }
  return '';
}

function fromEntries(value: unknown): EmailAddress[] {
  if (!value || typeof value !== 'object') return [];
  const objects = (Array.isArray(value) ? value : [value]) as AddressObject[];
  return objects.flatMap((object) => object.value ?? []);
}

function readFrom(value: unknown): string {
  return firstAddress(fromEntries(value));
}

function countMailboxes(entries: readonly EmailAddress[]): number {
  return entries.reduce((count, entry) => {
    const own = entry.address?.trim() ? 1 : 0;
    return count + own + countMailboxes(entry.group ?? []);
  }, 0);
}

/** mailparser keeps only the last of repeated From headers, so count the raw lines too. */
function hasSingleFrom(opts: { headers: Headers; headerLines: HeaderLines }): boolean {
  const fromLines = opts.headerLines.filter((header) => header.key.toLowerCase() === 'from').length;
  return fromLines === 1 && countMailboxes(fromEntries(opts.headers.get('from'))) === 1;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readReferences(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((item): item is string => typeof item === 'string')
    .flatMap((item) => item.split(/\s+/))
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Cut to the cap without leaving half of a surrogate pair at the end. */
export function capText(text: string): string {
  if (text.length <= INBOUND_TEXT_MAX_CHARS) return text;
  const cut = text.slice(0, INBOUND_TEXT_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}

function cleanText(opts: { text: string; htmlFailed: boolean }): string {
  if (!opts.htmlFailed) return capText(opts.text);
  const stripped = HTML_FAILURE_PLACEHOLDERS.reduce((acc, marker) => acc.split(marker).join(''), opts.text);
  return capText(stripped.trim());
}

function buildMessage(opts: {
  headers: Headers;
  headerLines: HeaderLines;
  text: string;
  htmlFailed: boolean;
  attachmentBytesDiscarded: number;
}): InboundMessage {
  const { headers } = opts;
  return {
    from: readFrom(headers.get('from')),
    subject: readString(headers.get('subject')) ?? '',
    text: cleanText({ text: opts.text, htmlFailed: opts.htmlFailed }),
    messageId: readString(headers.get('message-id')),
    inReplyTo: readString(headers.get('in-reply-to')),
    references: readReferences(headers.get('references')),
    attachmentBytesDiscarded: opts.attachmentBytesDiscarded,
    hasSingleFrom: hasSingleFrom({ headers, headerLines: opts.headerLines }),
    sesAuthentication: readSesAuthenticationResults(opts.headerLines),
    autoReply: readAutoReply(opts.headerLines),
  };
}

function isHtmlConversionError(error: Error): boolean {
  return /^HTML too long for parsing|^Failed to parse HTML/.test(error.message);
}

/**
 * Stream a raw RFC 5322 mail through the parser and keep only the event fields.
 *
 * @throws InboundMimeError when the parser fails (permanent).
 * @throws InboundSourceError when the source stream errors (retryable).
 */
export function extractInboundMessage(source: Readable): Promise<InboundMessage> {
  const parser = new MailParser({
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    maxHtmlLengthToParse: INBOUND_MAX_HTML_TO_TEXT_CHARS,
  });

  return new Promise<InboundMessage>((resolve, reject) => {
    let headers: Headers = new Map();
    let headerLines: HeaderLines = [];
    let text = '';
    let htmlFailed = false;
    let attachmentBytesDiscarded = 0;
    let isSettled = false;

    const settleWithError = (error: Error): void => {
      if (isSettled) return;
      isSettled = true;
      source.unpipe(parser);
      source.destroy();
      reject(error);
    };
    const fail = (reason: string): void => settleWithError(new InboundMimeError(reason));

    parser.on('headers', (parsed: Headers) => {
      headers = parsed;
    });

    parser.on('headerLines', (lines: HeaderLines) => {
      headerLines = lines;
    });

    parser.on('data', (data) => {
      if (data.type === 'text') {
        text = data.text ?? '';
        return;
      }
      // Attachment: count and drop each chunk, then let the parser go on.
      data.content.on('data', (chunk: Buffer) => {
        attachmentBytesDiscarded += chunk.length;
      });
      data.content.on('end', () => data.release());
      data.content.on('error', () => fail('attachment stream error'));
    });

    parser.on('error', (error: Error) => {
      if (isHtmlConversionError(error)) {
        htmlFailed = true;
        return;
      }
      fail(error.name || 'parser error');
    });

    parser.on('end', () => {
      if (isSettled) return;
      isSettled = true;
      resolve(buildMessage({ headers, headerLines, text, htmlFailed, attachmentBytesDiscarded }));
    });

    source.on('error', () => settleWithError(new InboundSourceError()));
    source.pipe(parser);
  });
}
