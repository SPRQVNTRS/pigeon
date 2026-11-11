/**
 * Names of the pg-boss queues whose job data holds mail content or recipient
 * addresses. One definition, because three places must agree on them: the
 * workers that register the queues, the job pruning task and the recipient
 * erase.
 */
export const EMAIL_SEND_QUEUE = 'email.send';
export const WEBHOOK_DELIVER_QUEUE = 'webhook.deliver';
export const SES_EVENT_QUEUE = 'ses.event.process';

/**
 * Inbound mail (SES receiving). `inbound.process` carries only ids; the
 * `email.received` deliveries on `webhook.deliver.inbound` carry the body.
 * Both are pruned by the inbound-retention task, much faster than the queues
 * above (see app/lib/inbound/retention.ts). The deliveries have their own
 * queue so a burst of junk mail cannot starve bounce and complaint deliveries
 * on `webhook.deliver`.
 */
export const INBOUND_PROCESS_QUEUE = 'inbound.process';
export const WEBHOOK_DELIVER_INBOUND_QUEUE = 'webhook.deliver.inbound';
