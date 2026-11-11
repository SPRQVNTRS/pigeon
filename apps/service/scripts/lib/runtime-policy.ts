/**
 * Runtime IAM policy attached to the service's IAM user.
 *
 * Shared between setup (create+attach) and teardown (detach+delete) so that
 * teardown knows exactly which policy the runtime user carries. The shape
 * grows only when the service starts calling a new AWS action. Do NOT add SNS perms here; the service *receives* SNS HTTPS POSTs
 * and never calls into SNS itself.
 *
 * EraseSuppression exists because the recipient erase route
 * (POST /v1/recipients/erase, app/lib/recipient-erase.ts) calls SESv2
 * DeleteSuppressedDestination. Without it production answered
 * AccessDeniedException. The same statement is live in pigeon-runtime-prod v3.
 *
 * ReadInboundMail lets the inbound.process worker read received mail that the
 * SES receipt rule stored (scripts/aws-inbound.ts), and lets the replay route
 * HeadObject it (HeadObject is authorised by s3:GetObject).
 *
 * DeleteInboundMail lets the recipient erase delete the raw mail a sender sent
 * to a tenant (app/lib/recipient-erase.ts, deleteS3Object in
 * app/lib/s3-client.ts). Without it the erase answers 500 and deletes nothing.
 * Same prefix as ReadInboundMail, nothing else in that bucket.
 *
 * Push this document to the live policy with
 * `setup:aws:inbound -- --update-runtime-policy --apply`.
 */

export interface RuntimePolicyBuckets {
  /** Bucket the SES receipt rule writes DMARC aggregate reports to. */
  dmarcBucket: string;
  /** Bucket the SES receipt rule writes received tenant mail to. */
  inboundBucket: string;
}

export function buildRuntimePolicyDoc(buckets: RuntimePolicyBuckets) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'SendMail',
        Effect: 'Allow',
        Action: ['ses:SendEmail', 'ses:SendRawEmail'],
        Resource: '*',
      },
      {
        Sid: 'ManageIdentities',
        Effect: 'Allow',
        Action: [
          'ses:CreateEmailIdentity',
          'ses:DeleteEmailIdentity',
          'ses:GetEmailIdentity',
          'ses:ListEmailIdentities',
          'ses:PutEmailIdentityDkimSigningAttributes',
        ],
        Resource: '*',
      },
      {
        Sid: 'EraseSuppression',
        Effect: 'Allow',
        Action: ['ses:DeleteSuppressedDestination'],
        Resource: '*',
      },
      {
        Sid: 'ReadDmarcReports',
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: `arn:aws:s3:::${buckets.dmarcBucket}/incoming/*`,
      },
      {
        Sid: 'ReadInboundMail',
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: `arn:aws:s3:::${buckets.inboundBucket}/incoming/*`,
      },
      {
        Sid: 'DeleteInboundMail',
        Effect: 'Allow',
        Action: ['s3:DeleteObject'],
        Resource: `arn:aws:s3:::${buckets.inboundBucket}/incoming/*`,
      },
    ],
  };
}

export type RuntimePolicyDoc = ReturnType<typeof buildRuntimePolicyDoc>;

export function runtimePolicyDocument(buckets: RuntimePolicyBuckets): string {
  return JSON.stringify(buildRuntimePolicyDoc(buckets));
}

export function runtimePolicyName(stage: string): string {
  return `pigeon-runtime-${stage}`;
}

export function runtimeUserName(stage: string): string {
  return `pigeon-${stage}`;
}

export function configurationSetName(prefix: string, stage: string): string {
  return `${prefix}-${stage}`;
}

export function snsTopicName(prefix: string, stage: string): string {
  return `${prefix}-events-${stage}`;
}

export function dmarcSnsTopicName(stage: string): string {
  return `pigeon-dmarc-ingest-${stage}`;
}

export function dmarcReceiptRuleName(stage: string): string {
  return `pigeon-dmarc-reports-${stage}`;
}

export function dmarcReceiptRuleSetName(): string {
  return 'pigeon-receive-rules';
}

/** Where SNS posts DMARC report notifications: the service's public URL plus its fixed route. */
export function dmarcWebhookUrl(publicUrl: string): string {
  return `${publicUrl}/v1/webhooks/dmarc`;
}
