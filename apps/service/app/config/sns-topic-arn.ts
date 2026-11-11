import { z } from 'zod';

const snsTopicArnSchema = z
  .string()
  .regex(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/, 'must be an SNS topic ARN');

/**
 * Read an optional SNS topic ARN from the environment. Unset (or empty) means
 * the feature is off and returns undefined. A set but invalid value throws at
 * startup, so a typo cannot silently drop every message.
 */
export function parseSnsTopicArn(opts: { raw: string | undefined; envName: string }): string | undefined {
  const { raw, envName } = opts;
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = snsTopicArnSchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new Error(`${envName} must be an SNS topic ARN (arn:aws:sns:<region>:<account>:<name>)`);
  }
  return parsed.data;
}
