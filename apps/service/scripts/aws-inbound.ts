/**
 * aws-inbound.ts — AWS resources for inbound mail (SES receiving → S3 → SNS →
 * POST /v1/webhooks/inbound).
 *
 * DRY RUN BY DEFAULT: prints the plan and calls no AWS API. `--apply` acts.
 *
 *   pnpm --filter @sprqvntrs/pigeon-service setup:aws:inbound -- --domain reply.example.com
 *   pnpm --filter @sprqvntrs/pigeon-service setup:aws:inbound -- --domain reply.example.com --apply
 *
 * Flags:
 *   --stage <prod|staging|dev>   default prod
 *   --region <region>            default eu-central-1
 *   --domain <name>              repeatable; per-domain identity + receipt rule
 *   --subscribe                  subscribe $PIGEON_PUBLIC_URL/v1/webhooks/inbound
 *   --update-runtime-policy      new default version of pigeon-runtime-<stage>
 *   --account-id <id>            only for the dry-run plan text
 *   --apply                      act (otherwise dry run)
 *
 * Environment (no defaults; a missing one stops the script before any AWS call):
 *   PIGEON_INBOUND_BUCKET        S3 bucket for received mail (always)
 *   PIGEON_PUBLIC_URL            public https base URL of the service (with --subscribe)
 *   PIGEON_DMARC_BUCKET          DMARC report bucket, named in the runtime policy
 *                                (with --update-runtime-policy)
 *
 * Every step is idempotent. The receipt rule is ADDED to the currently
 * active rule set, after its last rule. The script never creates or
 * activates a rule set and never changes or reorders another rule. A rule
 * with our name that differs from the desired one is reported, not changed.
 */

import { parseArgs } from 'node:util';
import {
  CreateReceiptRuleCommand,
  DescribeActiveReceiptRuleSetCommand,
  GetIdentityVerificationAttributesCommand,
  VerifyDomainIdentityCommand,
  type ReceiptRule,
  type SESClient,
} from '@aws-sdk/client-ses';
import {
  CreateTopicCommand,
  ListSubscriptionsByTopicCommand,
  SetTopicAttributesCommand,
  SubscribeCommand,
  type SNSClient,
} from '@aws-sdk/client-sns';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
  type BucketLocationConstraint,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  CreatePolicyVersionCommand,
  DeletePolicyVersionCommand,
  GetPolicyVersionCommand,
  ListPolicyVersionsCommand,
  type IAMClient,
} from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { buildAdminClients } from './lib/aws-clients.js';
import { withoutLeadingSeparator } from './lib/argv.js';
import {
  buildInboundBucketPolicy,
  buildInboundDnsRecords,
  buildInboundLifecycleRules,
  buildInboundPlan,
  buildInboundReceiptRule,
  buildInboundTopicPolicy,
  inboundTopicName,
  inboundWebhookUrl,
  normaliseDomainArg,
} from './lib/inbound-plan.js';
import {
  runtimePolicyDocument,
  runtimePolicyName,
  type RuntimePolicyBuckets,
} from './lib/runtime-policy.js';
import { readScriptSettings, type SettingName, type SettingsEnv } from './lib/script-settings.js';

const STAGES = ['prod', 'staging', 'dev'] as const;
type Stage = (typeof STAGES)[number];

export interface InboundCliOptions {
  stage: Stage;
  region: string;
  domains: string[];
  subscribe: boolean;
  updateRuntimePolicy: boolean;
  accountId: string | null;
  apply: boolean;
}

export function parseInboundFlags(argv: readonly string[]): InboundCliOptions {
  const { values } = parseArgs({
    args: withoutLeadingSeparator(argv),
    options: {
      stage: { type: 'string', default: 'prod' },
      region: { type: 'string', default: 'eu-central-1' },
      domain: { type: 'string', multiple: true, default: [] },
      subscribe: { type: 'boolean', default: false },
      'update-runtime-policy': { type: 'boolean', default: false },
      'account-id': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const stage = values.stage as Stage;
  if (!STAGES.includes(stage)) throw new Error(`--stage must be one of ${STAGES.join(', ')}`);
  return {
    stage,
    region: values.region ?? 'eu-central-1',
    domains: [...new Set((values.domain ?? []).map(normaliseDomainArg))],
    subscribe: Boolean(values.subscribe),
    updateRuntimePolicy: Boolean(values['update-runtime-policy']),
    accountId: values['account-id'] ?? null,
    apply: Boolean(values.apply),
  };
}

/** The deployment values this run needs. `null` means the flags do not need it. */
export interface InboundSettings {
  inboundBucket: string;
  publicUrl: string | null;
  dmarcBucket: string | null;
}

/** Reads the settings the chosen flags need; throws, naming each missing variable. */
export function readInboundSettings(options: InboundCliOptions, env?: SettingsEnv): InboundSettings {
  const names: SettingName[] = ['inboundBucket'];
  if (options.subscribe) names.push('publicUrl');
  if (options.updateRuntimePolicy) names.push('dmarcBucket');
  // Only the requested names are present, so the others are read through the flags.
  const values = readScriptSettings(names, env);
  return {
    inboundBucket: values.inboundBucket,
    publicUrl: options.subscribe ? values.publicUrl : null,
    dmarcBucket: options.updateRuntimePolicy ? values.dmarcBucket : null,
  };
}

function requireSetting(value: string | null, flag: string): string {
  if (!value) throw new Error(`${flag} needs a setting that was not read; call readInboundSettings with the same options`);
  return value;
}

export type StepResult = 'created' | 'reused' | 'updated' | 'drift';

export interface Reporter {
  (line: string): void;
}

// ── Global resources ─────────────────────────────────────────────────────────

function isNotFound(err: unknown): boolean {
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const name = (err as { name?: string }).name;
  return status === 404 || name === 'NoSuchBucket' || name === 'NotFound';
}

export async function ensureInboundBucket(opts: {
  s3: S3Client;
  region: string;
  accountId: string;
  bucketName: string;
}): Promise<StepResult> {
  const { s3, region, accountId, bucketName } = opts;
  let isExisting = true;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    isExisting = false;
  }

  if (!isExisting) {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucketName,
        CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint },
      }),
    );
  }

  // Always (re)applied; each call is idempotent.
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucketName,
      LifecycleConfiguration: { Rules: buildInboundLifecycleRules() },
    }),
  );
  await s3.send(
    new PutBucketPolicyCommand({ Bucket: bucketName, Policy: buildInboundBucketPolicy({ bucketName, accountId }) }),
  );
  return isExisting ? 'reused' : 'created';
}

export async function ensureInboundTopic(opts: {
  sns: SNSClient;
  stage: string;
  region: string;
  accountId: string;
}): Promise<string> {
  const { sns, stage, region, accountId } = opts;
  // CreateTopic returns the existing ARN when the topic exists.
  const res = await sns.send(new CreateTopicCommand({ Name: inboundTopicName(stage) }));
  if (!res.TopicArn) throw new Error('sns:CreateTopic returned no ARN');
  await sns.send(
    new SetTopicAttributesCommand({
      TopicArn: res.TopicArn,
      AttributeName: 'Policy',
      AttributeValue: buildInboundTopicPolicy({ topicArn: res.TopicArn, accountId, region }),
    }),
  );
  return res.TopicArn;
}

export async function ensureInboundSubscription(opts: {
  sns: SNSClient;
  topicArn: string;
  endpoint: string;
}): Promise<StepResult> {
  const { sns, topicArn, endpoint } = opts;
  const list = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
  const existing = (list.Subscriptions ?? []).find((s) => s.Protocol === 'https' && s.Endpoint === endpoint);
  if (existing) return 'reused';
  await sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: 'https', Endpoint: endpoint }));
  return 'created';
}

const MAX_POLICY_VERSIONS = 5;

export async function updateRuntimePolicy(opts: {
  iam: IAMClient;
  accountId: string;
  stage: string;
  buckets: RuntimePolicyBuckets;
}): Promise<StepResult> {
  const { iam } = opts;
  const policyArn = `arn:aws:iam::${opts.accountId}:policy/${runtimePolicyName(opts.stage)}`;
  const versions = (await iam.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn }))).Versions ?? [];
  const current = versions.find((v) => v.IsDefaultVersion);
  if (!current?.VersionId) throw new Error(`No default version for ${policyArn}`);

  const live = await iam.send(new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: current.VersionId }));
  const rawDocument = live.PolicyVersion?.Document;
  if (!rawDocument) throw new Error(`Could not read ${policyArn} ${current.VersionId}`);
  const desired = runtimePolicyDocument(opts.buckets);
  if (JSON.stringify(JSON.parse(decodeURIComponent(rawDocument))) === desired) return 'reused';

  if (versions.length >= MAX_POLICY_VERSIONS) {
    const oldest = versions
      .filter((v) => !v.IsDefaultVersion)
      .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0))[0];
    if (!oldest?.VersionId) throw new Error(`No non-default version of ${policyArn} to delete at the limit`);
    await iam.send(new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: oldest.VersionId }));
  }
  await iam.send(new CreatePolicyVersionCommand({ PolicyArn: policyArn, PolicyDocument: desired, SetAsDefault: true }));
  return 'updated';
}

// ── Per-domain resources ─────────────────────────────────────────────────────

/** Returns the verification token (existing or new). */
export async function ensureDomainIdentity(opts: { sesV1: SESClient; domain: string }): Promise<{
  result: StepResult;
  verificationToken: string | null;
}> {
  const { sesV1, domain } = opts;
  const attrs = await sesV1.send(new GetIdentityVerificationAttributesCommand({ Identities: [domain] }));
  const existing = attrs.VerificationAttributes?.[domain];
  if (existing) return { result: 'reused', verificationToken: existing.VerificationToken ?? null };

  const res = await sesV1.send(new VerifyDomainIdentityCommand({ Domain: domain }));
  return { result: 'created', verificationToken: res.VerificationToken ?? null };
}

function sameRule(live: ReceiptRule, desired: ReceiptRule): boolean {
  const pick = (rule: ReceiptRule) =>
    JSON.stringify({
      Enabled: rule.Enabled,
      ScanEnabled: rule.ScanEnabled,
      TlsPolicy: rule.TlsPolicy,
      Recipients: rule.Recipients,
      Actions: rule.Actions,
    });
  return pick(live) === pick(desired);
}

export async function ensureInboundReceiptRule(opts: {
  sesV1: SESClient;
  rule: ReceiptRule;
}): Promise<{ result: StepResult; ruleSetName: string }> {
  const { sesV1, rule } = opts;
  const active = await sesV1.send(new DescribeActiveReceiptRuleSetCommand({}));
  const ruleSetName = active.Metadata?.Name;
  if (!ruleSetName) {
    throw new Error(
      'No active SES receipt rule set in this region. This script never creates or activates one; ' +
        'set one up first (scripts/aws-setup.ts provisions pigeon-receive-rules).',
    );
  }

  const rules = active.Rules ?? [];
  const existing = rules.find((r) => r.Name === rule.Name);
  if (existing) return { result: sameRule(existing, rule) ? 'reused' : 'drift', ruleSetName };

  const lastRuleName = rules.at(-1)?.Name;
  await sesV1.send(
    new CreateReceiptRuleCommand({
      RuleSetName: ruleSetName,
      ...(lastRuleName ? { After: lastRuleName } : {}),
      Rule: rule,
    }),
  );
  return { result: 'created', ruleSetName };
}

// ── Main ─────────────────────────────────────────────────────────────────────

export interface InboundClients {
  s3: S3Client;
  sns: SNSClient;
  sesV1: SESClient;
  iam: IAMClient;
  resolveAccountId: () => Promise<string>;
}

export async function runInbound(opts: {
  options: InboundCliOptions;
  clients?: InboundClients;
  report?: Reporter;
  /** Defaults to the environment. Read before the plan prints and before any AWS call. */
  settings?: InboundSettings;
}): Promise<number> {
  const { options } = opts;
  const settings = opts.settings ?? readInboundSettings(options);
  const report = opts.report ?? ((line: string) => console.log(line));

  report(`aws-inbound — region=${options.region} stage=${options.stage} ${options.apply ? 'APPLY' : 'DRY RUN'}`);
  report('Plan:');
  for (const line of buildInboundPlan({
    stage: options.stage,
    region: options.region,
    accountId: options.accountId ?? '<account>',
    inboundBucket: settings.inboundBucket,
    publicUrl: settings.publicUrl,
    domains: options.domains,
    subscribe: options.subscribe,
    updateRuntimePolicy: options.updateRuntimePolicy,
  })) {
    report(line);
  }

  if (!options.apply) {
    report('\nDry run: no AWS call was made. Re-run with --apply to act.');
    return 0;
  }

  const clients = opts.clients ?? buildInboundClients(options.region);
  const accountId = await clients.resolveAccountId();
  report(`\nAccount: ${accountId}`);

  const bucketResult = await ensureInboundBucket({
    s3: clients.s3,
    region: options.region,
    accountId,
    bucketName: settings.inboundBucket,
  });
  report(`  S3 bucket ${settings.inboundBucket}: ${bucketResult}`);
  const topicArn = await ensureInboundTopic({ sns: clients.sns, stage: options.stage, region: options.region, accountId });
  report(`  SNS topic: ${topicArn}`);
  report(`  Set INBOUND_SNS_TOPIC_ARN=${topicArn} on the pigeon service.`);

  if (options.subscribe) {
    const endpoint = inboundWebhookUrl(requireSetting(settings.publicUrl, '--subscribe'));
    report(`  SNS subscription ${endpoint}: ${await ensureInboundSubscription({ sns: clients.sns, topicArn, endpoint })}`);
  }
  if (options.updateRuntimePolicy) {
    const buckets = {
      dmarcBucket: requireSetting(settings.dmarcBucket, '--update-runtime-policy'),
      inboundBucket: settings.inboundBucket,
    };
    report(`  IAM ${runtimePolicyName(options.stage)}: ${await updateRuntimePolicy({ iam: clients.iam, accountId, stage: options.stage, buckets })}`);
  }

  let hasDrift = false;
  for (const domain of options.domains) {
    const identity = await ensureDomainIdentity({ sesV1: clients.sesV1, domain });
    report(`  SES identity ${domain}: ${identity.result}`);
    const rule = buildInboundReceiptRule({ domain, stage: options.stage, bucketName: settings.inboundBucket, topicArn });
    const ruleResult = await ensureInboundReceiptRule({ sesV1: clients.sesV1, rule });
    report(`  SES receipt rule ${rule.Name} in ${ruleResult.ruleSetName}: ${ruleResult.result}`);
    if (ruleResult.result === 'drift') {
      hasDrift = true;
      report('    The live rule differs from the desired one. Not changed; fix it by hand in the SES console.');
    }
    report(`  DNS for ${domain} (publish in Cloudflare, proxied off):`);
    for (const record of buildInboundDnsRecords({ domain, region: options.region, verificationToken: identity.verificationToken })) {
      report(`    ${record.type} ${record.host} ${record.value}`);
    }
  }

  return hasDrift ? 2 : 0;
}

function buildInboundClients(region: string): InboundClients {
  const clients = buildAdminClients(region);
  return {
    s3: clients.s3,
    sns: clients.sns,
    sesV1: clients.sesV1,
    iam: clients.iam,
    resolveAccountId: async () => {
      const identity = await clients.sts.send(new GetCallerIdentityCommand({}));
      if (!identity.Account) throw new Error('sts:GetCallerIdentity returned no account');
      return identity.Account;
    },
  };
}

// Only run when invoked as a script (not when imported by tests).
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  runInbound({ options: parseInboundFlags(process.argv.slice(2)) }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
