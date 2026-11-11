/**
 * Build the human-readable "here's what I'll do" plan shown before we touch
 * anything. Keep output plain text — no ANSI color, no box-drawing. It may
 * run under CI or a non-TTY logger someday.
 */

import {
  configurationSetName,
  dmarcReceiptRuleName,
  dmarcReceiptRuleSetName,
  dmarcSnsTopicName,
  dmarcWebhookUrl,
  runtimePolicyName,
  runtimeUserName,
  snsTopicName,
} from './runtime-policy.js';

export interface PlanInputs {
  stage: string;
  region: string;
  accountId: string;
  resourcePrefix: string;
  /** S3 bucket for DMARC aggregate reports. */
  dmarcBucket: string;
  /** Domain that receives DMARC aggregate reports. */
  dmarcDomain: string;
  /** Public base URL of the service, no trailing slash. */
  publicUrl: string;
  webhookEndpointUrl?: string;
  verifyIdentity?: string;
}

export interface PlanLine {
  step: number;
  title: string;
  detail: string;
}

export function buildPlan(inputs: PlanInputs): PlanLine[] {
  const topic = snsTopicName(inputs.resourcePrefix, inputs.stage);
  const configSet = configurationSetName(inputs.resourcePrefix, inputs.stage);
  const user = runtimeUserName(inputs.stage);
  const policy = runtimePolicyName(inputs.stage);

  const plan: PlanLine[] = [
    {
      step: 1,
      title: 'Create SNS topic',
      detail: `${topic} (arn:aws:sns:${inputs.region}:${inputs.accountId}:${topic})`,
    },
    {
      step: 2,
      title: 'Create SES configuration set',
      detail: configSet,
    },
    {
      step: 3,
      title: 'Create SES event destinations',
      detail: 'bounce, complaint, delivery, reject — all routed to the SNS topic above',
    },
    {
      step: 4,
      title: 'Create IAM runtime policy',
      detail: policy,
    },
    {
      step: 5,
      title: 'Create IAM user and attach policy',
      detail: user,
    },
    {
      step: 6,
      title: 'Create IAM access key (secret printed once)',
      detail: `Owner: ${user}. Skipped if the state file already records a key for this user.`,
    },
  ];

  if (inputs.webhookEndpointUrl) {
    plan.push({
      step: 7,
      title: 'Subscribe webhook endpoint to SNS topic',
      detail: `Endpoint: ${inputs.webhookEndpointUrl}. Confirmation happens when SNS first POSTs to the service.`,
    });
  }

  if (inputs.verifyIdentity) {
    plan.push({
      step: plan.length + 1,
      title: 'Create SES email identity',
      detail: `Identity: ${inputs.verifyIdentity}. Domain identities emit DNS records on stdout; addresses receive a confirmation email.`,
    });
  }

  // DMARC inbound pipeline — always provisioned
  plan.push(
    {
      step: plan.length + 1,
      title: 'Create DMARC S3 bucket',
      detail: inputs.dmarcBucket,
    },
    {
      step: plan.length + 2,
      title: 'Create DMARC SNS topic',
      detail: dmarcSnsTopicName(inputs.stage),
    },
    {
      step: plan.length + 3,
      title: 'Verify DMARC receiving domain',
      detail: `${inputs.dmarcDomain} — SES inbound domain identity`,
    },
    {
      step: plan.length + 4,
      title: 'Create SES receipt rule set',
      detail: dmarcReceiptRuleSetName(),
    },
    {
      step: plan.length + 5,
      title: 'Create SES receipt rule',
      detail: `${dmarcReceiptRuleName(inputs.stage)} — stores DMARC reports to S3, notifies SNS`,
    },
    {
      step: plan.length + 6,
      title: 'Subscribe DMARC webhook to SNS topic',
      detail: `${dmarcWebhookUrl(inputs.publicUrl)} → ${dmarcSnsTopicName(inputs.stage)}`,
    },
  );

  return plan;
}

export function renderPlan(plan: PlanLine[]): string {
  const lines: string[] = [];
  for (const p of plan) {
    lines.push(`  ${p.step}. ${p.title}`);
    lines.push(`     ${p.detail}`);
  }
  return lines.join('\n');
}
