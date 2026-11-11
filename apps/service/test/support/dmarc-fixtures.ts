/**
 * Fixtures for the DMARC ingest tests: an aggregate report XML, the raw mail
 * that carries it, the SES receipt notification an S3 receipt action
 * publishes, and signed SNS envelopes (the test RSA key from
 * inbound-fixtures stands in for the AWS cert).
 *
 * Invented addresses (example.com / example.test) and documentation IPs
 * (192.0.2.0/24) only.
 */

import { Readable } from 'node:stream';
import type { S3ObjectStream } from '#app/lib/s3-client';
import { signedEnvelope } from './inbound-fixtures';

export const DMARC_TOPIC_ARN = 'arn:aws:sns:eu-central-1:123456789012:pigeon-dmarc-ingest-test';
export const OTHER_DMARC_TOPIC_ARN = 'arn:aws:sns:eu-central-1:210987654321:pigeon-dmarc-ingest-test';
export const DMARC_BUCKET = 'example-dmarc-reports';
export const DMARC_RECIPIENT = 'dmarc@in.example.test';
export const REPORTER = 'noreply-dmarc-support@reporter.example.com';

export function dmarcReportXml(opts: { reportId?: string; policyDomain?: string } = {}): string {
  const reportId = opts.reportId ?? '17112233445566778899';
  const policyDomain = opts.policyDomain ?? 'example.org';
  return `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>reporter.example.com</org_name>
    <email>${REPORTER}</email>
    <report_id>${reportId}</report_id>
    <date_range>
      <begin>1762560000</begin>
      <end>1762646399</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>${policyDomain}</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>none</p>
    <sp>none</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>192.0.2.10</source_ip>
      <count>4</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>${policyDomain}</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>${policyDomain}</domain>
        <selector>pigeon</selector>
        <result>pass</result>
      </dkim>
      <spf>
        <domain>${policyDomain}</domain>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>192.0.2.20</source_ip>
      <count>1</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>${policyDomain}</header_from>
    </identifiers>
    <auth_results>
      <spf>
        <domain>mail.example.com</domain>
        <result>fail</result>
      </spf>
    </auth_results>
  </record>
</feedback>
`;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** A report mail as Google or Yahoo send it: multipart/mixed, base64 attachments. */
export function dmarcReportMail(attachments: readonly MailAttachment[]): Buffer {
  const boundary = '000000000000dmarc0boundary';
  const parts = attachments.map((attachment) =>
    [
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      (attachment.content.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n'),
    ].join('\r\n'),
  );
  const mail = [
    `From: ${REPORTER}`,
    `To: ${DMARC_RECIPIENT}`,
    'Subject: Report domain: example.org Submitter: reporter.example.com Report-ID: 17112233445566778899',
    'Date: Sun, 09 Nov 2026 01:02:03 +0000',
    'Message-ID: <dmarc-report-0001@reporter.example.com>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'This is an aggregate report from reporter.example.com.',
    ...parts,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Buffer.from(mail, 'utf8');
}

/**
 * The SES receipt notification an S3 action publishes to SNS, field for field
 * as SES writes it (see "Notification contents for Amazon SES email
 * receiving" in the SES developer guide).
 */
export function dmarcReceiptNotification(overrides: {
  messageId?: string;
  objectKey?: string;
  virus?: string;
} = {}): Record<string, unknown> {
  const messageId = overrides.messageId ?? 'o3vrnil0e2ic28trm7dfhrc2v0clambda4nbp0g1';
  return {
    notificationType: 'Received',
    mail: {
      timestamp: '2026-11-09T01:02:05.123Z',
      source: REPORTER,
      messageId,
      destination: [DMARC_RECIPIENT],
      headersTruncated: false,
      headers: [
        { name: 'Return-Path', value: `<${REPORTER}>` },
        { name: 'From', value: REPORTER },
        { name: 'To', value: DMARC_RECIPIENT },
        { name: 'Subject', value: 'Report domain: example.org Submitter: reporter.example.com' },
      ],
      commonHeaders: {
        returnPath: REPORTER,
        from: [REPORTER],
        date: 'Sun, 09 Nov 2026 01:02:03 +0000',
        to: [DMARC_RECIPIENT],
        messageId: '<dmarc-report-0001@reporter.example.com>',
        subject: 'Report domain: example.org Submitter: reporter.example.com',
      },
    },
    receipt: {
      timestamp: '2026-11-09T01:02:05.123Z',
      processingTimeMillis: 574,
      recipients: [DMARC_RECIPIENT],
      spamVerdict: { status: 'PASS' },
      virusVerdict: { status: overrides.virus ?? 'PASS' },
      spfVerdict: { status: 'PASS' },
      dkimVerdict: { status: 'PASS' },
      dmarcVerdict: { status: 'PASS' },
      action: {
        type: 'S3',
        topicArn: DMARC_TOPIC_ARN,
        bucketName: DMARC_BUCKET,
        objectKeyPrefix: 'incoming/test/',
        objectKey: overrides.objectKey ?? `incoming/test/${messageId}`,
      },
    },
  };
}

/** What SES publishes to a receipt-rule topic when the topic is first attached. */
export function sesSubscriptionSucceededNotice(): Record<string, unknown> {
  return {
    notificationType: 'AmazonSnsSubscriptionSucceeded',
    message: `You have successfully subscribed your Amazon SNS topic '${DMARC_TOPIC_ARN}' to receive 'Received' notifications from Amazon SES.`,
  };
}

export function dmarcNotificationBody(
  notification: Record<string, unknown> = dmarcReceiptNotification(),
  opts: { topicArn?: string; messageId?: string } = {},
): string {
  return JSON.stringify(
    signedEnvelope({
      message: JSON.stringify(notification),
      topicArn: opts.topicArn ?? DMARC_TOPIC_ARN,
      messageId: opts.messageId ?? 'sns-dmarc-0001',
    }),
  );
}

export function dmarcConfirmationBody(opts: { topicArn?: string } = {}): string {
  return JSON.stringify(
    signedEnvelope({
      type: 'SubscriptionConfirmation',
      message: 'You have chosen to subscribe to the topic.',
      topicArn: opts.topicArn ?? DMARC_TOPIC_ARN,
      subscribeUrl: 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=dmarc-token',
    }),
  );
}

/** An S3 object stream over a buffer; `contentLength` defaults to its length. */
export function objectStream(content: Buffer, opts: { contentLength?: number | null } = {}): S3ObjectStream {
  return {
    body: Readable.from([content]),
    contentLength: opts.contentLength === undefined ? content.length : opts.contentLength,
  };
}
