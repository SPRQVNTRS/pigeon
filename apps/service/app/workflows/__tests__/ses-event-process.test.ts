/**
 * ses.event.process worker — bounce cascade test.
 *
 * Mocks the db module and pg-boss, feeds a Permanent bounce notification
 * through the handler, and asserts:
 *   - emails.status → bounced
 *   - suppressions row inserted for the recipient
 *   - contacts bulk update called (status=bounced)
 *   - webhook.deliver enqueued for each matching webhook
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Capture handles for assertions ------------------------------------
const selectQueues: unknown[][] = [];
const updateCalls: Array<{ table: unknown; set: Record<string, unknown>; where: unknown }> = [];
const insertCalls: Array<{ table: unknown; values: unknown[]; onConflict?: boolean }> = [];
const bossSendCalls: Array<{ name: string; data: unknown; options?: unknown }> = [];

// ---- DB mock ------------------------------------------------------------
// Each select() pops the next scripted result set from selectQueues.
function makeSelectChain(): unknown {
  const result = selectQueues.shift() ?? [];
  // Support both:
  //   .from().where().limit()
  //   .from().where()  (no limit — for listing webhooks)
  const awaitable = Promise.resolve(result);
  const chain = {
    then: awaitable.then.bind(awaitable),
    catch: awaitable.catch.bind(awaitable),
    limit: async () => result,
  };
  return {
    from: () => ({
      where: () => chain,
    }),
  };
}

vi.mock('#drizzle/db', () => ({
  db: {
    select: () => makeSelectChain(),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        const v = Array.isArray(values) ? values : [values];
        const entry = { table, values: v };
        return {
          onConflictDoNothing: () => {
            insertCalls.push({ ...entry, onConflict: true });
            return Promise.resolve(undefined);
          },
          returning: async () => {
            insertCalls.push(entry);
            return v;
          },
          then: (resolve: (value: unknown) => unknown) => {
            insertCalls.push(entry);
            return Promise.resolve(undefined).then(resolve);
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: (where: unknown) => {
          updateCalls.push({ table, set: data, where });
          return Promise.resolve(undefined);
        },
      }),
    }),
  },
}));

// Schema — just object identifiers that we compare by reference.
vi.mock('#drizzle/schema', () => ({
  emails: { __name: 'emails' },
  emailEvents: { __name: 'email_events' },
  suppressions: { __name: 'suppressions' },
  contacts: { __name: 'contacts' },
  webhooks: { __name: 'webhooks' },
}));

// ---- Import after mocks -------------------------------------------------
const { __test__, SES_EVENT_QUEUE: _UNUSED } = await import('../ses-event-process');
void _UNUSED;

function makeBoss() {
  return {
    createQueue: async (_name: string) => undefined,
    work: () => undefined,
    send: async (name: string, data: unknown, options?: unknown) => {
      bossSendCalls.push({ name, data, options });
      return 'job-id';
    },
  };
}

describe('ses.event.process, permanent bounce cascade', () => {
  beforeEach(() => {
    selectQueues.length = 0;
    updateCalls.length = 0;
    insertCalls.length = 0;
    bossSendCalls.length = 0;
  });

  it('writes event + suppression, flips contacts, and enqueues webhook deliveries', async () => {
    // 1st select — emails lookup by ses messageId
    selectQueues.push([
      {
        id: 'em_1',
        appId: 'app_1',
        messageId: 'ses-abc',
        status: 'sent',
      },
    ]);
    // 2nd select — webhooks lookup
    selectQueues.push([
      {
        id: 'wh_1',
        appId: 'app_1',
        url: 'https://example.com/hook',
        signingSecret: 'sek',
        eventTypes: ['*'],
        enabled: true,
      },
    ]);

    const boss = makeBoss();

    await __test__.handleSesEvent(
      {
        notification: {
          notificationType: 'Bounce',
          mail: { messageId: 'ses-abc' },
          bounce: {
            bounceType: 'Permanent',
            bounceSubType: 'General',
            bouncedRecipients: [
              { emailAddress: 'user@example.com', diagnosticCode: 'smtp; 550 5.1.1' },
            ],
            timestamp: '2026-04-20T12:00:00Z',
          },
        },
      },
      boss,
    );

    // email_events insert
    const eventsInsert = insertCalls.find(
      (c) => (c.table as { __name?: string }).__name === 'email_events',
    );
    expect(eventsInsert).toBeDefined();
    expect((eventsInsert!.values[0] as { type: string }).type).toBe('email.bounced');

    // emails update → bounced
    const emailsUpdate = updateCalls.find(
      (c) => (c.table as { __name?: string }).__name === 'emails',
    );
    expect(emailsUpdate).toBeDefined();
    expect(emailsUpdate!.set.status).toBe('bounced');

    // suppressions insert with onConflictDoNothing
    const suppressionInsert = insertCalls.find(
      (c) => (c.table as { __name?: string }).__name === 'suppressions',
    );
    expect(suppressionInsert).toBeDefined();
    expect(suppressionInsert!.onConflict).toBe(true);
    expect((suppressionInsert!.values[0] as { email: string }).email).toBe('user@example.com');
    expect((suppressionInsert!.values[0] as { reason: string }).reason).toBe('hard_bounce');

    // contacts bulk update → status=bounced
    const contactsUpdate = updateCalls.find(
      (c) => (c.table as { __name?: string }).__name === 'contacts',
    );
    expect(contactsUpdate).toBeDefined();
    expect(contactsUpdate!.set.status).toBe('bounced');
    expect(contactsUpdate!.set.bouncedAt).toBeInstanceOf(Date);
    // Unsubscribe cascade per spec
    expect(contactsUpdate!.set.unsubscribedAt).toBeInstanceOf(Date);

    // webhook.deliver enqueued
    const deliveries = bossSendCalls.filter((c) => c.name === 'webhook.deliver');
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0]!;
    expect((delivery.data as { webhookId: string }).webhookId).toBe('wh_1');
    expect((delivery.options as { retryLimit: number }).retryLimit).toBe(5);
    expect((delivery.options as { retryDelay: number }).retryDelay).toBe(1);
    expect((delivery.options as { retryBackoff: boolean }).retryBackoff).toBe(true);
  });

  it('updates emails.status to delivered on Delivery notification', async () => {
    // email row lookup
    selectQueues.push([
      { id: 'em_2', appId: 'app_2', messageId: 'ses-delivery-1', status: 'sent' },
    ]);
    // no matching webhooks
    selectQueues.push([]);

    const boss = makeBoss();

    await __test__.handleSesEvent(
      {
        notification: {
          notificationType: 'Delivery',
          mail: { messageId: 'ses-delivery-1' },
          delivery: {
            recipients: ['user@example.com'],
            timestamp: '2026-04-25T10:00:00Z',
          },
        },
      },
      boss,
    );

    // email_events insert with type=email.delivered
    const eventsInsert = insertCalls.find(
      (c) => (c.table as { __name?: string }).__name === 'email_events',
    );
    expect(eventsInsert).toBeDefined();
    expect((eventsInsert!.values[0] as { type: string }).type).toBe('email.delivered');

    // emails update → delivered
    const emailsUpdate = updateCalls.find(
      (c) => (c.table as { __name?: string }).__name === 'emails',
    );
    expect(emailsUpdate).toBeDefined();
    expect(emailsUpdate!.set.status).toBe('delivered');

    // NO suppression inserted for delivery
    const suppressionInsert = insertCalls.find(
      (c) => (c.table as { __name?: string }).__name === 'suppressions',
    );
    expect(suppressionInsert).toBeUndefined();

    // No webhook fanout (empty webhook list)
    expect(bossSendCalls).toHaveLength(0);
  });

  it('handles Delivery notification without delivery field', async () => {
    // email row lookup
    selectQueues.push([
      { id: 'em_3', appId: 'app_3', messageId: 'ses-delivery-2', status: 'sent' },
    ]);
    // no matching webhooks
    selectQueues.push([]);

    const boss = makeBoss();

    await __test__.handleSesEvent(
      {
        notification: {
          notificationType: 'Delivery',
          mail: { messageId: 'ses-delivery-2' },
          // delivery field intentionally absent
        },
      },
      boss,
    );

    // emails update → delivered (should not throw / return null)
    const emailsUpdate = updateCalls.find(
      (c) => (c.table as { __name?: string }).__name === 'emails',
    );
    expect(emailsUpdate).toBeDefined();
    expect(emailsUpdate!.set.status).toBe('delivered');

    // No suppression
    const suppressionInsert = insertCalls.find(
      (c) => (c.table as { __name?: string }).__name === 'suppressions',
    );
    expect(suppressionInsert).toBeUndefined();
  });
});

describe('ses.event.process, webhook job bytes (unchanged by the shared fan-out)', () => {
  beforeEach(() => {
    selectQueues.length = 0;
    bossSendCalls.length = 0;
    insertCalls.length = 0;
    updateCalls.length = 0;
  });

  const HOOK = { id: 'wh_1', appId: 'app_1', url: 'https://example.com/hook', signingSecret: 'sek', eventTypes: ['*'], enabled: true };

  function serialised(): string[] {
    return bossSendCalls.map((call) => {
      const data = call.data as { payload: { id: string } };
      return JSON.stringify({
        name: call.name,
        data: { ...data, payload: { ...data.payload, id: 'ID' } },
        options: call.options,
      });
    });
  }

  it('bounce: one job per recipient with the exact pre-refactor shape', async () => {
    selectQueues.push([{ id: 'em_1', appId: 'app_1', messageId: 'ses-abc', status: 'sent' }]);
    selectQueues.push([HOOK]);
    await __test__.handleSesEvent(
      {
        notification: {
          notificationType: 'Bounce',
          mail: { messageId: 'ses-abc' },
          bounce: {
            bounceType: 'Transient',
            bounceSubType: 'MailboxFull',
            bouncedRecipients: [{ emailAddress: 'a@example.com', diagnosticCode: 'smtp; 452' }, { emailAddress: 'b@example.com' }],
            timestamp: '2026-04-20T12:00:00Z',
          },
        },
      },
      makeBoss(),
    );
    const job = (recipient: string) =>
      JSON.stringify({
        name: 'webhook.deliver',
        data: {
          webhookId: 'wh_1',
          url: 'https://example.com/hook',
          signingSecret: 'sek',
          eventType: 'email.bounced',
          payload: {
            id: 'ID',
            type: 'email.bounced',
            organization_id: 'app_1',
            email_id: 'em_1',
            occurred_at: '2026-04-20T12:00:00.000Z',
            data: { recipient, bounce_type: 'Transient', bounce_subtype: 'MailboxFull', diagnostic_code: 'smtp; 452' },
          },
        },
        options: { retryLimit: 5, retryDelay: 1, retryBackoff: true },
      });
    expect(serialised()).toEqual([job('a@example.com'), job('b@example.com')]);
    const ids = bossSendCalls.map((call) => (call.data as { payload: { id: string } }).payload.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('complaint: exact shape on webhook.deliver', async () => {
    selectQueues.push([{ id: 'em_2', appId: 'app_1', messageId: 'ses-def', status: 'sent' }]);
    selectQueues.push([HOOK]);
    await __test__.handleSesEvent(
      {
        notification: {
          notificationType: 'Complaint',
          mail: { messageId: 'ses-def' },
          complaint: {
            complainedRecipients: [{ emailAddress: 'c@example.com' }],
            complaintFeedbackType: 'abuse',
            timestamp: '2026-04-21T08:00:00Z',
          },
        },
      },
      makeBoss(),
    );
    expect(serialised()).toEqual([
      JSON.stringify({
        name: 'webhook.deliver',
        data: {
          webhookId: 'wh_1',
          url: 'https://example.com/hook',
          signingSecret: 'sek',
          eventType: 'email.complained',
          payload: {
            id: 'ID',
            type: 'email.complained',
            organization_id: 'app_1',
            email_id: 'em_2',
            occurred_at: '2026-04-21T08:00:00.000Z',
            data: { recipient: 'c@example.com', complaint_feedback_type: 'abuse' },
          },
        },
        options: { retryLimit: 5, retryDelay: 1, retryBackoff: true },
      }),
    ]);
  });
});
