/**
 * Preflight checks — identify the caller and verify they can take every
 * action we intend to take before we start creating resources.
 *
 * Two strategies:
 *   1. Primary: `iam:SimulatePrincipalPolicy` for each action.
 *   2. Fallback: if the caller cannot call SimulatePrincipalPolicy itself
 *      (a common, safe admin configuration), we log a warning and proceed
 *      best-effort — every subsequent create call will fail cleanly on
 *      `AccessDenied` and we surface that.
 */

import {
  IAMClient,
  SimulatePrincipalPolicyCommand,
} from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

/** Actions the setup script must be able to take, grouped for readable errors. */
export const REQUIRED_ACTIONS: readonly string[] = [
  // STS
  'sts:GetCallerIdentity',
  // IAM — policy
  'iam:CreatePolicy',
  'iam:GetPolicy',
  'iam:DeletePolicy',
  'iam:ListPolicyVersions',
  // IAM — user
  'iam:CreateUser',
  'iam:GetUser',
  'iam:DeleteUser',
  'iam:AttachUserPolicy',
  'iam:DetachUserPolicy',
  'iam:ListAttachedUserPolicies',
  // IAM — access key
  'iam:CreateAccessKey',
  'iam:DeleteAccessKey',
  'iam:ListAccessKeys',
  // SNS
  'sns:CreateTopic',
  'sns:DeleteTopic',
  'sns:GetTopicAttributes',
  'sns:Subscribe',
  'sns:Unsubscribe',
  'sns:ListSubscriptionsByTopic',
  // SES v2
  'ses:CreateConfigurationSet',
  'ses:GetConfigurationSet',
  'ses:DeleteConfigurationSet',
  'ses:CreateConfigurationSetEventDestination',
  'ses:GetConfigurationSetEventDestinations',
  'ses:DeleteConfigurationSetEventDestination',
  'ses:CreateEmailIdentity',
  'ses:GetEmailIdentity',
  'ses:DeleteEmailIdentity',
] as const;

export interface CallerIdentity {
  accountId: string;
  arn: string;
  userId: string;
}

export interface PreflightResult {
  identity: CallerIdentity;
  /** null when simulation was skipped (caller lacks SimulatePrincipalPolicy). */
  deniedActions: string[] | null;
  simulateSkipped: boolean;
}

/**
 * Fetch the caller identity via STS. Throws on failure — we cannot proceed
 * without knowing which account we're touching.
 */
export async function getCallerIdentity(sts: STSClient): Promise<CallerIdentity> {
  const res = await sts.send(new GetCallerIdentityCommand({}));
  if (!res.Account || !res.Arn || !res.UserId) {
    throw new Error('sts:GetCallerIdentity returned an incomplete response');
  }
  return {
    accountId: res.Account,
    arn: res.Arn,
    userId: res.UserId,
  };
}

/**
 * Run `iam:SimulatePrincipalPolicy` for `actions` against the caller's ARN.
 *
 * Returns:
 *   - `{ deniedActions: [], simulateSkipped: false }` on success, no denials.
 *   - `{ deniedActions: [...], simulateSkipped: false }` on success with denials.
 *   - `{ deniedActions: null, simulateSkipped: true }` when SimulatePrincipalPolicy
 *     itself fails with AccessDenied — the caller probably has policies that
 *     don't allow self-simulation, which is common and not blocking.
 */
export async function simulate(
  iam: IAMClient,
  callerArn: string,
  actions: readonly string[],
): Promise<{ deniedActions: string[] | null; simulateSkipped: boolean }> {
  try {
    const res = await iam.send(
      new SimulatePrincipalPolicyCommand({
        PolicySourceArn: callerArn,
        ActionNames: [...actions],
      }),
    );
    const denied: string[] = [];
    for (const r of res.EvaluationResults ?? []) {
      if (r.EvalDecision && r.EvalDecision !== 'allowed' && r.EvalActionName) {
        denied.push(r.EvalActionName);
      }
    }
    return { deniedActions: denied, simulateSkipped: false };
  } catch (err: unknown) {
    if (isAccessDenied(err)) {
      return { deniedActions: null, simulateSkipped: true };
    }
    throw err;
  }
}

/**
 * Full preflight: STS identity + SimulatePrincipalPolicy over all required actions.
 */
export async function runPreflight(args: {
  sts: STSClient;
  iam: IAMClient;
  actions?: readonly string[];
}): Promise<PreflightResult> {
  const actions = args.actions ?? REQUIRED_ACTIONS;
  const identity = await getCallerIdentity(args.sts);
  const { deniedActions, simulateSkipped } = await simulate(
    args.iam,
    identity.arn,
    actions,
  );
  return { identity, deniedActions, simulateSkipped };
}

function isAccessDenied(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  const code = (err as { Code?: unknown }).Code;
  return name === 'AccessDenied' || code === 'AccessDenied' || name === 'AccessDeniedException';
}
