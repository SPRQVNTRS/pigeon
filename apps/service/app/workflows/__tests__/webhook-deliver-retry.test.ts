/**
 * webhook.deliver retries, against a real pg-boss: a refused target ends the
 * job after one attempt, and a network failure still goes to retry.
 *
 * Uses a real pg-boss instance against the local database, isolated in its own
 * schema (pgboss_webhook_retry_test) that is dropped on teardown, like
 * pgboss-queue-registration.test.ts. node:dns and the drizzle client are
 * mocked, so no lookup or webhook row is touched.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';

// Load .env before any CONFIG-dependent imports
config({ path: resolve(import.meta.dirname, '../../../.env') });

import { PgBoss } from 'pg-boss';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

vi.mock('#drizzle/db', () => ({
  db: { update: () => ({ set: () => ({ where: async () => undefined }) }) },
}));

const mockLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

import { registerWebhookDeliverWorker, WEBHOOK_DELIVER_QUEUE } from '../webhook-deliver';
import { WEBHOOK_DELIVER_RETRY_OPTIONS } from '#app/lib/webhook-fanout';

const SCHEMA = 'pgboss_webhook_retry_test';
const TIMEOUT = 30_000;

function buildConnectionString(): string {
  const host = process.env.DB_HOST ?? 'localhost';
  const port = process.env.DB_PORT ?? '5432';
  const user = process.env.DB_USER ?? 'postgres';
  const password = process.env.DB_PASSWORD ?? 'postgres';
  const name = process.env.DB_NAME ?? 'email_service';
  return `postgres://${user}:${password}@${host}:${port}/${name}`;
}

function deliveryJob(url: string) {
  return {
    webhookId: 'wh_retry_test',
    url,
    signingSecret: 'secret',
    eventType: 'email.bounced',
    payload: { id: 'evt_retry_test', type: 'email.bounced' },
  };
}

describe('webhook.deliver retries (real pg-boss)', () => {
  let boss: PgBoss;

  /** Polls the job until `isDone` holds for it, or the test times out. */
  async function waitForJob(opts: {
    id: string;
    isDone: (job: { state: string; retryCount: number }) => boolean;
  }): Promise<{ state: string; retryCount: number; output: unknown }> {
    const deadline = Date.now() + TIMEOUT - 5_000;
    while (Date.now() < deadline) {
      const job = await boss.getJobById(WEBHOOK_DELIVER_QUEUE, opts.id);
      if (job && opts.isDone(job)) return job;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    throw new Error(`job ${opts.id} did not reach the expected state in time`);
  }

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: buildConnectionString(), schema: SCHEMA });
    await boss.start();
    await registerWebhookDeliverWorker(boss as unknown as Parameters<typeof registerWebhookDeliverWorker>[0]);
  }, TIMEOUT);

  afterEach(() => {
    mockLookup.mockReset();
  });

  afterAll(async () => {
    await boss.offWork(WEBHOOK_DELIVER_QUEUE);
    await boss.stop();
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: buildConnectionString() });
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  }, TIMEOUT);

  it(
    'completes a refused target after exactly one attempt, with the reason as output',
    async () => {
      const id = await boss.send(
        WEBHOOK_DELIVER_QUEUE,
        deliveryJob('http://169.254.169.254/latest/meta-data/'),
        WEBHOOK_DELIVER_RETRY_OPTIONS,
      );
      if (!id) throw new Error('pg-boss returned no job id');

      const job = await waitForJob({
        id,
        isDone: (current) => current.state !== 'created' && current.state !== 'active',
      });
      expect(job.state).toBe('completed');
      expect(job.retryCount).toBe(0);
      expect(job.output).toEqual({
        outcome: 'refused',
        message: 'Target refused: 169.254.169.254 is a non-public address',
      });
      expect(mockLookup).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it(
    'still retries a network failure',
    async () => {
      mockLookup.mockRejectedValue(
        Object.assign(new Error('getaddrinfo ENOTFOUND nx.example.com'), { code: 'ENOTFOUND' }),
      );
      const id = await boss.send(
        WEBHOOK_DELIVER_QUEUE,
        deliveryJob('https://nx.example.com/hook'),
        WEBHOOK_DELIVER_RETRY_OPTIONS,
      );
      if (!id) throw new Error('pg-boss returned no job id');

      const job = await waitForJob({ id, isDone: (current) => current.state === 'retry' || current.retryCount > 0 });
      expect(job.state).not.toBe('completed');
      expect(job.state).not.toBe('failed');
    },
    TIMEOUT,
  );
});
