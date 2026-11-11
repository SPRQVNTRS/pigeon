/**
 * S3 Client — singleton with credential chain matching SES/SNS clients.
 *
 * Uses the same AWS credential pattern as apps/service/app/lib/ses/client.ts:
 * explicit accessKeyId/secretAccessKey from CONFIG when present, otherwise
 * falls back to the AWS SDK default credential chain (env vars / IAM role).
 */

import { Readable } from 'node:stream';
import { S3Client, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { CONFIG } from '#config';

const s3Clients = new Map<string, S3Client>();

/**
 * Return (or lazily create) the S3Client for the given region.
 * Defaults to CONFIG.aws.region.
 */
export function getS3Client(region: string = CONFIG.aws.region): S3Client {
  const existing = s3Clients.get(region);
  if (existing) return existing;

  const credentials =
    CONFIG.aws.accessKeyId && CONFIG.aws.secretAccessKey
      ? {
          accessKeyId: CONFIG.aws.accessKeyId,
          secretAccessKey: CONFIG.aws.secretAccessKey,
        }
      : undefined;

  const client = new S3Client({ region, credentials });
  s3Clients.set(region, client);
  return client;
}

export interface S3ObjectStream {
  body: Readable;
  /** Size from the GetObject answer (Content-Length); null when S3 sent none. */
  contentLength: number | null;
}

/**
 * Open an S3 object as a Node stream, without buffering it.
 *
 * @throws on S3 errors (e.g. 403, NoSuchKey); see isS3NotFound
 */
export async function openS3Object(bucket: string, key: string): Promise<S3ObjectStream> {
  const response = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) {
    throw new Error(`S3 object ${bucket}/${key} returned empty body`);
  }
  const body = response.Body instanceof Readable ? response.Body : Readable.from(response.Body as AsyncIterable<Uint8Array>);
  return { body, contentLength: response.ContentLength ?? null };
}

/**
 * Delete one S3 object. S3 answers success for a key that does not exist, so a
 * repeat is safe. Needs s3:DeleteObject (DeleteInboundMail in
 * scripts/lib/runtime-policy.ts for the inbound bucket).
 *
 * @throws on S3 errors (e.g. 403)
 */
export async function deleteS3Object(opts: { bucket: string; key: string }): Promise<void> {
  await getS3Client().send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: opts.key }));
}

/** True when S3 says the object (or key) does not exist. */
export function isS3NotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: string }).name;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

/**
 * Whether an S3 object still exists (HeadObject; authorised by s3:GetObject).
 *
 * @throws on S3 errors other than not-found
 */
export async function s3ObjectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (isS3NotFound(err)) return false;
    throw err;
  }
}
