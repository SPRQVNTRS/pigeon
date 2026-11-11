/**
 * Pins the retention limits of every place that holds inbound mail data:
 * each limit plus the task cadence stays within 7 days, and the scheduled
 * task that enforces them is registered and enabled.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('#drizzle/db', () => ({ db: {} }));

const limits = await import('#app/lib/inbound/retention-limits');
const { INBOUND_QUEUES } = await import('#app/lib/inbound/retention');
const { scheduledTasks } = await import('#app/scheduled-tasks/tasks');
const { buildInboundLifecycleRules } = await import('../scripts/lib/inbound-plan');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const cadence = limits.INBOUND_RETENTION_INTERVAL_MINUTES * 60 * 1000;

describe('inbound retention limits', () => {
  it('pins the values', () => {
    expect(limits.INBOUND_HARD_LIMIT_MS).toBe(7 * DAY);
    expect(limits.INBOUND_EMAIL_ROW_RETENTION_MS).toBe(7 * DAY - HOUR);
    expect(limits.INBOUND_FINISHED_JOB_RETENTION_MS).toBe(HOUR);
    expect(limits.INBOUND_JOB_MAX_AGE_MS).toBe(2 * DAY);
    expect(limits.INBOUND_S3_EXPIRATION_DAYS).toBe(6);
    expect(limits.INBOUND_RETENTION_INTERVAL_MINUTES).toBe(15);
    expect(INBOUND_QUEUES).toEqual(['inbound.process', 'webhook.deliver.inbound']);
  });

  it.each([
    ['inbound_emails rows', () => limits.INBOUND_EMAIL_ROW_RETENTION_MS],
    ['finished inbound jobs', () => limits.INBOUND_FINISHED_JOB_RETENTION_MS],
    ['inbound jobs in any state', () => limits.INBOUND_JOB_MAX_AGE_MS],
  ])('%s: limit plus task cadence stays within 7 days', (_name, limit) => {
    expect(limit() + cadence).toBeLessThanOrEqual(limits.INBOUND_HARD_LIMIT_MS);
  });

  it('S3 lifecycle: S3 expires at the next 00:00 UTC after N days, so N + 1 days stays within 7 days', () => {
    expect((limits.INBOUND_S3_EXPIRATION_DAYS + 1) * DAY).toBeLessThanOrEqual(limits.INBOUND_HARD_LIMIT_MS);
    expect(buildInboundLifecycleRules()).toEqual([
      { ID: 'expire-incoming', Status: 'Enabled', Filter: { Prefix: 'incoming/' }, Expiration: { Days: 6 } },
    ]);
  });

  it('registers the inbound-retention task, enabled, on the pinned cadence', () => {
    const task = scheduledTasks.find((t) => t.name === 'inbound-retention');
    expect(task?.enabled).toBe(true);
    expect(task?.cron).toBe('*/15 * * * *');
    expect(limits.INBOUND_RETENTION_CRON).toBe('*/15 * * * *');
  });
});
