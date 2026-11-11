/**
 * Shape check for a raw SNS HTTPS body. Pure: no I/O, no signature check.
 */

import type { SnsEnvelope } from './verifier';

/**
 * Parse the raw body of an SNS POST. Returns null when it is not JSON or lacks
 * the string fields every SNS message carries (Type, TopicArn, Signature,
 * SigningCertURL). The caller checks the topic and the signature after this.
 */
export function parseSnsEnvelope(rawBody: string): SnsEnvelope | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object') return null;
  const candidate = envelope as Partial<SnsEnvelope>;
  const isEnvelope =
    typeof candidate.Type === 'string' &&
    typeof candidate.TopicArn === 'string' &&
    typeof candidate.Signature === 'string' &&
    typeof candidate.SigningCertURL === 'string';
  return isEnvelope ? (candidate as SnsEnvelope) : null;
}
