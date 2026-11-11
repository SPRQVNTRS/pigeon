/**
 * aws-teardown.ts — Reverse everything aws-setup.ts created, based strictly
 * on what the state file records. Refuses to touch any resource it didn't
 * itself create.
 *
 * Run with:  pnpm --filter @sprqvntrs/pigeon teardown:aws
 */

import { parseArgs } from 'node:util';
import path from 'node:path';
import {
  DeleteAccessKeyCommand,
  DeletePolicyCommand,
  DeleteUserCommand,
  DetachUserPolicyCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import {
  SESClient,
  DeleteIdentityCommand,
  DeleteReceiptRuleCommand,
} from '@aws-sdk/client-ses';
import {
  DeleteConfigurationSetCommand,
  DeleteConfigurationSetEventDestinationCommand,
  DeleteEmailIdentityCommand,
  NotFoundException as SesNotFoundException,
} from '@aws-sdk/client-sesv2';
import { DeleteTopicCommand, UnsubscribeCommand } from '@aws-sdk/client-sns';
import {
  S3Client,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import { buildAdminClients } from './lib/aws-clients.js';
import { archiveState, readState, stateFilePath, type StateFile } from './lib/state.js';
import { withoutLeadingSeparator } from './lib/argv.js';
import {
  configurationSetName,
  runtimePolicyName,
  runtimeUserName,
  snsTopicName,
} from './lib/runtime-policy.js';

const EnvSchema = z.object({
  STAGE: z.enum(['dev', 'staging', 'prod']),
});

interface TeardownFlags {
  yes: boolean;
  confirmWord?: string;
}

export function parseFlags(argv: readonly string[]): TeardownFlags {
  const { values } = parseArgs({
    args: withoutLeadingSeparator(argv),
    options: {
      yes: { type: 'boolean', default: false },
      'confirm-word': { type: 'string' },
    },
    allowPositionals: false,
  });
  return {
    yes: Boolean(values.yes),
    confirmWord: values['confirm-word'] as string | undefined,
  };
}

function serviceRoot(): string {
  return path.resolve(new URL('.', import.meta.url).pathname, '..');
}

function isNotFound(err: unknown): boolean {
  if (err instanceof NoSuchEntityException) return true;
  if (err instanceof SesNotFoundException) return true;
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return (
    name === 'NoSuchEntity' ||
    name === 'NoSuchEntityException' ||
    name === 'NotFoundException' ||
    name === 'NotFound' ||
    name === 'NoSuchBucket' ||
    name === 'RuleDoesNotExistException'
  );
}

async function askTypedConfirmation(word: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      `Error: prod teardown requires typed confirmation. Rerun with --confirm-word=${word}`,
    );
    return false;
  }
  const prompts = await import('@clack/prompts');
  const res = await prompts.text({
    message: `Type '${word}' to confirm prod teardown`,
    validate: (v) => (v === word ? undefined : `Expected '${word}'`),
  });
  if (prompts.isCancel(res)) return false;
  return res === word;
}

async function confirmSimple(message: string, opts: { yes: boolean }): Promise<boolean> {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    console.error('Error: stdin is not a TTY — rerun with --yes to skip the confirmation prompt.');
    return false;
  }
  const prompts = await import('@clack/prompts');
  const res = await prompts.confirm({ message });
  if (prompts.isCancel(res)) return false;
  return Boolean(res);
}

/**
 * Verify that the names in the state file match what the setup script would
 * have chosen, given the recorded stage/prefix. If they don't, we treat the
 * file as tampered — refuse to delete resources we didn't create.
 */
export function ensureNamesMatchConvention(state: StateFile): void {
  const expectedTopic = snsTopicName(state.resourcePrefix, state.stage);
  const expectedConfigSet = configurationSetName(state.resourcePrefix, state.stage);
  const expectedUser = runtimeUserName(state.stage);
  const expectedPolicy = runtimePolicyName(state.stage);

  if (state.resources.iamUserName && state.resources.iamUserName !== expectedUser) {
    throw new Error(
      `State file recorded iamUserName='${state.resources.iamUserName}' but convention ` +
        `expects '${expectedUser}' for stage='${state.stage}'. Refusing to delete — the state ` +
        `file appears tampered or was produced by a different tool.`,
    );
  }
  if (
    state.resources.iamPolicyArn &&
    !state.resources.iamPolicyArn.endsWith(`:policy/${expectedPolicy}`)
  ) {
    throw new Error(
      `State file recorded iamPolicyArn='${state.resources.iamPolicyArn}' but convention ` +
        `expects the policy to end with ':policy/${expectedPolicy}'. Refusing to delete.`,
    );
  }
  if (state.resources.configSetName && state.resources.configSetName !== expectedConfigSet) {
    throw new Error(
      `State file recorded configSetName='${state.resources.configSetName}' but convention ` +
        `expects '${expectedConfigSet}'. Refusing to delete.`,
    );
  }
  if (
    state.resources.snsTopicArn &&
    !state.resources.snsTopicArn.endsWith(`:${expectedTopic}`)
  ) {
    throw new Error(
      `State file recorded snsTopicArn='${state.resources.snsTopicArn}' but convention ` +
        `expects the topic name to be '${expectedTopic}'. Refusing to delete.`,
    );
  }
}

/**
 * Delete all objects in an S3 bucket prefix, then delete the bucket itself.
 */
async function deleteBucketWithContents(
  s3: S3Client,
  bucketName: string,
  log: (msg: string) => void,
): Promise<void> {
  // Drain all objects in batches of 1000 (S3 delete-objects limit).
  let continuationToken: string | undefined;
  do {
    const listRes = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken,
      }),
    );
    const objects = listRes.Contents ?? [];
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: objects.map((o) => ({ Key: o.Key! })),
            Quiet: true,
          },
        }),
      );
      log(`deleted ${objects.length} object(s) from ${bucketName}`);
    }
    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);

  await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));
  log(`deleted S3 bucket ${bucketName}`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const flags = parseFlags(argv);

  let env: z.infer<typeof EnvSchema>;
  try {
    env = EnvSchema.parse({ STAGE: process.env.STAGE });
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

  const statePath = stateFilePath(serviceRoot(), env.STAGE);
  const state = await readState(statePath);

  if (!state) {
    console.error(`No state file at ${statePath}. Did you run setup:aws?`);
    return 1;
  }

  console.log(
    `aws-teardown — stage=${state.stage} region=${state.region} account=${state.accountId}`,
  );
  console.log('Resources recorded in the state file:');
  for (const [k, v] of Object.entries(state.resources)) {
    if (v === undefined) continue;
    console.log(`  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }

  // Guard against deleting resources we didn't create.
  try {
    ensureNamesMatchConvention(state);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  // Prod requires typed confirmation, even with --yes.
  if (state.stage === 'prod') {
    if (flags.confirmWord) {
      if (flags.confirmWord !== 'delete') {
        console.error(`Expected --confirm-word=delete, got ${flags.confirmWord}`);
        return 1;
      }
    } else {
      const ok = await askTypedConfirmation('delete');
      if (!ok) {
        console.log('Aborted: prod teardown requires typing "delete".');
        return 1;
      }
    }
  } else {
    if (!(await confirmSimple('Proceed with teardown?', { yes: flags.yes }))) {
      console.log('Aborted by user.');
      return 1;
    }
  }

  const clients = buildAdminClients(state.region);
  const sesV1 = new SESClient({ region: state.region });
  const s3 = new S3Client({ region: state.region });
  const log = (msg: string) => console.log(`  ${msg}`);

  // Reverse order:
  // 1. SNS subscription (main webhook)
  if (state.resources.snsSubscriptionArn && state.resources.snsSubscriptionArn !== 'pending confirmation') {
    try {
      await clients.sns.send(
        new UnsubscribeCommand({ SubscriptionArn: state.resources.snsSubscriptionArn }),
      );
      log(`deleted SNS subscription ${state.resources.snsSubscriptionArn}`);
    } catch (err) {
      if (isNotFound(err)) log(`SNS subscription already gone`);
      else {
        log(`SNS subscription delete failed: ${errMessage(err)} — continuing`);
      }
    }
  }

  // 1b. DMARC SNS subscription
  if (state.resources.dmarcSnsSubscriptionArn && state.resources.dmarcSnsSubscriptionArn !== 'pending confirmation') {
    try {
      await clients.sns.send(
        new UnsubscribeCommand({ SubscriptionArn: state.resources.dmarcSnsSubscriptionArn }),
      );
      log(`deleted DMARC SNS subscription ${state.resources.dmarcSnsSubscriptionArn}`);
    } catch (err) {
      if (isNotFound(err)) log(`DMARC SNS subscription already gone`);
      else log(`DMARC SNS subscription delete failed: ${errMessage(err)} — continuing`);
    }
  }

  // 1c. DMARC receipt rule
  if (state.resources.dmarcReceiptRuleSetName && state.resources.dmarcReceiptRuleName) {
    try {
      await sesV1.send(
        new DeleteReceiptRuleCommand({
          RuleSetName: state.resources.dmarcReceiptRuleSetName,
          RuleName: state.resources.dmarcReceiptRuleName,
        }),
      );
      log(`deleted DMARC receipt rule ${state.resources.dmarcReceiptRuleName}`);
    } catch (err) {
      if (isNotFound(err)) log(`DMARC receipt rule already gone`);
      else log(`DMARC receipt rule delete failed: ${errMessage(err)} — continuing`);
    }
  }

  // 1d. DMARC SNS topic
  if (state.resources.dmarcSnsTopicArn) {
    try {
      await clients.sns.send(
        new DeleteTopicCommand({ TopicArn: state.resources.dmarcSnsTopicArn }),
      );
      log(`deleted DMARC SNS topic ${state.resources.dmarcSnsTopicArn}`);
    } catch (err) {
      if (isNotFound(err)) log(`DMARC SNS topic already gone`);
      else log(`DMARC SNS topic delete failed: ${errMessage(err)} — continuing`);
    }
  }

  // 1e. DMARC S3 bucket (drain + delete)
  if (state.resources.dmarcS3BucketName) {
    try {
      await deleteBucketWithContents(s3, state.resources.dmarcS3BucketName, log);
    } catch (err) {
      if (isNotFound(err)) log(`DMARC S3 bucket already gone`);
      else log(`DMARC S3 bucket delete failed: ${errMessage(err)} — continuing`);
    }
  }

  // 1f. DMARC receiving domain identity
  if (state.resources.dmarcRecipientDomain) {
    try {
      await sesV1.send(
        new DeleteIdentityCommand({ Identity: state.resources.dmarcRecipientDomain }),
      );
      log(`deleted DMARC receiving domain identity ${state.resources.dmarcRecipientDomain}`);
    } catch (err) {
      if (isNotFound(err)) log(`DMARC receiving domain identity already gone`);
      else log(`DMARC receiving domain identity delete failed: ${errMessage(err)} — continuing`);
    }
  }

  // 2. SES event destinations
  if (state.resources.configSetName && state.resources.eventDestinations) {
    for (const dest of state.resources.eventDestinations) {
      try {
        await clients.ses.send(
          new DeleteConfigurationSetEventDestinationCommand({
            ConfigurationSetName: state.resources.configSetName,
            EventDestinationName: dest,
          }),
        );
        log(`deleted event destination ${dest}`);
      } catch (err) {
        if (isNotFound(err)) log(`event destination ${dest} already gone`);
        else log(`event destination ${dest} delete failed: ${errMessage(err)} — continuing`);
      }
    }
  }

  // 3. SES configuration set
  if (state.resources.configSetName) {
    try {
      await clients.ses.send(
        new DeleteConfigurationSetCommand({
          ConfigurationSetName: state.resources.configSetName,
        }),
      );
      log(`deleted configuration set ${state.resources.configSetName}`);
    } catch (err) {
      if (isNotFound(err)) log(`configuration set already gone`);
      else log(`configuration set delete failed: ${errMessage(err)} — continuing`);
    }
  }

  // 4. SES identity (if any)
  if (state.resources.verifiedIdentity) {
    try {
      await clients.ses.send(
        new DeleteEmailIdentityCommand({ EmailIdentity: state.resources.verifiedIdentity }),
      );
      log(`deleted email identity ${state.resources.verifiedIdentity}`);
    } catch (err) {
      if (isNotFound(err)) log(`identity already gone`);
      else log(`identity delete failed: ${errMessage(err)} — continuing`);
    }
  }

  // 5. SNS topic
  if (state.resources.snsTopicArn) {
    try {
      await clients.sns.send(new DeleteTopicCommand({ TopicArn: state.resources.snsTopicArn }));
      log(`deleted SNS topic ${state.resources.snsTopicArn}`);
    } catch (err) {
      if (isNotFound(err)) log(`SNS topic already gone`);
      else log(`SNS topic delete failed: ${errMessage(err)} — continuing`);
    }
  }

  // 6. IAM access key
  if (state.resources.iamUserName && state.resources.iamAccessKeyId) {
    try {
      await clients.iam.send(
        new DeleteAccessKeyCommand({
          UserName: state.resources.iamUserName,
          AccessKeyId: state.resources.iamAccessKeyId,
        }),
      );
      log(`deleted access key ${state.resources.iamAccessKeyId}`);
    } catch (err) {
      if (isNotFound(err)) log(`access key already gone`);
      else log(`access key delete failed: ${errMessage(err)} — continuing`);
    }
  }

  // 7. Detach policy, then delete user
  if (state.resources.iamUserName && state.resources.iamPolicyArn) {
    try {
      await clients.iam.send(
        new DetachUserPolicyCommand({
          UserName: state.resources.iamUserName,
          PolicyArn: state.resources.iamPolicyArn,
        }),
      );
      log(`detached policy from user`);
    } catch (err) {
      if (isNotFound(err)) log(`policy attachment already gone`);
      else log(`detach failed: ${errMessage(err)} — continuing`);
    }
  }
  if (state.resources.iamUserName) {
    try {
      await clients.iam.send(new DeleteUserCommand({ UserName: state.resources.iamUserName }));
      log(`deleted IAM user ${state.resources.iamUserName}`);
    } catch (err) {
      if (isNotFound(err)) log(`IAM user already gone`);
      else log(`IAM user delete failed: ${errMessage(err)} — continuing`);
    }
  }

  // 8. IAM policy
  if (state.resources.iamPolicyArn) {
    try {
      await clients.iam.send(
        new DeletePolicyCommand({ PolicyArn: state.resources.iamPolicyArn }),
      );
      log(`deleted IAM policy ${state.resources.iamPolicyArn}`);
    } catch (err) {
      if (isNotFound(err)) log(`IAM policy already gone`);
      else log(`IAM policy delete failed: ${errMessage(err)} — continuing`);
    }
  }

  // 9. Archive the state file — leave a breadcrumb instead of destroying it.
  const archived = await archiveState(statePath);
  if (archived) {
    log(`archived state file to ${archived}`);
  }

  return 0;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

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
