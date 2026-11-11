import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  IAMClient,
  SimulatePrincipalPolicyCommand,
} from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { runPreflight, REQUIRED_ACTIONS } from '../lib/preflight';

const iamMock = mockClient(IAMClient);
const stsMock = mockClient(STSClient);

const IDENTITY = {
  Account: '123456789012',
  Arn: 'arn:aws:iam::123456789012:user/admin',
  UserId: 'AIDAEXAMPLE',
};

describe('preflight', () => {
  beforeEach(() => {
    iamMock.reset();
    stsMock.reset();
  });
  afterEach(() => {
    iamMock.reset();
    stsMock.reset();
  });

  it('passes when SimulatePrincipalPolicy marks every action allowed', async () => {
    stsMock.on(GetCallerIdentityCommand).resolves(IDENTITY);
    iamMock.on(SimulatePrincipalPolicyCommand).resolves({
      EvaluationResults: REQUIRED_ACTIONS.map((action) => ({
        EvalActionName: action,
        EvalDecision: 'allowed',
      })),
    });

    const sts = new STSClient({ region: 'us-east-1' });
    const iam = new IAMClient({ region: 'us-east-1' });

    const result = await runPreflight({ sts, iam });
    expect(result.identity.accountId).toBe('123456789012');
    expect(result.simulateSkipped).toBe(false);
    expect(result.deniedActions).toEqual([]);
  });

  it('fails with the denied action named when one action is denied', async () => {
    stsMock.on(GetCallerIdentityCommand).resolves(IDENTITY);
    iamMock.on(SimulatePrincipalPolicyCommand).resolves({
      EvaluationResults: REQUIRED_ACTIONS.map((action) => ({
        EvalActionName: action,
        EvalDecision: action === 'iam:CreatePolicy' ? 'explicitDeny' : 'allowed',
      })),
    });

    const sts = new STSClient({ region: 'us-east-1' });
    const iam = new IAMClient({ region: 'us-east-1' });

    const result = await runPreflight({ sts, iam });
    expect(result.simulateSkipped).toBe(false);
    expect(result.deniedActions).toEqual(['iam:CreatePolicy']);
  });

  it('falls back gracefully when SimulatePrincipalPolicy itself is AccessDenied', async () => {
    stsMock.on(GetCallerIdentityCommand).resolves(IDENTITY);
    const accessDenied = Object.assign(new Error('User is not allowed to perform sts action'), {
      name: 'AccessDenied',
    });
    iamMock.on(SimulatePrincipalPolicyCommand).rejects(accessDenied);

    const sts = new STSClient({ region: 'us-east-1' });
    const iam = new IAMClient({ region: 'us-east-1' });

    const result = await runPreflight({ sts, iam });
    expect(result.simulateSkipped).toBe(true);
    expect(result.deniedActions).toBeNull();
    expect(result.identity.arn).toBe(IDENTITY.Arn);
  });

  it('throws when GetCallerIdentity returns incomplete data', async () => {
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    const sts = new STSClient({ region: 'us-east-1' });
    const iam = new IAMClient({ region: 'us-east-1' });

    await expect(runPreflight({ sts, iam })).rejects.toThrow(/incomplete/);
  });
});
