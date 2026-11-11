/**
 * Child-process probe for test/log-shape.test.ts. It writes one line through
 * the real application logger so the test can read what an operator would see
 * on stdout. Kept out of the test process so NODE_ENV and the service name
 * are exactly what the test sets.
 */
import { createComponentLogger } from '#app/lib/logger';

createComponentLogger('SnsWebhookRoute').info('Enqueued SES event', { messageId: 'message-1' });
