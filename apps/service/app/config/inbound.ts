import { parseSnsTopicArn } from './sns-topic-arn';

/**
 * INBOUND_SNS_TOPIC_ARN: the only SNS topic the inbound route accepts. Unset
 * (or empty) turns inbound mail off: the route answers 503. A set but invalid
 * value fails at startup, so a typo cannot silently drop every reply.
 */
export function parseInboundSnsTopicArn(raw: string | undefined): string | undefined {
  return parseSnsTopicArn({ raw, envName: 'INBOUND_SNS_TOPIC_ARN' });
}
