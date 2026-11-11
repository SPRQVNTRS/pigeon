/**
 * The runtime IAM policy is the source of truth that setup:aws reconciles the
 * live policy to. The recipient erase route calls SESv2
 * DeleteSuppressedDestination, so the policy must grant it.
 */

import { describe, it, expect } from 'vitest';
import { buildRuntimePolicyDoc, dmarcWebhookUrl, runtimePolicyDocument } from '../lib/runtime-policy';

type PolicyStatement = { Sid: string; Effect: string; Action: string[]; Resource: string };

const BUCKETS = { dmarcBucket: 'example-dmarc-reports', inboundBucket: 'example-pigeon-inbound' };
const RUNTIME_POLICY_DOC = buildRuntimePolicyDoc(BUCKETS);

function allowedActions(statements: readonly PolicyStatement[]): string[] {
  return statements.filter((s) => s.Effect === 'Allow').flatMap((s) => s.Action);
}

describe('runtime policy document', () => {
  it('allows ses:DeleteSuppressedDestination for the recipient erase route', () => {
    expect(allowedActions(RUNTIME_POLICY_DOC.Statement)).toContain('ses:DeleteSuppressedDestination');
  });

  it('carries the erase statement as EraseSuppression, between ManageIdentities and ReadDmarcReports', () => {
    expect(RUNTIME_POLICY_DOC.Statement.map((s) => s.Sid)).toEqual([
      'SendMail',
      'ManageIdentities',
      'EraseSuppression',
      'ReadDmarcReports',
      'ReadInboundMail',
      'DeleteInboundMail',
    ]);
    expect(RUNTIME_POLICY_DOC.Statement[2]).toEqual({
      Sid: 'EraseSuppression',
      Effect: 'Allow',
      Action: ['ses:DeleteSuppressedDestination'],
      Resource: '*',
    });
  });

  it('serialises the erase statement into the document that setup attaches', () => {
    expect(runtimePolicyDocument(BUCKETS)).toContain('ses:DeleteSuppressedDestination');
  });

  it('names the DMARC bucket on the report read statement', () => {
    const statement = RUNTIME_POLICY_DOC.Statement.find((s) => s.Sid === 'ReadDmarcReports');
    expect(statement?.Resource).toBe('arn:aws:s3:::example-dmarc-reports/incoming/*');
  });

  it('builds the DMARC webhook URL from the public URL', () => {
    expect(dmarcWebhookUrl('https://pigeon.example.com')).toBe('https://pigeon.example.com/v1/webhooks/dmarc');
  });

  it('control: the action check fails for a document without the erase statement', () => {
    const withoutErase = RUNTIME_POLICY_DOC.Statement.filter((s) => s.Sid !== 'EraseSuppression');
    expect(allowedActions(withoutErase)).not.toContain('ses:DeleteSuppressedDestination');
  });

  it('lets the inbound worker read received mail, and nothing else in that bucket', () => {
    const statement = RUNTIME_POLICY_DOC.Statement.find((s) => s.Sid === 'ReadInboundMail');
    expect(statement).toEqual({
      Sid: 'ReadInboundMail',
      Effect: 'Allow',
      Action: ['s3:GetObject'],
      Resource: 'arn:aws:s3:::example-pigeon-inbound/incoming/*',
    });
  });

  it('lets the recipient erase delete received mail, on the incoming prefix only', () => {
    const statement = RUNTIME_POLICY_DOC.Statement.find((s) => s.Sid === 'DeleteInboundMail');
    expect(statement).toEqual({
      Sid: 'DeleteInboundMail',
      Effect: 'Allow',
      Action: ['s3:DeleteObject'],
      Resource: 'arn:aws:s3:::example-pigeon-inbound/incoming/*',
    });
    expect(runtimePolicyDocument(BUCKETS)).toContain('s3:DeleteObject');
  });
});
