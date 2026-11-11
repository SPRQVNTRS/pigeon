/**
 * Fixtures for the inbound mail tests: raw MIME mails, SES receipt
 * notifications and signed SNS envelopes. Invented addresses only
 * (example.com / example.test).
 */

import { createSign, generateKeyPairSync } from 'node:crypto';
import type { SnsEnvelope } from '#app/lib/sns/verifier';

export const TOPIC_ARN = 'arn:aws:sns:eu-central-1:123456789012:pigeon-inbound-test';
export const OTHER_TOPIC_ARN = 'arn:aws:sns:eu-central-1:123456789012:someone-else';
export const CERT_URL = 'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-test.pem';

/** Values the privacy test hunts for in every log line. */
export const SAMPLE = {
  fromName: 'Erika Mustersender',
  from: 'erika.sender@example.com',
  recipient: 'kc-k7m2qp.3f9a1c0b@reply.example.test',
  secondRecipient: 'kc-zz9yy8.00aa11bb@reply.example.test',
  unknownRecipient: 'someone@unrelated.example.com',
  subject: 'Re: Privacy probe subject KC-K7M2QP',
  body: 'Body snippet canary-7f3e1d, please never log me.',
  messageId: '<CAF-probe-123@mail.example.com>',
  inReplyTo: '<ticket.0000-1111@reply.example.test>',
} as const;

export function buildMime(opts: {
  headers?: Record<string, string>;
  contentType?: string;
  body: string;
}): Buffer {
  const headers: Record<string, string> = {
    From: `${SAMPLE.fromName} <${SAMPLE.from}>`,
    To: SAMPLE.recipient,
    Subject: SAMPLE.subject,
    'Message-ID': SAMPLE.messageId,
    'In-Reply-To': SAMPLE.inReplyTo,
    References: SAMPLE.inReplyTo,
    'MIME-Version': '1.0',
    'Content-Type': opts.contentType ?? 'text/plain; charset=utf-8',
    ...opts.headers,
  };
  const head = Object.entries(headers)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
  return Buffer.from(`${head}\r\n\r\n${opts.body}`, 'utf8');
}

export function plainMail(body: string = SAMPLE.body, headers: Record<string, string> = {}): Buffer {
  return buildMime({ body, headers });
}

/**
 * The headers SES prepends to a received mail, in SES's order: Received-SPF,
 * Authentication-Results (one clause per entry), X-SES-RECEIPT.
 */
export function sesPrependedHeaders(opts: { results: string[]; authservId?: string }): string[] {
  const clauses = opts.results.map((result) => `\r\n ${result};`).join('');
  return [
    'Received-SPF: pass (spfCheck: domain of bounce.example.net designates 192.0.2.8 as permitted sender) client-ip=192.0.2.8;',
    `Authentication-Results: ${opts.authservId ?? 'amazonses.com'};${clauses}`,
    'X-SES-RECEIPT: AEFBQUFBQUFBQUFFeGFtcGxlUmVjZWlwdA==',
    'X-SES-DKIM-SIGNATURE: a=rsa-sha256; q=dns/txt; b=ZXhhbXBsZQ==',
  ];
}

/**
 * A received mail as SES stores it in S3: `prepended` raw header lines on
 * top (SES's block, or a forgery's), then the sender's own headers from
 * `buildMime` (`senderHeaders` are raw lines put first in the sender's block).
 */
export function receivedMail(opts: {
  prepended: string[];
  senderHeaders?: string[];
  headers?: Record<string, string>;
  body?: string;
}): Buffer {
  const top = [...opts.prepended, ...(opts.senderHeaders ?? [])].map((line) => `${line}\r\n`).join('');
  return Buffer.concat([Buffer.from(top, 'utf8'), buildMime({ body: opts.body ?? SAMPLE.body, headers: opts.headers })]);
}

export function htmlOnlyMail(html: string): Buffer {
  return buildMime({ contentType: 'text/html; charset=utf-8', body: html });
}

export function alternativeMail(opts: { text: string; html: string }): Buffer {
  const boundary = 'alt-boundary-42';
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.text,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    opts.html,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return buildMime({ contentType: `multipart/alternative; boundary="${boundary}"`, body });
}

export function receiptNotification(overrides: {
  recipients?: string[];
  messageId?: string;
  verdicts?: Record<string, string> | null;
} = {}): Record<string, unknown> {
  const verdicts = overrides.verdicts === undefined
    ? { spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS' }
    : overrides.verdicts;
  const receiptVerdicts = Object.fromEntries(
    Object.entries(verdicts ?? {}).map(([key, status]) => [`${key}Verdict`, { status }]),
  );
  return {
    notificationType: 'Received',
    mail: {
      timestamp: '2026-11-09T10:00:00.000Z',
      source: SAMPLE.from,
      messageId: overrides.messageId ?? 'ses-message-0001',
      destination: overrides.recipients ?? [SAMPLE.recipient],
      commonHeaders: {
        from: [`${SAMPLE.fromName} <${SAMPLE.from}>`],
        to: overrides.recipients ?? [SAMPLE.recipient],
        subject: SAMPLE.subject,
        messageId: SAMPLE.messageId,
      },
    },
    receipt: {
      timestamp: '2026-11-09T10:00:00.000Z',
      processingTimeMillis: 412,
      recipients: overrides.recipients ?? [SAMPLE.recipient],
      ...receiptVerdicts,
      action: {
        type: 'S3',
        topicArn: TOPIC_ARN,
        bucketName: 'example-pigeon-inbound',
        objectKeyPrefix: 'incoming/test/',
        objectKey: `incoming/test/${overrides.messageId ?? 'ses-message-0001'}`,
      },
    },
  };
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const SNS_PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const;
const CONFIRMATION_FIELDS = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] as const;

function stringToSign(envelope: Omit<SnsEnvelope, 'Signature'>): string {
  const fields = envelope.Type === 'Notification' ? NOTIFICATION_FIELDS : CONFIRMATION_FIELDS;
  const record = envelope as unknown as Record<string, unknown>;
  return fields
    .filter((key) => record[key] !== undefined && record[key] !== null)
    .map((key) => `${key}\n${String(record[key])}\n`)
    .join('');
}

export function signedEnvelope(opts: {
  type?: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  message: string;
  topicArn?: string;
  messageId?: string;
  subscribeUrl?: string;
}): SnsEnvelope {
  const type = opts.type ?? 'Notification';
  const unsigned: Omit<SnsEnvelope, 'Signature'> = {
    Type: type,
    MessageId: opts.messageId ?? 'sns-msg-0001',
    TopicArn: opts.topicArn ?? TOPIC_ARN,
    Message: opts.message,
    Timestamp: '2026-11-09T10:00:01.000Z',
    SigningCertURL: CERT_URL,
    SignatureVersion: '2',
    ...(type === 'Notification' ? {} : { Token: 'token-1', SubscribeURL: opts.subscribeUrl ?? 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=token-1' }),
  };
  const signer = createSign('RSA-SHA256');
  signer.update(stringToSign(unsigned), 'utf8');
  signer.end();
  return { ...unsigned, Signature: signer.sign(privateKey).toString('base64') };
}

export function notificationBody(notification: Record<string, unknown> = receiptNotification(), opts: { topicArn?: string; messageId?: string } = {}): string {
  return JSON.stringify(signedEnvelope({ message: JSON.stringify(notification), ...opts }));
}
