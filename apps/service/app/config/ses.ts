import { parseSnsTopicArn } from './sns-topic-arn';

/**
 * SES_SNS_TOPIC_ARN: the only SNS topic POST /v1/webhooks/ses accepts (SES
 * delivery, bounce and complaint events). Unset (or empty) turns SES event
 * ingest off: the route answers 503 and the service still boots, so sending
 * keeps working. A set but invalid value fails at startup.
 */
export function parseSesSnsTopicArn(raw: string | undefined): string | undefined {
  return parseSnsTopicArn({ raw, envName: 'SES_SNS_TOPIC_ARN' });
}
