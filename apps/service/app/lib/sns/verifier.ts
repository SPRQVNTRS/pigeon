/**
 * AWS SNS message signature verification.
 *
 * Verifies that an incoming HTTPS POST body originated from AWS SNS.
 *
 * Security properties:
 *   1. `SigningCertURL` MUST match `^https://sns\.[a-z0-9-]+\.amazonaws\.com/` —
 *      rejects arbitrary URLs that could return attacker-controlled certs.
 *   2. Signed-string field list is per-message-type (per AWS docs):
 *        - Notification:                  Message, MessageId, Subject?, Timestamp, TopicArn, Type
 *        - SubscriptionConfirmation:      Message, MessageId, SubscribeURL, Timestamp, Token, TopicArn, Type
 *        - UnsubscribeConfirmation:       (same as SubscriptionConfirmation)
 *   3. Supports SignatureVersion 1 (SHA1) and 2 (SHA256); v2 is preferred.
 *   4. Fetched X.509 certs are cached in-memory by URL.
 *
 * References:
 *   - https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */

import { createVerify, type VerifyPublicKeyInput } from 'node:crypto';

/**
 * Minimal structural type for an SNS envelope. Extra fields are tolerated.
 */
export interface SnsEnvelope {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation' | string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  Signature: string;
  SigningCertURL: string;
  SignatureVersion: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
  UnsubscribeURL?: string;
}

const CERT_URL_PATTERN = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//;

// Field ordering per AWS spec.
const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const;
const CONFIRMATION_FIELDS = [
  'Message',
  'MessageId',
  'SubscribeURL',
  'Timestamp',
  'Token',
  'TopicArn',
  'Type',
] as const;

// Cert cache keyed by URL.  Plain Map — the cert content is immutable per URL
// and SNS rotates certs rarely; we don't need TTL for this to be correct.
const certCache = new Map<string, string>();

/**
 * Reset the in-memory cert cache. Intended for tests.
 */
export function resetSnsCertCache(): void {
  certCache.clear();
}

/**
 * Fetcher for the signing cert. Pluggable for tests.
 */
export type CertFetcher = (url: string) => Promise<string>;

async function defaultCertFetcher(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch SNS cert at ${url}: ${res.status}`);
  }
  return res.text();
}

function isValidCertUrl(url: string): boolean {
  return CERT_URL_PATTERN.test(url);
}

/**
 * Build the canonical string-to-sign for an SNS message.
 * Per AWS: `<key>\n<value>\n` repeated for each field in the fixed order,
 * skipping fields whose value is absent (only `Subject` on notifications).
 */
function buildStringToSign(msg: SnsEnvelope): string {
  const fields: readonly string[] =
    msg.Type === 'Notification' ? NOTIFICATION_FIELDS : CONFIRMATION_FIELDS;

  let out = '';
  for (const key of fields) {
    const value = (msg as unknown as Record<string, unknown>)[key];
    // Subject is the only optional field; if missing we skip entirely.
    if (key === 'Subject' && (value === undefined || value === null)) continue;
    if (value === undefined || value === null) continue;
    out += `${key}\n${String(value)}\n`;
  }
  return out;
}

function selectAlgorithm(signatureVersion: string): 'RSA-SHA1' | 'RSA-SHA256' {
  if (signatureVersion === '2') return 'RSA-SHA256';
  if (signatureVersion === '1') return 'RSA-SHA1';
  throw new Error(`Unsupported SNS SignatureVersion: ${signatureVersion}`);
}

export interface VerifyOptions {
  /** Override cert fetcher (for tests). */
  fetchCert?: CertFetcher;
}

/**
 * Verify an SNS message signature. Returns true iff the signature is valid
 * and the cert URL originates from AWS SNS.
 *
 * Does NOT throw on an invalid signature — returns false.  Throws only on
 * structural errors (bad cert URL, bad version, fetch failure).
 */
export async function verifySnsMessage(
  msg: SnsEnvelope,
  opts: VerifyOptions = {},
): Promise<boolean> {
  if (!isValidCertUrl(msg.SigningCertURL)) {
    throw new Error(`Invalid SigningCertURL: ${msg.SigningCertURL}`);
  }

  const algorithm = selectAlgorithm(msg.SignatureVersion);
  const stringToSign = buildStringToSign(msg);
  const signature = Buffer.from(msg.Signature, 'base64');

  const fetchCert = opts.fetchCert ?? defaultCertFetcher;
  let pem = certCache.get(msg.SigningCertURL);
  if (!pem) {
    pem = await fetchCert(msg.SigningCertURL);
    certCache.set(msg.SigningCertURL, pem);
  }

  const verifier = createVerify(algorithm);
  verifier.update(stringToSign, 'utf8');
  verifier.end();

  const key: VerifyPublicKeyInput = { key: pem };
  try {
    return verifier.verify(key, signature);
  } catch {
    return false;
  }
}
