/**
 * Teardown safety: the convention guard refuses to delete resources whose
 * names don't match what setup would have chosen. This protects against
 * running teardown against a hand-crafted or foreign state file.
 */

import { describe, it, expect } from 'vitest';
import { ensureNamesMatchConvention } from '../aws-teardown';
import {
  emptyStateFile,
  type StateFile,
} from '../lib/state';
import {
  configurationSetName,
  runtimePolicyName,
  runtimeUserName,
  snsTopicName,
} from '../lib/runtime-policy';

function buildGoodState(): StateFile {
  const state = emptyStateFile({
    stage: 'dev',
    region: 'eu-west-1',
    accountId: '123456789012',
    resourcePrefix: 'my-app',
  });
  state.resources.snsTopicArn =
    `arn:aws:sns:eu-west-1:123456789012:${snsTopicName('my-app', 'dev')}`;
  state.resources.configSetName = configurationSetName('my-app', 'dev');
  state.resources.iamUserName = runtimeUserName('dev');
  state.resources.iamPolicyArn = `arn:aws:iam::123456789012:policy/${runtimePolicyName('dev')}`;
  state.resources.iamAccessKeyId = 'AKIAEXAMPLE';
  state.resources.eventDestinations = ['sns-bounce', 'sns-complaint', 'sns-delivery', 'sns-reject'];
  return state;
}

describe('teardown safety — convention guard', () => {
  it('passes for state produced by the setup script', () => {
    expect(() => ensureNamesMatchConvention(buildGoodState())).not.toThrow();
  });

  it('refuses when iamUserName was tampered to a name we never create', () => {
    const state = buildGoodState();
    state.resources.iamUserName = 'some-other-user';
    expect(() => ensureNamesMatchConvention(state)).toThrow(/iamUserName/);
  });

  it('refuses when iamPolicyArn does not match our policy naming', () => {
    const state = buildGoodState();
    state.resources.iamPolicyArn = 'arn:aws:iam::123456789012:policy/foreign-policy';
    expect(() => ensureNamesMatchConvention(state)).toThrow(/iamPolicyArn/);
  });

  it('refuses when configSetName was tampered', () => {
    const state = buildGoodState();
    state.resources.configSetName = 'another-config-set';
    expect(() => ensureNamesMatchConvention(state)).toThrow(/configSetName/);
  });

  it('refuses when snsTopicArn does not match the conventional topic name', () => {
    const state = buildGoodState();
    state.resources.snsTopicArn = 'arn:aws:sns:eu-west-1:123456789012:not-our-topic';
    expect(() => ensureNamesMatchConvention(state)).toThrow(/snsTopicArn/);
  });

  it('is permissive when optional resource fields are simply absent', () => {
    const state = emptyStateFile({
      stage: 'dev',
      region: 'eu-west-1',
      accountId: '123456789012',
      resourcePrefix: 'my-app',
    });
    // With no resources recorded, the guard has nothing to check against.
    expect(() => ensureNamesMatchConvention(state)).not.toThrow();
  });
});
