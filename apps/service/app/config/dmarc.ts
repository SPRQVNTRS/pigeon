import { parseSnsTopicArn } from './sns-topic-arn';

/**
 * DMARC_SNS_TOPIC_ARN: the only SNS topic POST /v1/webhooks/dmarc accepts.
 * Unset (or empty) turns DMARC report ingest off: the route answers 503. A set
 * but invalid value fails at startup.
 */
export function parseDmarcSnsTopicArn(raw: string | undefined): string | undefined {
  return parseSnsTopicArn({ raw, envName: 'DMARC_SNS_TOPIC_ARN' });
}
