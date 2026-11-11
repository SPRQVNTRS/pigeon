/**
 * Pure building blocks of scripts/aws-inbound.ts: resource names, the plan
 * text, the receipt rule, the bucket policy, the lifecycle rule, the topic
 * policy and the DNS records. No AWS calls here, so the tests can pin them.
 */

import type { ReceiptRule } from '@aws-sdk/client-ses';
import { INBOUND_S3_EXPIRATION_DAYS } from '../../app/lib/inbound/retention-limits.js';

export const INBOUND_INCOMING_PREFIX = 'incoming/';

/** Where SNS posts inbound mail notifications: the service's public URL plus its fixed route. */
export function inboundWebhookUrl(publicUrl: string): string {
  return `${publicUrl}/v1/webhooks/inbound`;
}

export function inboundTopicName(stage: string): string {
  return `pigeon-inbound-${stage}`;
}

export function inboundTopicArn(opts: { region: string; accountId: string; stage: string }): string {
  return `arn:aws:sns:${opts.region}:${opts.accountId}:${inboundTopicName(opts.stage)}`;
}

/** `pigeon-inbound-<domain with dots as dashes>-<stage>`. */
export function inboundReceiptRuleName(opts: { domain: string; stage: string }): string {
  return `pigeon-inbound-${opts.domain.replace(/\./g, '-')}-${opts.stage}`;
}

export function inboundObjectKeyPrefix(stage: string): string {
  return `${INBOUND_INCOMING_PREFIX}${stage}/`;
}

/** A hostname such as reply.example.com, lower case. Throws otherwise. */
export function normaliseDomainArg(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/\.$/, '');
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  const labels = name.split('.');
  const isValid = labels.length >= 2 && labels.every((part) => label.test(part)) && name.length <= 253;
  if (!isValid) throw new Error(`--domain must be a hostname such as reply.example.com, got "${raw}"`);
  return name;
}

export function buildInboundReceiptRule(opts: {
  domain: string;
  stage: string;
  bucketName: string;
  topicArn: string;
}): ReceiptRule {
  return {
    Name: inboundReceiptRuleName({ domain: opts.domain, stage: opts.stage }),
    Enabled: true,
    ScanEnabled: true,
    TlsPolicy: 'Optional',
    Recipients: [opts.domain],
    Actions: [
      {
        S3Action: {
          BucketName: opts.bucketName,
          ObjectKeyPrefix: inboundObjectKeyPrefix(opts.stage),
          TopicArn: opts.topicArn,
        },
      },
    ],
  };
}

export function buildInboundBucketPolicy(opts: { bucketName: string; accountId: string }): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowSESPutObject',
        Effect: 'Allow',
        Principal: { Service: 'ses.amazonaws.com' },
        Action: 's3:PutObject',
        Resource: `arn:aws:s3:::${opts.bucketName}/${INBOUND_INCOMING_PREFIX}*`,
        Condition: { StringEquals: { 'aws:SourceAccount': opts.accountId } },
      },
    ],
  });
}

export function buildInboundLifecycleRules(): Array<{
  ID: string;
  Status: 'Enabled';
  Filter: { Prefix: string };
  Expiration: { Days: number };
}> {
  return [
    {
      ID: 'expire-incoming',
      Status: 'Enabled',
      Filter: { Prefix: INBOUND_INCOMING_PREFIX },
      Expiration: { Days: INBOUND_S3_EXPIRATION_DAYS },
    },
  ];
}

/**
 * Topic policy: the account keeps its usual rights, and SES receipt rules of
 * this account may publish (an S3 action with a TopicArn publishes as SES).
 */
export function buildInboundTopicPolicy(opts: { topicArn: string; accountId: string; region: string }): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AccountOwner',
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${opts.accountId}:root` },
        Action: [
          'SNS:GetTopicAttributes',
          'SNS:SetTopicAttributes',
          'SNS:AddPermission',
          'SNS:RemovePermission',
          'SNS:DeleteTopic',
          'SNS:Subscribe',
          'SNS:ListSubscriptionsByTopic',
          'SNS:Publish',
        ],
        Resource: opts.topicArn,
      },
      {
        Sid: 'AllowSESReceiptPublish',
        Effect: 'Allow',
        Principal: { Service: 'ses.amazonaws.com' },
        Action: 'SNS:Publish',
        Resource: opts.topicArn,
        Condition: {
          StringEquals: { 'aws:SourceAccount': opts.accountId },
          ArnLike: { 'aws:SourceArn': `arn:aws:ses:${opts.region}:${opts.accountId}:receipt-rule-set/*` },
        },
      },
    ],
  });
}

export interface DnsRecordLine {
  type: 'TXT' | 'MX';
  host: string;
  value: string;
}

export function buildInboundDnsRecords(opts: {
  domain: string;
  region: string;
  verificationToken: string | null;
}): DnsRecordLine[] {
  const records: DnsRecordLine[] = [
    { type: 'MX', host: opts.domain, value: `10 inbound-smtp.${opts.region}.amazonaws.com` },
    { type: 'TXT', host: opts.domain, value: '"v=spf1 -all"' },
  ];
  if (opts.verificationToken) {
    records.unshift({ type: 'TXT', host: `_amazonses.${opts.domain}`, value: `"${opts.verificationToken}"` });
  }
  return records;
}

export interface InboundPlanInputs {
  stage: string;
  /** S3 bucket for received mail. */
  inboundBucket: string;
  /** Public base URL of the service, no trailing slash. Read only when `subscribe` is set. */
  publicUrl: string | null;
  region: string;
  accountId: string;
  domains: readonly string[];
  subscribe: boolean;
  updateRuntimePolicy: boolean;
}

export function buildInboundPlan(inputs: InboundPlanInputs): string[] {
  const topicArn = inboundTopicArn(inputs);
  const lines = [
    `S3 bucket ${inputs.inboundBucket}: create if missing, block public access, ` +
      `expire ${INBOUND_INCOMING_PREFIX} after ${INBOUND_S3_EXPIRATION_DAYS} days, ` +
      `allow ses.amazonaws.com s3:PutObject on ${INBOUND_INCOMING_PREFIX}* (aws:SourceAccount ${inputs.accountId})`,
    `SNS topic ${inboundTopicName(inputs.stage)} (${topicArn}): create if missing, allow SES receipt rules to publish`,
  ];
  if (inputs.subscribe) {
    if (!inputs.publicUrl) throw new Error('The subscription step needs the public URL of the service');
    lines.push(`SNS subscription: HTTPS ${inboundWebhookUrl(inputs.publicUrl)} on ${inboundTopicName(inputs.stage)}, if missing`);
  }
  if (inputs.updateRuntimePolicy) {
    lines.push(
      `IAM policy pigeon-runtime-${inputs.stage}: new default version from RUNTIME_POLICY_DOC if it differs ` +
        '(deletes the oldest non-default version at the 5-version limit)',
    );
  }
  for (const domain of inputs.domains) {
    lines.push(
      `SES identity ${domain}: VerifyDomainIdentity if not registered (prints the DNS records)`,
      `SES receipt rule ${inboundReceiptRuleName({ domain, stage: inputs.stage })}: add to the ACTIVE rule set ` +
        `after its last rule, recipients [${domain}], scan on, TLS optional, ` +
        `S3 ${inputs.inboundBucket}/${inboundObjectKeyPrefix(inputs.stage)} + SNS ${inboundTopicName(inputs.stage)}`,
    );
  }
  return lines.map((line, index) => `  ${index + 1}. ${line}`);
}
