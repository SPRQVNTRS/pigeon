/**
 * SES v2 Client — singleton per region
 *
 * One shared SESv2Client instance per region, created once per process.
 * Credentials read from CONFIG; fallback to AWS_* env vars picked up by
 * the SDK automatically when the explicit values are empty strings.
 */

import { SESv2Client } from '@aws-sdk/client-sesv2';
import { CONFIG } from '#config';

const clients = new Map<string, SESv2Client>();

/**
 * Return (or lazily create) the SESv2Client for the given region.
 * Defaults to CONFIG.aws.region when no region is supplied.
 */
export function getSesClient(region: string = CONFIG.aws.region): SESv2Client {
  const existing = clients.get(region);
  if (existing) return existing;

  const credentials =
    CONFIG.aws.accessKeyId && CONFIG.aws.secretAccessKey
      ? {
          accessKeyId: CONFIG.aws.accessKeyId,
          secretAccessKey: CONFIG.aws.secretAccessKey,
        }
      : undefined;

  const client = new SESv2Client({ region, credentials });
  clients.set(region, client);
  return client;
}

/**
 * Reset all cached clients — useful in tests.
 */
export function resetSesClients(): void {
  clients.clear();
}
