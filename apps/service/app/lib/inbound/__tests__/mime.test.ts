import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import {
  capText,
  extractInboundMessage,
  INBOUND_TEXT_MAX_CHARS,
  InboundSourceError,
} from '../mime';
import {
  alternativeMail,
  buildMime,
  htmlOnlyMail,
  plainMail,
  receivedMail,
  SAMPLE,
  sesPrependedHeaders,
} from '../../../../test/support/inbound-fixtures';

function read(raw: Buffer) {
  return extractInboundMessage(Readable.from([raw]));
}

const TAG = /<\/?[a-z][a-z0-9]*[^>]*>/i;

describe('extractInboundMessage', () => {
  it('reads the header fields and the text/plain body', async () => {
    const message = await read(plainMail());
    expect(message).toEqual({
      from: SAMPLE.from,
      subject: SAMPLE.subject,
      text: SAMPLE.body,
      messageId: SAMPLE.messageId,
      inReplyTo: SAMPLE.inReplyTo,
      references: [SAMPLE.inReplyTo],
      attachmentBytesDiscarded: 0,
      hasSingleFrom: true,
      sesAuthentication: {
        isTrusted: false,
        dkimPassDomains: [],
        spfResult: null,
        spfDomain: null,
        dmarcResult: null,
        dmarcFromDomain: null,
      },
      autoReply: { auto_submitted: null, precedence: null, auto_response_suppress: null, is_auto: false },
    });
  });

  it('reads the auto-reply headers from the ordered header lines, the first occurrence winning', async () => {
    const message = await read(
      receivedMail({
        prepended: [],
        senderHeaders: ['Auto-Submitted: Auto-Replied (Vacation)', 'Auto-Submitted: no', 'Precedence: list'],
        headers: { 'X-Auto-Response-Suppress': 'All' },
      }),
    );
    expect(message.autoReply).toEqual({
      auto_submitted: 'auto-replied (vacation)',
      precedence: 'list',
      auto_response_suppress: 'all',
      is_auto: true,
    });
  });

  it('reads the SES Authentication-Results header from the ordered header lines', async () => {
    const message = await read(
      receivedMail({
        prepended: sesPrependedHeaders({
          results: ['spf=pass (check) envelope-from=bounce@example.net', 'dkim=pass header.d=example.com', 'dmarc=pass header.from=example.com'],
        }),
      }),
    );
    expect(message.from).toBe(SAMPLE.from);
    expect(message.sesAuthentication).toEqual({
      isTrusted: true,
      dkimPassDomains: ['example.com'],
      spfResult: 'pass',
      spfDomain: 'example.net',
      dmarcResult: 'pass',
      dmarcFromDomain: 'example.com',
    });
  });

  it('counts From headers and mailboxes', async () => {
    expect((await read(plainMail(SAMPLE.body, { From: 'a@example.com, b@example.net' }))).hasSingleFrom).toBe(false);
    expect((await read(plainMail(SAMPLE.body, { From: '' }))).hasSingleFrom).toBe(false);
    const twoHeaders = receivedMail({ prepended: ['From: a@example.net'] });
    expect((await read(twoHeaders)).hasSingleFrom).toBe(false);
  });

  it('takes the text/plain part of multipart/alternative, never the HTML', async () => {
    const message = await read(alternativeMail({ text: 'plain wins', html: '<p>html loses</p>' }));
    expect(message.text).toBe('plain wins');
  });

  it('converts an HTML-only mail to plain text with no markup left', async () => {
    const message = await read(
      htmlOnlyMail('<div><p>Hello <b>support</b>,</p><p>first line<br>second line</p><div>thanks</div></div>'),
    );
    expect(message.text).toContain('Hello');
    expect(message.text).toContain('support');
    expect(message.text).toContain('second line');
    expect(message.text).not.toMatch(TAG);
    for (const tag of ['<p>', '</p>', '<div>', '<br>', '<b>']) expect(message.text).not.toContain(tag);
  });

  it('sends "" when the mail has neither a text nor an HTML part', async () => {
    const boundary = 'only-attachment';
    const raw = buildMime({
      contentType: `multipart/mixed; boundary="${boundary}"`,
      body: [
        `--${boundary}`,
        'Content-Type: application/pdf',
        'Content-Disposition: attachment; filename="scan.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('%PDF-1.4 fake').toString('base64'),
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    });
    const message = await read(raw);
    expect(message.text).toBe('');
    expect(message.attachmentBytesDiscarded).toBeGreaterThan(0);
  });

  it('splits a References header with several ids into an array', async () => {
    const message = await read(plainMail('x', { References: '<a@example.test> <b@example.test>\r\n <c@example.test>' }));
    expect(message.references).toEqual(['<a@example.test>', '<b@example.test>', '<c@example.test>']);
  });

  it('turns missing headers into "" / null / []', async () => {
    const raw = buildMime({
      body: 'just text',
      headers: { From: '', Subject: '', 'Message-ID': '', 'In-Reply-To': '', References: '' },
    });
    const message = await read(raw);
    expect(message).toMatchObject({ from: '', subject: '', messageId: null, inReplyTo: null, references: [] });
    expect(message.text).toBe('just text');
  });

  it('uses the bare address of the first From address', async () => {
    const message = await read(plainMail('x', { From: '"Doe, Jane" <  jane@example.com  >, other@example.com' }));
    expect(message.from).toBe('jane@example.com');
  });

  it(`caps the text at ${INBOUND_TEXT_MAX_CHARS} characters`, async () => {
    const message = await read(plainMail('a'.repeat(INBOUND_TEXT_MAX_CHARS + 500)));
    expect(message.text.length).toBe(INBOUND_TEXT_MAX_CHARS);
  });

  it('never cuts a surrogate pair in half at the cap', () => {
    const text = `${'a'.repeat(INBOUND_TEXT_MAX_CHARS - 1)}\u{1F600}tail`;
    const capped = capText(text);
    expect(capped.length).toBe(INBOUND_TEXT_MAX_CHARS - 1);
    expect(capText('short')).toBe('short');
  });

  it('rejects with a retryable error when the source stream fails', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('socket hang up'));
      },
    });
    await expect(extractInboundMessage(source)).rejects.toBeInstanceOf(InboundSourceError);
  });

  it(
    'streams a 36 MB mail with a 27 MB attachment and keeps none of the attachment',
    async () => {
      const attachment = randomBytes(27 * 1024 * 1024);
      const marker = attachment.subarray(1000, 1064).toString('base64');
      const boundary = 'big-mixed';
      const head = buildMime({
        contentType: `multipart/mixed; boundary="${boundary}"`,
        body: [
          `--${boundary}`,
          'Content-Type: text/plain; charset=utf-8',
          '',
          'see attachment',
          `--${boundary}`,
          'Content-Type: application/octet-stream',
          'Content-Disposition: attachment; filename="big.bin"',
          'Content-Transfer-Encoding: base64',
          '',
          '',
        ].join('\r\n'),
      });
      const base64 = attachment.toString('base64').replace(/.{76}/g, '$&\r\n');
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

      // Feed it in 64 KiB chunks, the way an S3 body stream arrives.
      function* chunks(): Generator<Buffer> {
        yield head;
        const encoded = Buffer.from(base64, 'ascii');
        for (let offset = 0; offset < encoded.length; offset += 64 * 1024) {
          yield encoded.subarray(offset, offset + 64 * 1024);
        }
        yield tail;
      }

      const message = await extractInboundMessage(Readable.from(chunks()));
      expect(message.text).toBe('see attachment');
      expect(message.attachmentBytesDiscarded).toBe(attachment.length);
      const retained = JSON.stringify(message);
      expect(retained.length).toBeLessThan(2_000);
      expect(retained).not.toContain(marker);
    },
    60_000,
  );
});
