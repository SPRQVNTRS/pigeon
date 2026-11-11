/**
 * Parser for the SES receipt notification that an S3 receipt action publishes
 * to SNS (`notificationType: "Received"`). Pure: no I/O.
 *
 * Errors never quote the input. The notification holds addresses and the
 * subject (in `mail.commonHeaders`), and an error message ends up in a log.
 */

import { z } from 'zod';
import type { InboundVerdicts } from '#drizzle/schema/inbound';

export interface InboundReceipt {
  sesMessageId: string;
  receivedAt: Date;
  /** Envelope recipients the receipt rule matched, as SES wrote them. */
  recipients: string[];
  verdicts: InboundVerdicts;
  s3: { bucket: string; key: string };
}

export class InvalidInboundNotificationError extends Error {
  constructor(reason: string) {
    super(`Invalid SES receipt notification: ${reason}`);
    this.name = 'InvalidInboundNotificationError';
  }
}

const verdictSchema = z.object({ status: z.string().min(1) }).optional();

const receiptNotificationSchema = z.object({
  notificationType: z.literal('Received'),
  mail: z.object({
    messageId: z.string().min(1),
    timestamp: z.string().min(1),
  }),
  receipt: z.object({
    recipients: z.array(z.string()).min(1),
    spfVerdict: verdictSchema,
    dkimVerdict: verdictSchema,
    spamVerdict: verdictSchema,
    virusVerdict: verdictSchema,
    dmarcVerdict: verdictSchema,
    action: z.object({
      type: z.literal('S3'),
      bucketName: z.string().min(1),
      objectKey: z.string().min(1),
    }),
  }),
});

type ReceiptNotification = z.infer<typeof receiptNotificationSchema>;

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
}

function readVerdicts(receipt: ReceiptNotification['receipt']): InboundVerdicts {
  const entries: Array<[keyof InboundVerdicts, string | undefined]> = [
    ['spf', receipt.spfVerdict?.status],
    ['dkim', receipt.dkimVerdict?.status],
    ['spam', receipt.spamVerdict?.status],
    ['virus', receipt.virusVerdict?.status],
    ['dmarc', receipt.dmarcVerdict?.status],
  ];
  const verdicts: InboundVerdicts = {};
  for (const [key, status] of entries) {
    if (status !== undefined) verdicts[key] = status;
  }
  return verdicts;
}

/**
 * Parse the SNS `Message` string of an inbound notification.
 *
 * @throws InvalidInboundNotificationError when the message is not JSON or not
 *   an SES S3-action receipt notification. The reason names fields, never values.
 */
export function parseInboundNotification(message: string): InboundReceipt {
  let json: unknown;
  try {
    json = JSON.parse(message);
  } catch {
    throw new InvalidInboundNotificationError('message is not JSON');
  }

  const parsed = receiptNotificationSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidInboundNotificationError(`bad fields: ${describeIssues(parsed.error)}`);
  }

  const { mail, receipt } = parsed.data;
  const receivedAt = new Date(mail.timestamp);
  if (Number.isNaN(receivedAt.getTime())) {
    throw new InvalidInboundNotificationError('bad fields: mail.timestamp');
  }

  return {
    sesMessageId: mail.messageId,
    receivedAt,
    recipients: receipt.recipients,
    verdicts: readVerdicts(receipt),
    s3: { bucket: receipt.action.bucketName, key: receipt.action.objectKey },
  };
}
