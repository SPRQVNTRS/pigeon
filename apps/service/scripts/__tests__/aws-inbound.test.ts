/**
 * aws-inbound.ts: the plan text, the receipt rule, and the apply flow against
 * aws-sdk-client-mock (no real AWS call). The rule must land in the ACTIVE
 * rule set after its last rule; the script never creates or activates a rule
 * set and never touches another rule.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SESClient,
  CreateReceiptRuleCommand,
  CreateReceiptRuleSetCommand,
  DescribeActiveReceiptRuleSetCommand,
  GetIdentityVerificationAttributesCommand,
  SetActiveReceiptRuleSetCommand,
  VerifyDomainIdentityCommand,
} from '@aws-sdk/client-ses';
import {
  SNSClient,
  CreateTopicCommand,
  ListSubscriptionsByTopicCommand,
  SetTopicAttributesCommand,
  SubscribeCommand,
} from '@aws-sdk/client-sns';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
} from '@aws-sdk/client-s3';
import { IAMClient, CreatePolicyVersionCommand, DeletePolicyVersionCommand, GetPolicyVersionCommand, ListPolicyVersionsCommand } from '@aws-sdk/client-iam';
import {
  buildInboundPlan,
  buildInboundReceiptRule,
  buildInboundBucketPolicy,
  inboundReceiptRuleName,
  normaliseDomainArg,
} from '../lib/inbound-plan';
import { parseInboundFlags, readInboundSettings, runInbound, updateRuntimePolicy } from '../aws-inbound';
import { runtimePolicyDocument } from '../lib/runtime-policy';

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT}:pigeon-inbound-prod`;
const DOMAIN = 'reply.example.test';
const INBOUND_BUCKET = 'example-pigeon-inbound';
const PUBLIC_URL = 'https://pigeon.example.com';
const INBOUND_WEBHOOK = `${PUBLIC_URL}/v1/webhooks/inbound`;
const BUCKETS = { dmarcBucket: 'example-dmarc-reports', inboundBucket: INBOUND_BUCKET };
const SETTINGS = { inboundBucket: INBOUND_BUCKET, publicUrl: PUBLIC_URL, dmarcBucket: BUCKETS.dmarcBucket };

const ses = mockClient(SESClient);
const sns = mockClient(SNSClient);
const s3 = mockClient(S3Client);
const iam = mockClient(IAMClient);

function clients() {
  return {
    sesV1: new SESClient({ region: REGION }),
    sns: new SNSClient({ region: REGION }),
    s3: new S3Client({ region: REGION }),
    iam: new IAMClient({ region: REGION }),
    resolveAccountId: async () => ACCOUNT,
  };
}

function options(overrides: Partial<ReturnType<typeof parseInboundFlags>> = {}) {
  return { ...parseInboundFlags(['--domain', DOMAIN]), apply: true, ...overrides };
}

beforeEach(() => {
  ses.reset();
  sns.reset();
  s3.reset();
  iam.reset();
  s3.on(HeadBucketCommand).resolves({});
  sns.on(CreateTopicCommand).resolves({ TopicArn: TOPIC_ARN });
  sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [] });
  ses.on(GetIdentityVerificationAttributesCommand).resolves({ VerificationAttributes: {} });
  ses.on(VerifyDomainIdentityCommand).resolves({ VerificationToken: 'tok-123' });
  ses.on(DescribeActiveReceiptRuleSetCommand).resolves({
    Metadata: { Name: 'pigeon-receive-rules' },
    Rules: [{ Name: 'pigeon-dmarc-reports-prod' }, { Name: 'someone-elses-rule' }],
  });
});

describe('plan and rule', () => {
  it('names the rule after the domain and stage', () => {
    expect(inboundReceiptRuleName({ domain: 'reply.example.com', stage: 'prod' })).toBe('pigeon-inbound-reply-example-com-prod');
  });

  it('builds the receipt rule exactly', () => {
    expect(buildInboundReceiptRule({ domain: DOMAIN, stage: 'prod', bucketName: INBOUND_BUCKET, topicArn: TOPIC_ARN })).toEqual({
      Name: 'pigeon-inbound-reply-example-test-prod',
      Enabled: true,
      ScanEnabled: true,
      TlsPolicy: 'Optional',
      Recipients: [DOMAIN],
      Actions: [{ S3Action: { BucketName: INBOUND_BUCKET, ObjectKeyPrefix: 'incoming/prod/', TopicArn: TOPIC_ARN } }],
    });
  });

  it('bucket policy lets only SES of this account write incoming/*', () => {
    const policy = JSON.parse(buildInboundBucketPolicy({ bucketName: INBOUND_BUCKET, accountId: ACCOUNT }));
    expect(policy.Statement).toEqual([
      {
        Sid: 'AllowSESPutObject',
        Effect: 'Allow',
        Principal: { Service: 'ses.amazonaws.com' },
        Action: 's3:PutObject',
        Resource: `arn:aws:s3:::${INBOUND_BUCKET}/incoming/*`,
        Condition: { StringEquals: { 'aws:SourceAccount': ACCOUNT } },
      },
    ]);
  });

  it('prints a plan that names every resource', () => {
    const plan = buildInboundPlan({ stage: 'prod', region: REGION, accountId: ACCOUNT, inboundBucket: INBOUND_BUCKET, publicUrl: PUBLIC_URL, domains: [DOMAIN], subscribe: true, updateRuntimePolicy: true }).join('\n');
    expect(plan).toContain(`S3 bucket ${INBOUND_BUCKET}:`);
    expect(plan).toContain('expire incoming/ after 6 days');
    expect(plan).toContain(`SNS topic pigeon-inbound-prod (${TOPIC_ARN})`);
    expect(plan).toContain(INBOUND_WEBHOOK);
    expect(plan).toContain('IAM policy pigeon-runtime-prod');
    expect(plan).toContain('SES receipt rule pigeon-inbound-reply-example-test-prod: add to the ACTIVE rule set after its last rule');
  });

  it('parses flags: dry run by default, domains lower case, repeatable', () => {
    const flags = parseInboundFlags(['--domain', 'Reply.Example.TEST', '--domain', 'b.example.test']);
    expect(flags).toMatchObject({ apply: false, stage: 'prod', region: 'eu-central-1', domains: ['reply.example.test', 'b.example.test'] });
    expect(() => normaliseDomainArg('not a domain')).toThrow();
    expect(() => parseInboundFlags(['--stage', 'qa'])).toThrow();
  });

  it('parses the same flags with and without the leading -- that pnpm forwards', () => {
    const args = ['--domain', 'reply.example.test', '--update-runtime-policy', '--apply'];
    const expected = { domains: ['reply.example.test'], updateRuntimePolicy: true, apply: true };
    expect(parseInboundFlags(args)).toMatchObject(expected);
    expect(parseInboundFlags(['--', ...args])).toMatchObject(expected);
    expect(() => parseInboundFlags(['--', '--', '--apply'])).toThrow();
  });
});

describe('runInbound', () => {
  it('dry run makes no AWS call', async () => {
    const lines: string[] = [];
    const code = await runInbound({ options: options({ apply: false }), clients: clients(), settings: SETTINGS, report: (l) => lines.push(l) });
    expect(code).toBe(0);
    for (const mock of [ses, sns, s3, iam]) expect(mock.calls()).toHaveLength(0);
    expect(lines.join('\n')).toContain('Dry run: no AWS call was made');
  });

  it('apply adds the rule after the last rule of the active set and prints the DNS records', async () => {
    const lines: string[] = [];
    const code = await runInbound({ options: options(), clients: clients(), settings: SETTINGS, report: (l) => lines.push(l) });
    expect(code).toBe(0);

    const created = ses.commandCalls(CreateReceiptRuleCommand);
    expect(created).toHaveLength(1);
    expect(created[0]!.args[0].input).toMatchObject({ RuleSetName: 'pigeon-receive-rules', After: 'someone-elses-rule' });
    expect(created[0]!.args[0].input.Rule?.Name).toBe('pigeon-inbound-reply-example-test-prod');

    // Allow-list: SES sees only these calls, so no rule set is created or
    // activated and no other rule is updated, reordered or deleted.
    const sesCalls = new Set(ses.calls().map((call) => call.args[0].constructor.name));
    expect([...sesCalls].sort()).toEqual(
      ['CreateReceiptRuleCommand', 'DescribeActiveReceiptRuleSetCommand', 'GetIdentityVerificationAttributesCommand', 'VerifyDomainIdentityCommand'].sort(),
    );

    expect(s3.commandCalls(CreateBucketCommand)).toHaveLength(0);
    expect(s3.commandCalls(PutPublicAccessBlockCommand)).toHaveLength(1);
    expect(s3.commandCalls(PutBucketPolicyCommand)).toHaveLength(1);
    expect(s3.commandCalls(PutBucketLifecycleConfigurationCommand)[0]!.args[0].input.LifecycleConfiguration?.Rules?.[0]?.Expiration?.Days).toBe(6);
    expect(sns.commandCalls(SetTopicAttributesCommand)).toHaveLength(1);
    expect(sns.commandCalls(SubscribeCommand)).toHaveLength(0);

    const out = lines.join('\n');
    expect(out).toContain(`TXT _amazonses.${DOMAIN} "tok-123"`);
    expect(out).toContain(`MX ${DOMAIN} 10 inbound-smtp.${REGION}.amazonaws.com`);
    expect(out).toContain(`TXT ${DOMAIN} "v=spf1 -all"`);
  });

  it('is idempotent: an existing rule, identity, bucket and subscription are reused', async () => {
    const rule = buildInboundReceiptRule({ domain: DOMAIN, stage: 'prod', bucketName: INBOUND_BUCKET, topicArn: TOPIC_ARN });
    ses.on(DescribeActiveReceiptRuleSetCommand).resolves({ Metadata: { Name: 'pigeon-receive-rules' }, Rules: [{ Name: 'pigeon-dmarc-reports-prod' }, rule] });
    ses.on(GetIdentityVerificationAttributesCommand).resolves({ VerificationAttributes: { [DOMAIN]: { VerificationStatus: 'Success', VerificationToken: 'tok-old' } } });
    sns.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [{ Protocol: 'https', Endpoint: INBOUND_WEBHOOK, SubscriptionArn: 'arn:sub' }] });

    const code = await runInbound({ options: options({ subscribe: true }), clients: clients(), settings: SETTINGS, report: () => undefined });
    expect(code).toBe(0);
    expect(ses.commandCalls(CreateReceiptRuleCommand)).toHaveLength(0);
    expect(ses.commandCalls(VerifyDomainIdentityCommand)).toHaveLength(0);
    expect(sns.commandCalls(SubscribeCommand)).toHaveLength(0);
  });

  it('reports a drifted rule with exit code 2 and changes nothing', async () => {
    const rule = { ...buildInboundReceiptRule({ domain: DOMAIN, stage: 'prod', bucketName: INBOUND_BUCKET, topicArn: TOPIC_ARN }), ScanEnabled: false };
    ses.on(DescribeActiveReceiptRuleSetCommand).resolves({ Metadata: { Name: 'pigeon-receive-rules' }, Rules: [rule] });
    const code = await runInbound({ options: options(), clients: clients(), settings: SETTINGS, report: () => undefined });
    expect(code).toBe(2);
    expect(ses.commandCalls(CreateReceiptRuleCommand)).toHaveLength(0);
  });

  it('refuses to run without an active rule set and never creates one', async () => {
    ses.on(DescribeActiveReceiptRuleSetCommand).resolves({});
    await expect(runInbound({ options: options(), clients: clients(), settings: SETTINGS, report: () => undefined })).rejects.toThrow(/No active SES receipt rule set/);
    expect(ses.commandCalls(CreateReceiptRuleSetCommand)).toHaveLength(0);
    expect(ses.commandCalls(SetActiveReceiptRuleSetCommand)).toHaveLength(0);
  });

  it('creates the bucket when HeadBucket says 404, and subscribes when asked', async () => {
    s3.on(HeadBucketCommand).rejects(Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    await runInbound({ options: options({ subscribe: true }), clients: clients(), settings: SETTINGS, report: () => undefined });
    expect(s3.commandCalls(CreateBucketCommand)[0]!.args[0].input).toMatchObject({ Bucket: INBOUND_BUCKET, CreateBucketConfiguration: { LocationConstraint: REGION } });
    expect(sns.commandCalls(SubscribeCommand)[0]!.args[0].input).toMatchObject({ Protocol: 'https', Endpoint: INBOUND_WEBHOOK });
  });
});

describe('readInboundSettings', () => {
  const ENV = {
    PIGEON_INBOUND_BUCKET: INBOUND_BUCKET,
    PIGEON_PUBLIC_URL: `${PUBLIC_URL}/`,
    PIGEON_DMARC_BUCKET: BUCKETS.dmarcBucket,
  };

  it('asks only for what the flags need', () => {
    expect(readInboundSettings(options(), { PIGEON_INBOUND_BUCKET: INBOUND_BUCKET })).toEqual({
      inboundBucket: INBOUND_BUCKET,
      publicUrl: null,
      dmarcBucket: null,
    });
  });

  it('reads the public URL without its trailing slash and the DMARC bucket when the policy is updated', () => {
    expect(readInboundSettings(options({ subscribe: true, updateRuntimePolicy: true }), ENV)).toEqual(SETTINGS);
  });

  it('names every missing variable', () => {
    const run = () => readInboundSettings(options({ subscribe: true, updateRuntimePolicy: true }), {});
    expect(run).toThrow(/PIGEON_INBOUND_BUCKET/);
    expect(run).toThrow(/PIGEON_PUBLIC_URL/);
    expect(run).toThrow(/PIGEON_DMARC_BUCKET/);
  });

  it('stops before the plan prints and before any AWS call when a setting is missing', async () => {
    const saved = process.env['PIGEON_INBOUND_BUCKET'];
    delete process.env['PIGEON_INBOUND_BUCKET'];
    const lines: string[] = [];
    try {
      await expect(runInbound({ options: options(), clients: clients(), report: (l) => lines.push(l) })).rejects.toThrow(/PIGEON_INBOUND_BUCKET/);
    } finally {
      if (saved !== undefined) process.env['PIGEON_INBOUND_BUCKET'] = saved;
    }
    expect(lines).toEqual([]);
    for (const mock of [ses, sns, s3, iam]) expect(mock.calls()).toHaveLength(0);
  });
});

describe('updateRuntimePolicy', () => {
  const POLICY_ARN = `arn:aws:iam::${ACCOUNT}:policy/pigeon-runtime-prod`;
  const old = encodeURIComponent(JSON.stringify({ Version: '2012-10-17', Statement: [] }));

  it('reuses an identical default version', async () => {
    iam.on(ListPolicyVersionsCommand).resolves({ Versions: [{ VersionId: 'v3', IsDefaultVersion: true }] });
    iam.on(GetPolicyVersionCommand).resolves({ PolicyVersion: { Document: encodeURIComponent(runtimePolicyDocument(BUCKETS)) } });
    expect(await updateRuntimePolicy({ iam: new IAMClient({}), accountId: ACCOUNT, stage: 'prod', buckets: BUCKETS })).toBe('reused');
    expect(iam.commandCalls(CreatePolicyVersionCommand)).toHaveLength(0);
  });

  it('deletes the oldest non-default version at the 5-version limit, then sets the new default', async () => {
    iam.on(ListPolicyVersionsCommand).resolves({
      Versions: [
        { VersionId: 'v5', IsDefaultVersion: true, CreateDate: new Date('2026-05-01') },
        { VersionId: 'v4', IsDefaultVersion: false, CreateDate: new Date('2026-04-01') },
        { VersionId: 'v1', IsDefaultVersion: false, CreateDate: new Date('2026-01-01') },
        { VersionId: 'v3', IsDefaultVersion: false, CreateDate: new Date('2026-03-01') },
        { VersionId: 'v2', IsDefaultVersion: false, CreateDate: new Date('2026-02-01') },
      ],
    });
    iam.on(GetPolicyVersionCommand).resolves({ PolicyVersion: { Document: old } });
    expect(await updateRuntimePolicy({ iam: new IAMClient({}), accountId: ACCOUNT, stage: 'prod', buckets: BUCKETS })).toBe('updated');
    expect(iam.commandCalls(DeletePolicyVersionCommand)[0]!.args[0].input).toEqual({ PolicyArn: POLICY_ARN, VersionId: 'v1' });
    expect(iam.commandCalls(CreatePolicyVersionCommand)[0]!.args[0].input).toEqual({
      PolicyArn: POLICY_ARN,
      PolicyDocument: runtimePolicyDocument(BUCKETS),
      SetAsDefault: true,
    });
  });
});
