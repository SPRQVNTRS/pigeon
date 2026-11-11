/**
 * aws-setup.ts — Idempotent AWS bootstrap for the email service.
 *
 * See `apps/service/scripts/README.md` for operator docs.
 *
 * Run with:  pnpm --filter @sprqvntrs/pigeon setup:aws
 *
 * Bootstrap, not reconciliation — every step is create-if-missing. If a live
 * resource exists with drift (e.g. event destinations point at a different
 * topic), we abort with a remediation hint rather than silently overwrite.
 */

import { parseArgs } from 'node:util';
import path from 'node:path';
import { z } from 'zod';
import {
  CreateAccessKeyCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  CreateUserCommand,
  DeletePolicyVersionCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetUserCommand,
  AttachUserPolicyCommand,
  ListAttachedUserPoliciesCommand,
  ListPolicyVersionsCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import {
  SESClient,
  ListIdentitiesCommand,
  VerifyDomainIdentityCommand,
  ListReceiptRuleSetsCommand,
  CreateReceiptRuleSetCommand,
  SetActiveReceiptRuleSetCommand,
  DescribeReceiptRuleCommand,
  CreateReceiptRuleCommand,
} from '@aws-sdk/client-ses';
import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateEmailIdentityCommand,
  GetConfigurationSetCommand,
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  NotFoundException as SesNotFoundException,
} from '@aws-sdk/client-sesv2';
import {
  CreateTopicCommand,
  ListSubscriptionsByTopicCommand,
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
import { buildAdminClients } from './lib/aws-clients.js';
import { withoutLeadingSeparator } from './lib/argv.js';
import { runPreflight } from './lib/preflight.js';
import { buildPlan, renderPlan } from './lib/plan.js';
import {
  configurationSetName,
  dmarcReceiptRuleName,
  dmarcReceiptRuleSetName,
  dmarcSnsTopicName,
  dmarcWebhookUrl,
  runtimePolicyName,
  runtimeUserName,
  runtimePolicyDocument,
  snsTopicName,
} from './lib/runtime-policy.js';
import { readScriptSettings } from './lib/script-settings.js';
import {
  emptyStateFile,
  readState,
  recordOperation,
  stateFilePath,
  writeStateAtomic,
  type StateFile,
} from './lib/state.js';

const EVENT_TYPES = ['BOUNCE', 'COMPLAINT', 'DELIVERY', 'REJECT'] as const;
type EventType = (typeof EVENT_TYPES)[number];

const EnvSchema = z.object({
  AWS_REGION: z.string().min(1, 'AWS_REGION is required'),
  STAGE: z.enum(['dev', 'staging', 'prod']),
  WEBHOOK_ENDPOINT_URL: z.string().url().optional(),
  SES_VERIFY_IDENTITY: z.string().min(1).optional(),
  RESOURCE_PREFIX: z.string().min(1).default('pigeon'),
});

export interface CliFlags {
  yes: boolean;
  dryRun: boolean;
  writeEnv: boolean;
}

/** Accepts the `--` that `pnpm setup:aws -- --dry-run` forwards. */
export function parseFlags(argv: readonly string[]): CliFlags {
  const { values } = parseArgs({
    args: withoutLeadingSeparator(argv),
    options: {
      yes: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'write-env': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  return {
    yes: Boolean(values.yes),
    dryRun: Boolean(values['dry-run']),
    writeEnv: Boolean(values['write-env']),
  };
}

async function confirm(message: string, opts: { yes: boolean }): Promise<boolean> {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    console.error('Error: stdin is not a TTY — rerun with --yes to skip the confirmation prompt.');
    return false;
  }
  // Import @clack/prompts lazily so the script still type-checks without it
  // on a clean machine.
  const prompts = await import('@clack/prompts');
  const res = await prompts.confirm({ message });
  if (prompts.isCancel(res)) return false;
  return Boolean(res);
}

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function serviceRoot(): string {
  // scripts/aws-setup.ts sits directly under apps/service/ so one level up is
  // the service root.
  return path.resolve(new URL('.', import.meta.url).pathname, '..');
}

/**
 * Create SNS topic (idempotent — `CreateTopic` returns existing ARN).
 */
async function stepCreateTopic(
  sns: ReturnType<typeof buildAdminClients>['sns'],
  state: StateFile,
  topicName: string,
): Promise<string> {
  // Record pre-existence signal by looking for an existing ARN in the state.
  // AWS-native idempotency handles the rest.
  const existing = state.resources.snsTopicArn;
  const res = await sns.send(new CreateTopicCommand({ Name: topicName }));
  if (!res.TopicArn) throw new Error('sns:CreateTopic returned no ARN');
  const arn = res.TopicArn;
  const reused = Boolean(existing) && existing === arn;
  recordOperation(state, {
    action: 'sns:CreateTopic',
    result: reused ? 'reused' : 'created',
    resourceId: arn,
  });
  state.resources.snsTopicArn = arn;
  return arn;
}

/**
 * Create SES configuration set if missing.
 */
async function stepCreateConfigSet(
  ses: ReturnType<typeof buildAdminClients>['ses'],
  state: StateFile,
  configSet: string,
): Promise<void> {
  try {
    await ses.send(new GetConfigurationSetCommand({ ConfigurationSetName: configSet }));
    recordOperation(state, {
      action: 'ses:CreateConfigurationSet',
      result: 'reused',
      resourceId: configSet,
    });
  } catch (err: unknown) {
    if (!isSesNotFound(err)) throw err;
    await ses.send(new CreateConfigurationSetCommand({ ConfigurationSetName: configSet }));
    recordOperation(state, {
      action: 'ses:CreateConfigurationSet',
      result: 'created',
      resourceId: configSet,
    });
  }
  state.resources.configSetName = configSet;
}

/**
 * Create one event destination per event type, each pointing at the topic.
 *
 * Drift detection: if an event destination of our name exists but points at a
 * different topic, abort with a remediation hint — we will not silently
 * overwrite live configuration.
 */
async function stepCreateEventDestinations(
  ses: ReturnType<typeof buildAdminClients>['ses'],
  state: StateFile,
  configSet: string,
  topicArn: string,
): Promise<void> {
  const res = await ses.send(
    new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: configSet }),
  );
  const existing = new Map<string, { topicArn: string | undefined; types: string[] }>();
  for (const dest of res.EventDestinations ?? []) {
    if (!dest.Name) continue;
    existing.set(dest.Name, {
      topicArn: dest.SnsDestination?.TopicArn,
      types: (dest.MatchingEventTypes as string[] | undefined) ?? [],
    });
  }

  const created: string[] = [];
  const reused: string[] = [];

  for (const eventType of EVENT_TYPES) {
    const destName = destinationName(eventType);
    const present = existing.get(destName);
    if (present) {
      if (present.topicArn && present.topicArn !== topicArn) {
        throw new Error(
          `Drift detected: event destination '${destName}' on config set '${configSet}' points at ` +
            `${present.topicArn} but we expected ${topicArn}. Refusing to overwrite — ` +
            `delete the stale destination in the AWS console and rerun setup:aws.`,
        );
      }
      reused.push(destName);
      continue;
    }
    await ses.send(
      new CreateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: configSet,
        EventDestinationName: destName,
        EventDestination: {
          Enabled: true,
          MatchingEventTypes: [eventType as EventType],
          SnsDestination: { TopicArn: topicArn },
        },
      }),
    );
    created.push(destName);
  }

  for (const name of created) {
    recordOperation(state, {
      action: 'ses:CreateConfigurationSetEventDestination',
      result: 'created',
      resourceId: name,
    });
  }
  for (const name of reused) {
    recordOperation(state, {
      action: 'ses:CreateConfigurationSetEventDestination',
      result: 'reused',
      resourceId: name,
    });
  }
  state.resources.eventDestinations = EVENT_TYPES.map(destinationName);
}

function destinationName(eventType: EventType): string {
  return `sns-${eventType.toLowerCase()}`;
}

/**
 * Create IAM runtime policy if missing. Idempotent via GetPolicy.
 */
async function stepCreatePolicy(
  iam: ReturnType<typeof buildAdminClients>['iam'],
  state: StateFile,
  accountId: string,
  policyName: string,
  policyDocument: string,
): Promise<string> {
  const expectedArn = `arn:aws:iam::${accountId}:policy/${policyName}`;
  try {
    await iam.send(new GetPolicyCommand({ PolicyArn: expectedArn }));
    recordOperation(state, {
      action: 'iam:CreatePolicy',
      result: 'reused',
      resourceId: expectedArn,
    });
    state.resources.iamPolicyArn = expectedArn;
    return expectedArn;
  } catch (err: unknown) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  const created = await iam.send(
    new CreatePolicyCommand({
      PolicyName: policyName,
      PolicyDocument: policyDocument,
    }),
  );
  const arn = created.Policy?.Arn;
  if (!arn) throw new Error('iam:CreatePolicy returned no ARN');
  recordOperation(state, {
    action: 'iam:CreatePolicy',
    result: 'created',
    resourceId: arn,
  });
  state.resources.iamPolicyArn = arn;
  return arn;
}


/**
 * Update the IAM policy to the current runtime policy document if it has
 * drifted from what is deployed. IAM allows max 5 policy versions; if at the
 * limit the oldest non-default version is deleted first.
 */
async function stepUpdatePolicyIfDrifted(
  iam: ReturnType<typeof buildAdminClients>['iam'],
  state: StateFile,
  policyArn: string,
  desiredDoc: string,
): Promise<void> {
  const versionsRes = await iam.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn }));
  const versions = versionsRes.Versions ?? [];
  const defaultVersion = versions.find((v) => v.IsDefaultVersion);
  if (!defaultVersion?.VersionId) throw new Error('No default version found for policy');

  const currentRes = await iam.send(
    new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: defaultVersion.VersionId }),
  );
  const rawDocument = currentRes.PolicyVersion?.Document;
  if (!rawDocument) throw new Error('Could not retrieve current policy document');

  const liveDoc = JSON.stringify(JSON.parse(decodeURIComponent(rawDocument)));

  if (liveDoc === desiredDoc) {
    recordOperation(state, {
      action: 'iam:CreatePolicyVersion',
      result: 'reused',
      resourceId: policyArn,
    });
    return;
  }

  if (versions.length >= 5) {
    const oldest = versions
      .filter((v) => !v.IsDefaultVersion)
      .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0))[0];
    if (!oldest?.VersionId) throw new Error('No non-default version to delete at limit of 5');
    await iam.send(
      new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: oldest.VersionId }),
    );
  }

  await iam.send(
    new CreatePolicyVersionCommand({
      PolicyArn: policyArn,
      PolicyDocument: desiredDoc,
      SetAsDefault: true,
    }),
  );
  recordOperation(state, {
    action: 'iam:CreatePolicyVersion',
    result: 'created',
    resourceId: policyArn,
  });
}

/**
 * Create IAM user if missing, then ensure the runtime policy is attached.
 */
async function stepCreateUserAndAttach(
  iam: ReturnType<typeof buildAdminClients>['iam'],
  state: StateFile,
  userName: string,
  policyArn: string,
): Promise<void> {
  let userExists = false;
  try {
    await iam.send(new GetUserCommand({ UserName: userName }));
    userExists = true;
  } catch (err: unknown) {
    if (!(err instanceof NoSuchEntityException)) throw err;
  }

  if (!userExists) {
    await iam.send(new CreateUserCommand({ UserName: userName }));
    recordOperation(state, {
      action: 'iam:CreateUser',
      result: 'created',
      resourceId: userName,
    });
  } else {
    recordOperation(state, {
      action: 'iam:CreateUser',
      result: 'reused',
      resourceId: userName,
    });
  }
  state.resources.iamUserName = userName;

  const attached = await iam.send(new ListAttachedUserPoliciesCommand({ UserName: userName }));
  const hasPolicy = (attached.AttachedPolicies ?? []).some((p) => p.PolicyArn === policyArn);
  if (!hasPolicy) {
    await iam.send(new AttachUserPolicyCommand({ UserName: userName, PolicyArn: policyArn }));
    recordOperation(state, {
      action: 'iam:AttachUserPolicy',
      result: 'created',
      resourceId: `${userName}->${policyArn}`,
    });
  } else {
    recordOperation(state, {
      action: 'iam:AttachUserPolicy',
      result: 'reused',
      resourceId: `${userName}->${policyArn}`,
    });
  }
}

/**
 * Create an access key for the runtime user. Skipped if the state file
 * already records one — we never have more than one active key in our state.
 */
async function stepCreateAccessKey(
  iam: ReturnType<typeof buildAdminClients>['iam'],
  state: StateFile,
  userName: string,
): Promise<{ accessKeyId: string; secretAccessKey: string | null }> {
  if (state.resources.iamAccessKeyId) {
    recordOperation(state, {
      action: 'iam:CreateAccessKey',
      result: 'skipped',
      resourceId: state.resources.iamAccessKeyId,
      note: 'state file already records an access key; re-use it',
    });
    return { accessKeyId: state.resources.iamAccessKeyId, secretAccessKey: null };
  }

  const res = await iam.send(new CreateAccessKeyCommand({ UserName: userName }));
  const id = res.AccessKey?.AccessKeyId;
  const secret = res.AccessKey?.SecretAccessKey;
  if (!id || !secret) throw new Error('iam:CreateAccessKey returned no key material');

  recordOperation(state, {
    action: 'iam:CreateAccessKey',
    result: 'created',
    resourceId: id,
  });
  state.resources.iamAccessKeyId = id;
  return { accessKeyId: id, secretAccessKey: secret };
}

/**
 * Subscribe the webhook endpoint to the SNS topic, if not already subscribed.
 * SNS confirmation is completed by the running service itself on first POST.
 */
async function stepSubscribeWebhook(
  sns: ReturnType<typeof buildAdminClients>['sns'],
  state: StateFile,
  topicArn: string,
  endpoint: string,
): Promise<string> {
  const list = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
  const existing = (list.Subscriptions ?? []).find(
    (s) => s.Protocol === 'https' && s.Endpoint === endpoint,
  );
  if (existing?.SubscriptionArn) {
    recordOperation(state, {
      action: 'sns:Subscribe',
      result: 'reused',
      resourceId: existing.SubscriptionArn,
    });
    state.resources.snsSubscriptionArn = existing.SubscriptionArn;
    return existing.SubscriptionArn;
  }

  const res = await sns.send(
    new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: 'https',
      Endpoint: endpoint,
      ReturnSubscriptionArn: true,
    }),
  );
  // AWS returns literal string "pending confirmation" when the subscription
  // requires confirmation. Store whatever AWS returns.
  const arn = res.SubscriptionArn ?? 'pending confirmation';
  recordOperation(state, {
    action: 'sns:Subscribe',
    result: 'created',
    resourceId: arn,
  });
  state.resources.snsSubscriptionArn = arn;
  return arn;
}

/**
 * Create an SES email identity (address or domain) if missing.
 */
async function stepVerifyIdentity(
  ses: ReturnType<typeof buildAdminClients>['ses'],
  state: StateFile,
  identity: string,
): Promise<void> {
  try {
    await ses.send(new GetEmailIdentityCommand({ EmailIdentity: identity }));
    recordOperation(state, {
      action: 'ses:CreateEmailIdentity',
      result: 'reused',
      resourceId: identity,
    });
  } catch (err: unknown) {
    if (!isSesNotFound(err)) throw err;
    await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: identity }));
    recordOperation(state, {
      action: 'ses:CreateEmailIdentity',
      result: 'created',
      resourceId: identity,
    });
  }
  state.resources.verifiedIdentity = identity;
}

// ── DMARC inbound pipeline steps ──────────────────────────────────────────────

/**
 * Create the S3 bucket for DMARC report storage. Idempotent via HeadBucket.
 * Always applies the bucket policy (SES put-object grant) — the policy call
 * is itself idempotent.
 */
async function stepCreateDmarcS3Bucket(
  s3: S3Client,
  state: StateFile,
  bucketName: string,
  region: string,
  accountId: string,
): Promise<void> {
  let bucketExists = false;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    bucketExists = true;
  } catch (err: unknown) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (err as { name?: string }).name;
    if (status !== 404 && name !== 'NoSuchBucket' && name !== 'NotFound') throw err;
  }

  if (!bucketExists) {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucketName,
        CreateBucketConfiguration: { LocationConstraint: region as never },
      }),
    );
  }

  // Always apply public access block and lifecycle — idempotent.
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
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'expire-incoming',
            Status: 'Enabled',
            Filter: { Prefix: 'incoming/' },
            Expiration: { Days: 90 },
          },
        ],
      },
    }),
  );

  const bucketPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowSESPutObject',
        Effect: 'Allow',
        Principal: { Service: 'ses.amazonaws.com' },
        Action: 's3:PutObject',
        Resource: `arn:aws:s3:::${bucketName}/incoming/*`,
        Condition: { StringEquals: { 'aws:SourceAccount': accountId } },
      },
    ],
  });
  await s3.send(new PutBucketPolicyCommand({ Bucket: bucketName, Policy: bucketPolicy }));

  recordOperation(state, {
    action: 's3:CreateBucket',
    result: bucketExists ? 'reused' : 'created',
    resourceId: bucketName,
  });
  state.resources.dmarcS3BucketName = bucketName;
}

/**
 * Create DMARC SNS topic. Same pattern as stepCreateTopic but uses
 * state.resources.dmarcSnsTopicArn.
 */
async function stepCreateDmarcSnsTopic(
  sns: ReturnType<typeof buildAdminClients>['sns'],
  state: StateFile,
  topicName: string,
): Promise<string> {
  const existing = state.resources.dmarcSnsTopicArn;
  const res = await sns.send(new CreateTopicCommand({ Name: topicName }));
  if (!res.TopicArn) throw new Error('sns:CreateTopic (DMARC) returned no ARN');
  const arn = res.TopicArn;
  const reused = Boolean(existing) && existing === arn;
  recordOperation(state, {
    action: 'sns:CreateTopic:dmarc',
    result: reused ? 'reused' : 'created',
    resourceId: arn,
  });
  state.resources.dmarcSnsTopicArn = arn;
  return arn;
}

/**
 * Register the DMARC receiving domain as a v1 SES receiving domain identity.
 * Returns the verification token if newly created, or null if already registered.
 */
async function stepVerifyDmarcReceivingDomain(
  sesV1: SESClient,
  state: StateFile,
  domain: string,
): Promise<string | null> {
  const list = await sesV1.send(
    new ListIdentitiesCommand({ IdentityType: 'Domain', MaxItems: 100 }),
  );
  const alreadyRegistered = (list.Identities ?? []).includes(domain);

  if (alreadyRegistered) {
    recordOperation(state, {
      action: 'ses:VerifyDomainIdentity',
      result: 'reused',
      resourceId: domain,
    });
    state.resources.dmarcRecipientDomain = domain;
    return null;
  }

  const res = await sesV1.send(new VerifyDomainIdentityCommand({ Domain: domain }));
  const token = res.VerificationToken ?? '';
  recordOperation(state, {
    action: 'ses:VerifyDomainIdentity',
    result: 'created',
    resourceId: domain,
  });
  state.resources.dmarcRecipientDomain = domain;
  return token;
}

/**
 * Create and activate the SES receipt rule set. SetActiveReceiptRuleSet is
 * always called (idempotent).
 */
async function stepCreateReceiptRuleSet(
  sesV1: SESClient,
  state: StateFile,
  ruleSetName: string,
): Promise<void> {
  const list = await sesV1.send(new ListReceiptRuleSetsCommand({}));
  const exists = (list.RuleSets ?? []).some((rs) => rs.Name === ruleSetName);

  if (!exists) {
    await sesV1.send(new CreateReceiptRuleSetCommand({ RuleSetName: ruleSetName }));
  }

  // Always activate — idempotent.
  await sesV1.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: ruleSetName }));

  recordOperation(state, {
    action: 'ses:CreateReceiptRuleSet',
    result: exists ? 'reused' : 'created',
    resourceId: ruleSetName,
  });
  state.resources.dmarcReceiptRuleSetName = ruleSetName;
}

/** Every published `rua=` points at this mailbox. SES has no wildcard recipient. */
export function dmarcReportRecipient(receivingDomain: string): string {
  return `dmarc@${receivingDomain}`;
}

export interface DmarcReceiptRuleOptions {
  sesV1: SESClient;
  state: StateFile;
  ruleSetName: string;
  ruleName: string;
  s3BucketName: string;
  dmarcSnsTopicArn: string;
  stage: string;
  receivingDomain: string;
}

/**
 * Create the SES receipt rule that stores DMARC reports to S3 and notifies
 * the DMARC SNS topic. Idempotent via DescribeReceiptRule. An existing rule is
 * reused as it is, even when its recipients differ.
 */
export async function stepCreateDmarcReceiptRule(opts: DmarcReceiptRuleOptions): Promise<void> {
  const { sesV1, state, ruleSetName, ruleName, s3BucketName, dmarcSnsTopicArn, stage, receivingDomain } = opts;
  let ruleExists = false;
  try {
    await sesV1.send(
      new DescribeReceiptRuleCommand({ RuleSetName: ruleSetName, RuleName: ruleName }),
    );
    ruleExists = true;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name !== 'RuleDoesNotExistException') throw err;
  }

  if (!ruleExists) {
    await sesV1.send(
      new CreateReceiptRuleCommand({
        RuleSetName: ruleSetName,
        Rule: {
          Name: ruleName,
          Enabled: true,
          ScanEnabled: true,
          TlsPolicy: 'Optional',
          Recipients: [dmarcReportRecipient(receivingDomain)],
          Actions: [
            {
              S3Action: {
                BucketName: s3BucketName,
                ObjectKeyPrefix: `incoming/${stage}/`,
                TopicArn: dmarcSnsTopicArn,
              },
            },
          ],
        },
      }),
    );
  }

  recordOperation(state, {
    action: 'ses:CreateReceiptRule',
    result: ruleExists ? 'reused' : 'created',
    resourceId: ruleName,
  });
  state.resources.dmarcReceiptRuleName = ruleName;
}

/**
 * Subscribe the DMARC webhook endpoint to the DMARC SNS topic. Same pattern
 * as stepSubscribeWebhook but uses state.resources.dmarcSnsSubscriptionArn.
 */
async function stepSubscribeDmarcWebhook(
  sns: ReturnType<typeof buildAdminClients>['sns'],
  state: StateFile,
  dmarcTopicArn: string,
  endpoint: string,
): Promise<string> {
  const list = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: dmarcTopicArn }));
  const existing = (list.Subscriptions ?? []).find(
    (s) => s.Protocol === 'https' && s.Endpoint === endpoint,
  );
  if (existing?.SubscriptionArn) {
    recordOperation(state, {
      action: 'sns:Subscribe:dmarc',
      result: 'reused',
      resourceId: existing.SubscriptionArn,
    });
    state.resources.dmarcSnsSubscriptionArn = existing.SubscriptionArn;
    return existing.SubscriptionArn;
  }

  const res = await sns.send(
    new SubscribeCommand({
      TopicArn: dmarcTopicArn,
      Protocol: 'https',
      Endpoint: endpoint,
      ReturnSubscriptionArn: true,
    }),
  );
  const arn = res.SubscriptionArn ?? 'pending confirmation';
  recordOperation(state, {
    action: 'sns:Subscribe:dmarc',
    result: 'created',
    resourceId: arn,
  });
  state.resources.dmarcSnsSubscriptionArn = arn;
  return arn;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSesNotFound(err: unknown): boolean {
  if (err instanceof SesNotFoundException) return true;
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'NotFoundException';
}

function formatEnvBlock(args: {
  accessKeyId: string;
  secretAccessKey: string | null;
  region: string;
  configSet: string;
  topicArn: string;
}): string {
  const secretLine = args.secretAccessKey
    ? `AWS_SECRET_ACCESS_KEY=${args.secretAccessKey}`
    : '# AWS_SECRET_ACCESS_KEY=<not re-emitted — only shown once at create time>';
  return [
    `AWS_ACCESS_KEY_ID=${args.accessKeyId}`,
    secretLine,
    `AWS_REGION=${args.region}`,
    `AWS_SES_CONFIGURATION_SET=${args.configSet}`,
    `SES_SNS_TOPIC_ARN=${args.topicArn}`,
  ].join('\n');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const flags = parseFlags(argv);

  let env: z.infer<typeof EnvSchema>;
  try {
    env = EnvSchema.parse({
      AWS_REGION: process.env.AWS_REGION,
      STAGE: process.env.STAGE,
      WEBHOOK_ENDPOINT_URL: process.env.WEBHOOK_ENDPOINT_URL,
      SES_VERIFY_IDENTITY: process.env.SES_VERIFY_IDENTITY,
      RESOURCE_PREFIX: process.env.RESOURCE_PREFIX,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error('Environment validation failed:');
      for (const issue of err.issues) {
        console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      return 1;
    }
    throw err;
  }

  // Deployment-specific names and URL. Read before any AWS call; a missing one throws.
  const settings = readScriptSettings(['publicUrl', 'inboundBucket', 'dmarcBucket', 'dmarcDomain']);

  const clients = buildAdminClients(env.AWS_REGION);

  console.log(`aws-setup — region=${env.AWS_REGION} stage=${env.STAGE} prefix=${env.RESOURCE_PREFIX}`);
  console.log('Running preflight...');
  const preflight = await runPreflight({ sts: clients.sts, iam: clients.iam });
  console.log(`  caller: ${preflight.identity.arn}`);
  console.log(`  account: ${preflight.identity.accountId}`);

  if (preflight.simulateSkipped) {
    console.warn(
      '  warning: iam:SimulatePrincipalPolicy is not available to this caller. ' +
        'Proceeding best-effort — individual steps will fail cleanly on AccessDenied.',
    );
  } else if (preflight.deniedActions && preflight.deniedActions.length > 0) {
    console.error('  missing permissions:');
    for (const action of preflight.deniedActions) {
      console.error(`    - ${action}`);
    }
    return 1;
  } else {
    console.log('  all required actions allowed by the caller identity.');
  }

  // Build plan
  const plan = buildPlan({
    stage: env.STAGE,
    region: env.AWS_REGION,
    accountId: preflight.identity.accountId,
    resourcePrefix: env.RESOURCE_PREFIX,
    dmarcBucket: settings.dmarcBucket,
    dmarcDomain: settings.dmarcDomain,
    publicUrl: settings.publicUrl,
    webhookEndpointUrl: env.WEBHOOK_ENDPOINT_URL,
    verifyIdentity: env.SES_VERIFY_IDENTITY,
  });
  console.log('\nPlan:');
  console.log(renderPlan(plan));

  if (flags.dryRun) {
    console.log('\n--dry-run: no resources created. Exiting.');
    return 0;
  }

  if (!(await confirm('Proceed?', { yes: flags.yes }))) {
    console.log('Aborted by user.');
    return 1;
  }

  // Load existing state (if any).
  const statePath = stateFilePath(serviceRoot(), env.STAGE);
  const existingState = await readState(statePath);
  const state =
    existingState ??
    emptyStateFile({
      stage: env.STAGE,
      region: env.AWS_REGION,
      accountId: preflight.identity.accountId,
      resourcePrefix: env.RESOURCE_PREFIX,
    });

  const topic = snsTopicName(env.RESOURCE_PREFIX, env.STAGE);
  const configSet = configurationSetName(env.RESOURCE_PREFIX, env.STAGE);
  const policyName = runtimePolicyName(env.STAGE);
  const userName = runtimeUserName(env.STAGE);
  const policyDocument = runtimePolicyDocument({
    dmarcBucket: settings.dmarcBucket,
    inboundBucket: settings.inboundBucket,
  });

  // Steps
  const topicArn = await stepCreateTopic(clients.sns, state, topic);
  console.log(`  SNS topic: ${topicArn}`);

  await stepCreateConfigSet(clients.ses, state, configSet);
  console.log(`  SES configuration set: ${configSet}`);

  await stepCreateEventDestinations(clients.ses, state, configSet, topicArn);
  console.log(`  SES event destinations: bounce, complaint, delivery, reject`);

  const policyArn = await stepCreatePolicy(
    clients.iam,
    state,
    preflight.identity.accountId,
    policyName,
    policyDocument,
  );
  console.log(`  IAM policy: ${policyArn}`);

  await stepUpdatePolicyIfDrifted(clients.iam, state, policyArn, policyDocument);
  console.log(`  IAM policy document: up to date`);

  await stepCreateUserAndAttach(clients.iam, state, userName, policyArn);
  console.log(`  IAM user: ${userName} (policy attached)`);

  const key = await stepCreateAccessKey(clients.iam, state, userName);
  if (key.secretAccessKey) {
    console.log(`  IAM access key: ${key.accessKeyId} (secret below)`);
  } else {
    console.log(`  IAM access key: ${key.accessKeyId} (pre-existing, secret not re-emitted)`);
  }

  let subscriptionArn: string | undefined;
  if (env.WEBHOOK_ENDPOINT_URL) {
    subscriptionArn = await stepSubscribeWebhook(
      clients.sns,
      state,
      topicArn,
      env.WEBHOOK_ENDPOINT_URL,
    );
    console.log(`  SNS subscription: ${subscriptionArn}`);
  }

  if (env.SES_VERIFY_IDENTITY) {
    await stepVerifyIdentity(clients.ses, state, env.SES_VERIFY_IDENTITY);
    console.log(`  SES identity: ${env.SES_VERIFY_IDENTITY}`);
  }

  // Persist state file.
  await writeStateAtomic(statePath, state);
  console.log(`  state file: ${statePath}`);

  // DMARC inbound pipeline
  const dmarcBucket = settings.dmarcBucket;
  const dmarcTopic = dmarcSnsTopicName(env.STAGE);
  const dmarcDomain = settings.dmarcDomain;
  const dmarcRuleSet = dmarcReceiptRuleSetName();
  const dmarcRule = dmarcReceiptRuleName(env.STAGE);
  const DMARC_WEBHOOK = dmarcWebhookUrl(settings.publicUrl);

  await stepCreateDmarcS3Bucket(clients.s3, state, dmarcBucket, env.AWS_REGION, preflight.identity.accountId);
  console.log(`  DMARC S3 bucket: ${dmarcBucket}`);

  const dmarcTopicArn = await stepCreateDmarcSnsTopic(clients.sns, state, dmarcTopic);
  console.log(`  DMARC SNS topic: ${dmarcTopicArn}`);

  const dmarcToken = await stepVerifyDmarcReceivingDomain(clients.sesV1, state, dmarcDomain);
  console.log(`  DMARC receiving domain: ${dmarcDomain}${dmarcToken ? ' (token: ' + dmarcToken + ')' : ' (already registered)'}`);

  await stepCreateReceiptRuleSet(clients.sesV1, state, dmarcRuleSet);
  console.log(`  DMARC receipt rule set: ${dmarcRuleSet}`);

  await stepCreateDmarcReceiptRule({
    sesV1: clients.sesV1,
    state,
    ruleSetName: dmarcRuleSet,
    ruleName: dmarcRule,
    s3BucketName: dmarcBucket,
    dmarcSnsTopicArn: dmarcTopicArn,
    stage: env.STAGE,
    receivingDomain: dmarcDomain,
  });
  console.log(`  DMARC receipt rule: ${dmarcRule}`);

  const dmarcSubArn = await stepSubscribeDmarcWebhook(clients.sns, state, dmarcTopicArn, DMARC_WEBHOOK);
  console.log(`  DMARC SNS subscription: ${dmarcSubArn}`);

  // Re-persist state with DMARC resources.
  await writeStateAtomic(statePath, state);
  console.log(`  state file (DMARC): ${statePath}`);

  // Print the env block LAST so piping to `>> .env` doesn't pick up noise.
  console.log('');
  console.log('# ── paste into apps/service/.env ──');
  console.log(
    formatEnvBlock({
      accessKeyId: key.accessKeyId,
      secretAccessKey: key.secretAccessKey,
      region: env.AWS_REGION,
      configSet,
      topicArn,
    }),
  );
  console.log('# ── end ──');

  if (env.WEBHOOK_ENDPOINT_URL) {
    console.log('');
    console.log('# ── SNS subscription ──');
    console.log(`Endpoint: ${env.WEBHOOK_ENDPOINT_URL}`);
    console.log(`Subscription ARN: ${subscriptionArn}`);
    console.log(
      'Next: start the service so it handles the SubscriptionConfirmation POST from AWS.',
    );
  }

  // DMARC DNS instructions
  console.log('');
  console.log('# ── DMARC DNS records (publish in Cloudflare) ──');
  console.log(`MX  ${dmarcDomain}  10 inbound-smtp.${env.AWS_REGION}.amazonaws.com`);
  console.log(`TXT ${dmarcDomain}  "v=spf1 -all"`);
  if (dmarcToken) {
    console.log(`TXT _amazonses.${dmarcDomain}  "${dmarcToken}"`);
  }
  console.log('# ── end ──');

  return 0;
}

// Only run `main()` when invoked as a script (not when imported for tests).
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
