/**
 * Admin-side AWS clients for the bootstrap scripts.
 *
 * These are deliberately separate from `app/lib/ses/client.ts` (which reads
 * CONFIG env vars like AWS_ACCESS_KEY_ID that likely are not set before this
 * script runs). Instead, we rely on the default AWS SDK credential chain:
 * env vars, then `~/.aws/credentials`, then instance metadata, etc.
 */

import { IAMClient } from '@aws-sdk/client-iam';
import { SESClient } from '@aws-sdk/client-ses';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SNSClient } from '@aws-sdk/client-sns';
import { STSClient } from '@aws-sdk/client-sts';
import { S3Client } from '@aws-sdk/client-s3';

export interface AdminAwsClients {
  iam: IAMClient;
  s3: S3Client;
  ses: SESv2Client;
  sesV1: SESClient;
  sns: SNSClient;
  sts: STSClient;
}

/**
 * Build a set of admin AWS clients bound to the given region.
 *
 * STS and IAM are global services — IAM's us-east-1 region is conventional,
 * but the SDK accepts any region and routes correctly. We pass through the
 * region the user selected for operator clarity.
 */
export function buildAdminClients(region: string): AdminAwsClients {
  return {
    iam: new IAMClient({ region }),
    s3: new S3Client({ region }),
    ses: new SESv2Client({ region }),
    sesV1: new SESClient({ region }),
    sns: new SNSClient({ region }),
    sts: new STSClient({ region }),
  };
}
