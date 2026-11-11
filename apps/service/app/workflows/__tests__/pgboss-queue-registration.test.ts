/**
 * Regression test: pg-boss queue registration round-trip
 *
 * Proves the observable difference in pg-boss v12 between an unregistered
 * and a registered queue:
 *   - Before createQueue:  boss.send() throws "Queue <name> does not exist"
 *   - After register*Worker (which calls createQueue first): boss.send()
 *     succeeds and returns a non-null job ID.
 *
 * Uses a real pg-boss instance against the local dev database, isolated in a
 * dedicated schema (pgboss_regtest) that is dropped on teardown.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';

// Load .env before any CONFIG-dependent imports
config({ path: resolve(import.meta.dirname, '../../../.env') });

import { PgBoss } from 'pg-boss';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerEmailSendWorker } from '../email-send';
import { registerDomainVerifyWorker } from '../domain-verify';
import {
  registerSesEventProcessWorker,
  type BossWorker as SesEventBossWorker,
} from '../ses-event-process';
import { registerWebhookDeliverWorker } from '../webhook-deliver';

// pg-boss polling can be slow in test environments
const TIMEOUT = 15_000;

function buildConnectionString(): string {
  const host = process.env.DB_HOST ?? 'localhost';
  const port = process.env.DB_PORT ?? '5432';
  const user = process.env.DB_USER ?? 'postgres';
  const password = process.env.DB_PASSWORD ?? 'postgres';
  const name = process.env.DB_NAME ?? 'email_service';
  return `postgres://${user}:${password}@${host}:${port}/${name}`;
}

describe('pg-boss queue registration (real round-trip)', () => {
  let boss: PgBoss;

  beforeAll(async () => {
    boss = new PgBoss({
      connectionString: buildConnectionString(),
      schema: 'pgboss_regtest', // isolated schema — won't clobber dev pgboss schema
    });
    await boss.start();
  }, 30_000);

  afterAll(async () => {
    await boss.stop();
    // Drop the test schema for clean re-runs
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: buildConnectionString() });
    await pool.query('DROP SCHEMA IF EXISTS pgboss_regtest CASCADE');
    await pool.end();
  }, 15_000);

  it('email.send: send throws before createQueue, succeeds after register', async () => {
    // pg-boss v12 throws when the queue row doesn't exist — no silent null
    await expect(boss.send('email.send', { _test: true })).rejects.toThrow(
      /Queue email\.send does not exist/,
    );

    await registerEmailSendWorker(boss as unknown as Parameters<typeof registerEmailSendWorker>[0]);

    const after = await boss.send('email.send', { _test: true });
    expect(after).not.toBeNull(); // queue exists now — valid job ID returned

    await boss.offWork('email.send');
  }, TIMEOUT);

  it('domain.verify: send throws before createQueue, succeeds after register', async () => {
    await expect(boss.send('domain.verify', { _test: true })).rejects.toThrow(
      /Queue domain\.verify does not exist/,
    );

    await registerDomainVerifyWorker(boss as unknown as Parameters<typeof registerDomainVerifyWorker>[0]);

    const after = await boss.send('domain.verify', { _test: true });
    expect(after).not.toBeNull();

    await boss.offWork('domain.verify');
  }, TIMEOUT);

  it('ses.event.process: send throws before createQueue, succeeds after register', async () => {
    await expect(boss.send('ses.event.process', { _test: true })).rejects.toThrow(
      /Queue ses\.event\.process does not exist/,
    );

    await registerSesEventProcessWorker(boss as unknown as SesEventBossWorker);

    const after = await boss.send('ses.event.process', { _test: true });
    expect(after).not.toBeNull();

    await boss.offWork('ses.event.process');
  }, TIMEOUT);

  it('webhook.deliver: send throws before createQueue, succeeds after register', async () => {
    await expect(boss.send('webhook.deliver', { _test: true })).rejects.toThrow(
      /Queue webhook\.deliver does not exist/,
    );

    await registerWebhookDeliverWorker(boss as unknown as Parameters<typeof registerWebhookDeliverWorker>[0]);

    const after = await boss.send('webhook.deliver', { _test: true });
    expect(after).not.toBeNull();

    await boss.offWork('webhook.deliver');
  }, TIMEOUT);
});
