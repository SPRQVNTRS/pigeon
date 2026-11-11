/**
 * SNS signature verifier tests.
 *
 * Rather than commit a fixed RSA keypair, we generate a fresh keypair per test
 * run and produce a signed SNS message we know is valid. This also exercises
 * the exact signing logic a real SNS server uses (openssl / RSA-SHA256).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { verifySnsMessage, resetSnsCertCache, type SnsEnvelope } from '../verifier';

function signEnvelope(
  envelope: Omit<SnsEnvelope, 'Signature' | 'SigningCertURL' | 'SignatureVersion'>,
  privateKey: string,
): string {
  const fields =
    envelope.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  let stringToSign = '';
  for (const key of fields) {
    const value = (envelope as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    stringToSign += `${key}\n${String(value)}\n`;
  }
  const signer = createSign('RSA-SHA256');
  signer.update(stringToSign, 'utf8');
  signer.end();
  return signer.sign(privateKey, 'base64');
}

describe('verifySnsMessage', () => {
  const certUrl = 'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-abcdef.pem';
  let publicKey: string;
  let privateKey: string;

  beforeEach(() => {
    resetSnsCertCache();
    const kp = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    publicKey = kp.publicKey;
    privateKey = kp.privateKey;
  });

  it('accepts a correctly signed Notification', async () => {
    const unsigned = {
      Type: 'Notification' as const,
      MessageId: 'mid-1',
      TopicArn: 'arn:aws:sns:eu-central-1:111:topic',
      Message: '{"notificationType":"Bounce"}',
      Timestamp: '2026-04-20T00:00:00Z',
      Subject: 'test',
    };
    const signature = signEnvelope(unsigned, privateKey);
    const envelope: SnsEnvelope = {
      ...unsigned,
      SignatureVersion: '2',
      Signature: signature,
      SigningCertURL: certUrl,
    };

    const ok = await verifySnsMessage(envelope, {
      fetchCert: async () => publicKey,
    });
    expect(ok).toBe(true);
  });

  it('rejects a tampered signature', async () => {
    const unsigned = {
      Type: 'Notification' as const,
      MessageId: 'mid-2',
      TopicArn: 'arn:aws:sns:eu-central-1:111:topic',
      Message: '{"notificationType":"Bounce"}',
      Timestamp: '2026-04-20T00:00:00Z',
    };
    const signature = signEnvelope(unsigned, privateKey);
    // Flip the last base64 character to break it
    const tampered = signature.slice(0, -2) + (signature.slice(-2) === 'AA' ? 'BB' : 'AA');
    const envelope: SnsEnvelope = {
      ...unsigned,
      SignatureVersion: '2',
      Signature: tampered,
      SigningCertURL: certUrl,
    };

    const ok = await verifySnsMessage(envelope, {
      fetchCert: async () => publicKey,
    });
    expect(ok).toBe(false);
  });

  it('rejects a cert URL that is not an AWS SNS URL', async () => {
    const envelope: SnsEnvelope = {
      Type: 'Notification',
      MessageId: 'mid-3',
      TopicArn: 'arn:aws:sns:eu-central-1:111:topic',
      Message: '{}',
      Timestamp: '2026-04-20T00:00:00Z',
      SignatureVersion: '2',
      Signature: 'AAAA',
      SigningCertURL: 'https://evil.example.com/cert.pem',
    };

    await expect(
      verifySnsMessage(envelope, { fetchCert: async () => publicKey }),
    ).rejects.toThrow(/Invalid SigningCertURL/);
  });
});
