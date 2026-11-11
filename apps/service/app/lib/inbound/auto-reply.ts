/**
 * Is this mail an automatic reply? Pure, header values only, no addresses.
 *
 * Reads three headers from the ordered raw header lines (mailparser's
 * `headerLines` event): `Auto-Submitted` (RFC 3834), `Precedence` and
 * `X-Auto-Response-Suppress` (Microsoft). The first occurrence of a header
 * wins. A header with an empty value counts as absent.
 *
 * The stored value is the raw value, unfolded, trimmed, lower case and cut to
 * AUTO_REPLY_HEADER_MAX_CHARS. The decision (`is_auto`) is made on the whole
 * value before the cut, so a long comment in front cannot hide the keyword.
 * The keyword is the first token before any `;`, with comments in
 * parentheses removed.
 */

import type { RawHeaderLine } from './authentication';

export const AUTO_REPLY_HEADER_MAX_CHARS = 200;

/** `Precedence` keywords of automatic mail. `list` is a mailing list, so it is not here. */
const AUTO_PRECEDENCE_KEYWORDS: ReadonlySet<string> = new Set(['bulk', 'junk', 'auto_reply']);

/** The `auto` object of `email.received`. Key order is fixed, the body is signed as sent. */
export interface AutoReply {
  auto_submitted: string | null;
  precedence: string | null;
  auto_response_suppress: string | null;
  is_auto: boolean;
}

/** The header text after the first colon, unfolded and trimmed. */
function headerBody(line: string): string {
  const colon = line.indexOf(':');
  return line
    .slice(colon + 1)
    .replace(/\r?\n/g, '')
    .trim();
}

/** Remove (comments) with nesting and backslash escapes. An unclosed comment runs to the end. */
function stripComments(text: string): string {
  let depth = 0;
  let isEscaped = false;
  let result = '';
  for (const char of text) {
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (depth > 0 && char === '\\') {
      isEscaped = true;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')' && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) result += char;
  }
  return result;
}

/** First token of the value, before any `;` or comment. Lower case. */
function keywordOf(value: string): string {
  const beforeParameters = stripComments(value).split(';')[0] ?? '';
  return beforeParameters.trim().split(/\s+/)[0] ?? '';
}

/** Lower-case, trimmed value of the first line with this name, or null when absent or empty. */
function readHeaderValue(opts: { headerLines: readonly RawHeaderLine[]; name: string }): string | null {
  const first = opts.headerLines.find((header) => header.key.toLowerCase() === opts.name);
  if (!first) return null;
  const value = headerBody(first.line).toLowerCase();
  return value === '' ? null : value;
}

/** Cut to the cap without leaving half of a surrogate pair at the end. */
function capValue(value: string): string {
  if (value.length <= AUTO_REPLY_HEADER_MAX_CHARS) return value;
  const cut = value.slice(0, AUTO_REPLY_HEADER_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}

function capOrNull(value: string | null): string | null {
  return value === null ? null : capValue(value);
}

export function readAutoReply(headerLines: readonly RawHeaderLine[]): AutoReply {
  const autoSubmitted = readHeaderValue({ headerLines, name: 'auto-submitted' });
  const precedence = readHeaderValue({ headerLines, name: 'precedence' });
  const autoResponseSuppress = readHeaderValue({ headerLines, name: 'x-auto-response-suppress' });

  const isAutoSubmitted = autoSubmitted !== null && keywordOf(autoSubmitted) !== 'no';
  const isAutoPrecedence = precedence !== null && AUTO_PRECEDENCE_KEYWORDS.has(keywordOf(precedence));
  const isSuppressed = autoResponseSuppress !== null;

  return {
    auto_submitted: capOrNull(autoSubmitted),
    precedence: capOrNull(precedence),
    auto_response_suppress: capOrNull(autoResponseSuppress),
    is_auto: isAutoSubmitted || isAutoPrecedence || isSuppressed,
  };
}
