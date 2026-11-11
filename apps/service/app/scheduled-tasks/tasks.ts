/**
 * Scheduled Tasks Definitions
 *
 * Define all scheduled tasks here. Each task specifies:
 * - name: Unique identifier (used as queue name)
 * - cron: When to run (cron expression)
 * - handler: What to execute
 * - enabled: Whether the task is active
 *
 * To add a new scheduled task:
 * 1. Create a handler in ./handlers/
 * 2. Export it from ./handlers/index.ts
 * 3. Add a task definition below
 */

import type { ScheduledTaskDefinition } from './types';
import { dummyTaskHandler } from './handlers';
import { idempotencyCleanupHandler } from './handlers';
import { dnsHealthCheckHandler } from './handlers';
import { mailRetentionHandler } from './handlers';
import { queueJobRetentionHandler } from './handlers';
import { inboundRetentionHandler } from './handlers';
import { INBOUND_RETENTION_CRON } from '#app/lib/inbound/retention';

/**
 * All scheduled task definitions.
 *
 * Set `enabled: true` to activate a task.
 * Tasks with `enabled: false` will not be scheduled.
 */
export const scheduledTasks: ScheduledTaskDefinition[] = [
  // =============================================================================
  // EXAMPLE TASKS (disabled by default)
  // =============================================================================

  {
    name: 'dummy-scheduled-task',
    cron: '*/5 * * * *', // Every 5 minutes
    description: 'Example scheduled task that logs a message',
    handler: dummyTaskHandler,
    enabled: false, // Set to true to enable
    timezone: 'UTC',
  },

  // =============================================================================
  // IDEMPOTENCY CLEANUP
  // =============================================================================

  {
    name: 'idempotency-cleanup',
    cron: '0 * * * *', // Every hour
    description: 'Delete idempotent_requests rows older than 25 hours',
    handler: idempotencyCleanupHandler,
    enabled: true,
    timezone: 'UTC',
  },

  // =============================================================================
  // DNS HEALTH CHECK
  // =============================================================================

  {
    name: 'dns-health-check',
    cron: '0 */4 * * *', // Every 4 hours
    description: 'Check DNS health for all verified pigeon domains',
    handler: dnsHealthCheckHandler,
    enabled: true,
    timezone: 'UTC',
  },

  // =============================================================================
  // MAIL RETENTION
  // =============================================================================

  {
    name: 'mail-retention',
    cron: '30 3 * * *', // Daily at 03:30 UTC
    description:
      'Apply per-app mail retention: blank bodies and delete old emails and events (apps with NULL limits are untouched)',
    handler: mailRetentionHandler,
    enabled: true,
    timezone: 'UTC',
  },

  // =============================================================================
  // QUEUE JOB RETENTION
  // =============================================================================

  {
    name: 'queue-job-retention',
    cron: '15 * * * *', // Hourly, at :15
    description:
      'Delete finished pg-boss jobs of the mail queues one day after completion (their data holds mail bodies and addresses)',
    handler: queueJobRetentionHandler,
    enabled: true,
    timezone: 'UTC',
  },

  // =============================================================================
  // INBOUND RETENTION
  // =============================================================================

  {
    name: 'inbound-retention',
    cron: INBOUND_RETENTION_CRON, // Every 15 minutes
    description:
      'Delete inbound_emails rows and inbound queue jobs before the 7-day limit (they hold recipients and mail bodies)',
    handler: inboundRetentionHandler,
    enabled: true,
    timezone: 'UTC',
  },
];
