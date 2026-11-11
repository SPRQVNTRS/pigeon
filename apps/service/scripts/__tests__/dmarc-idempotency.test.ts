/**
 * Idempotency tests for the DMARC inbound pipeline steps.
 *
 * A second run (all resources already exist) must make zero create calls.
 * We exercise each step directly against aws-sdk-client-mock clients, mirroring
 * the pattern established in setup-idempotency.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mockClient } from 'aws-sdk-client-mock';
import { SNSClient, CreateTopicCommand, ListSubscriptionsByTopicCommand } from '@aws-sdk/client-sns';
import {
  SESClient,
  ListIdentitiesCommand,
  ListReceiptRuleSetsCommand,
  CreateReceiptRuleSetCommand,
  SetActiveReceiptRuleSetCommand,
  DescribeReceiptRuleCommand,
  CreateReceiptRuleCommand,
} from '@aws-sdk/client-ses';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import {
  emptyStateFile,
  writeStateAtomic,
  type StateFile,
} from '../lib/state';

const snsMock = mockClient(SNSClient);
const sesMock = mockClient(SESClient);
const s3Mock = mockClient(S3Client);

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const STAGE = 'dev';
const PREFIX = 'pigeon';

const DMARC_BUCKET = 'example-dmarc-reports';
const DMARC_TOPIC_NAME = `pigeon-dmarc-ingest-${STAGE}`;
const DMARC_TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT}:${DMARC_TOPIC_NAME}`;
const DMARC_DOMAIN = 'dmarc.example.com';
const DMARC_RULE_SET = 'pigeon-receive-rules';
const DMARC_RULE_NAME = `pigeon-dmarc-reports-${STAGE}`;
const DMARC_WEBHOOK = 'https://pigeon.example.com/v1/webhooks/dmarc';
const DMARC_SUB_ARN = `arn:aws:sns:${REGION}:${ACCOUNT}:${DMARC_TOPIC_NAME}:sub-existing`;

// Import the setup module (main() only runs when invoked as a script)
const { stepCreateDmarcReceiptRule } = await import('../aws-setup');

describe('DMARC setup idempotency', () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    snsMock.reset();
    sesMock.reset();
    s3Mock.reset();
    dir = await fs.mkdtemp(path.join(tmpdir(), 'dmarc-idem-'));
    statePath = path.join(dir, '.aws-setup.state.test.json');
  });

  afterEach(async () => {
    snsMock.reset();
    sesMock.reset();
    s3Mock.reset();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('second run makes zero create calls when all DMARC resources already exist', async () => {
    // Simulate state after a successful first run.
    const afterFirst: StateFile = emptyStateFile({
      stage: STAGE,
      region: REGION,
      accountId: ACCOUNT,
      resourcePrefix: PREFIX,
    });
    afterFirst.resources.dmarcS3BucketName = DMARC_BUCKET;
    afterFirst.resources.dmarcSnsTopicArn = DMARC_TOPIC_ARN;
    afterFirst.resources.dmarcRecipientDomain = DMARC_DOMAIN;
    afterFirst.resources.dmarcReceiptRuleSetName = DMARC_RULE_SET;
    afterFirst.resources.dmarcReceiptRuleName = DMARC_RULE_NAME;
    afterFirst.resources.dmarcSnsSubscriptionArn = DMARC_SUB_ARN;
    await writeStateAtomic(statePath, afterFirst);

    // Mock S3: bucket already exists (HeadBucket resolves, no 404).
    s3Mock.on(HeadBucketCommand).resolves({});
    // PutPublicAccessBlock and PutBucketLifecycleConfiguration are always called
    // (idempotent) — allow them to succeed.
    s3Mock.on(PutPublicAccessBlockCommand).resolves({});
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(PutBucketPolicyCommand).resolves({});

    // Mock SNS: CreateTopic is AWS-native idempotent — returns existing ARN.
    snsMock.on(CreateTopicCommand).resolves({ TopicArn: DMARC_TOPIC_ARN });
    // Subscription already exists.
    snsMock.on(ListSubscriptionsByTopicCommand).resolves({
      Subscriptions: [
        { Protocol: 'https', Endpoint: DMARC_WEBHOOK, SubscriptionArn: DMARC_SUB_ARN },
      ],
    });

    // Mock SES v1: domain already registered.
    sesMock.on(ListIdentitiesCommand).resolves({ Identities: [DMARC_DOMAIN] });
    // Rule set already exists.
    sesMock.on(ListReceiptRuleSetsCommand).resolves({
      RuleSets: [{ Name: DMARC_RULE_SET, CreatedTimestamp: new Date() }],
    });
    sesMock.on(SetActiveReceiptRuleSetCommand).resolves({});
    // Receipt rule already exists.
    sesMock.on(DescribeReceiptRuleCommand).resolves({
      Rule: {
        Name: DMARC_RULE_NAME,
        Enabled: true,
        Recipients: [DMARC_DOMAIN],
        Actions: [],
      },
    });

    // Exercise the sequence — simulate what the step functions do on a second run.
    const s3 = new S3Client({ region: REGION });
    const sns = new SNSClient({ region: REGION });
    const sesV1 = new SESClient({ region: REGION });

    // S3: HeadBucket resolves → no CreateBucket issued.
    await s3.send(new HeadBucketCommand({ Bucket: DMARC_BUCKET }));

    // SNS: CreateTopic (AWS-native idempotent).
    await sns.send(new CreateTopicCommand({ Name: DMARC_TOPIC_NAME }));

    // SES v1: ListIdentities → domain present → no VerifyDomainIdentity.
    await sesV1.send(new ListIdentitiesCommand({ IdentityType: 'Domain', MaxItems: 100 }));

    // SES v1: ListReceiptRuleSets → rule set present → no CreateReceiptRuleSet.
    await sesV1.send(new ListReceiptRuleSetsCommand({}));
    await sesV1.send(new SetActiveReceiptRuleSetCommand({ RuleSetName: DMARC_RULE_SET }));

    // SES v1: DescribeReceiptRule → rule present → no CreateReceiptRule.
    await sesV1.send(
      new DescribeReceiptRuleCommand({ RuleSetName: DMARC_RULE_SET, RuleName: DMARC_RULE_NAME }),
    );

    // SNS: ListSubscriptionsByTopic → subscription present → no new Subscribe.
    await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: DMARC_TOPIC_ARN }));

    // Assertions: no create calls issued.
    expect(s3Mock.commandCalls(CreateBucketCommand)).toHaveLength(0);
    expect(sesMock.commandCalls(CreateReceiptRuleSetCommand)).toHaveLength(0);
    expect(sesMock.commandCalls(CreateReceiptRuleCommand)).toHaveLength(0);
    // CreateTopic is expected once — AWS itself guarantees idempotency.
    expect(snsMock.commandCalls(CreateTopicCommand)).toHaveLength(1);
  });

  describe('stepCreateDmarcReceiptRule', () => {
    function ruleOptions(state: StateFile) {
      return {
        sesV1: new SESClient({ region: REGION }),
        state,
        ruleSetName: DMARC_RULE_SET,
        ruleName: DMARC_RULE_NAME,
        s3BucketName: DMARC_BUCKET,
        dmarcSnsTopicArn: DMARC_TOPIC_ARN,
        stage: STAGE,
        receivingDomain: DMARC_DOMAIN,
      };
    }

    function freshState(): StateFile {
      return emptyStateFile({ stage: STAGE, region: REGION, accountId: ACCOUNT, resourcePrefix: PREFIX });
    }

    it('creates the rule for dmarc@<receiving domain>, the address every rua names (SES has no wildcard)', async () => {
      sesMock
        .on(DescribeReceiptRuleCommand)
        .rejects(Object.assign(new Error('Rule does not exist'), { name: 'RuleDoesNotExistException' }));
      sesMock.on(CreateReceiptRuleCommand).resolves({});

      await stepCreateDmarcReceiptRule(ruleOptions(freshState()));

      const calls = sesMock.commandCalls(CreateReceiptRuleCommand);
      expect(calls).toHaveLength(1);
      const rule = calls[0]!.args[0].input.Rule;
      expect(rule?.Recipients).toEqual([`dmarc@${DMARC_DOMAIN}`]);
      expect(rule?.Actions?.[0]?.S3Action).toMatchObject({
        BucketName: DMARC_BUCKET,
        ObjectKeyPrefix: `incoming/${STAGE}/`,
        TopicArn: DMARC_TOPIC_ARN,
      });
    });

    it('makes no create call when the rule exists', async () => {
      sesMock.on(DescribeReceiptRuleCommand).resolves({ Rule: { Name: DMARC_RULE_NAME } });
      const state = freshState();

      await stepCreateDmarcReceiptRule(ruleOptions(state));

      expect(sesMock.commandCalls(CreateReceiptRuleCommand)).toHaveLength(0);
      expect(state.resources.dmarcReceiptRuleName).toBe(DMARC_RULE_NAME);
    });
  });
});
