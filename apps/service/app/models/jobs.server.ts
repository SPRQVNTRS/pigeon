/**
 * Jobs model — pg-boss queue and scheduler inspector.
 *
 * Uses the pg-boss SDK where it exposes the needed API, falls back to
 * direct queries on pgboss.job / pgboss.schedule / pgboss.archive when
 * the SDK doesn't expose the required granularity.
 *
 * All functions call `getOrchestrator().getBoss()` so the orchestrator
 * must be initialized before these functions run (it always is in the
 * HTTP server — `initializeWorkflows()` is called before Express starts).
 */

import { pool } from '#drizzle/db';
import { getOrchestrator } from '#app/services/workflows.server';
import { scheduledTasks } from '#app/scheduled-tasks/tasks';

// ─── Types ────────────────────────────────────────────────────────────────────

export type JobStatus =
  | 'created'
  | 'active'
  | 'retry'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface ScheduledTaskInfo {
  name: string;
  cron: string;
  timezone: string;
  description: string;
  enabled: boolean;
  /** Pulled from pgboss.schedule */
  scheduledAt: Date | null;
  /** Most recent completed/failed/active job for this queue */
  lastRunAt: Date | null;
  lastRunStatus: 'success' | 'failed' | 'active' | null;
  nextRunAt: Date | null;
}

export interface QueueDepth {
  name: string;
  pending: number;
  active: number;
  retry: number;
  failed: number;
  completed: number;
}

export interface JobItem {
  id: string;
  queue: string;
  status: JobStatus;
  data: Record<string, unknown>;
  output: Record<string, unknown> | null;
  retryCount: number;
  createdOn: Date;
  startedOn: Date | null;
  completedOn: Date | null;
  /** Duration in ms, only when completedOn and startedOn are both set */
  durationMs: number | null;
  /** Error message from output.value.message or output.message */
  errorMessage: string | null;
  /** Stack trace from output.value.stack or output.stack */
  errorStack: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractError(output: Record<string, unknown> | null): {
  errorMessage: string | null;
  errorStack: string | null;
} {
  if (!output) return { errorMessage: null, errorStack: null };

  // pg-boss wraps errors in output.value for failed jobs
  const value = output.value as Record<string, unknown> | null | undefined;
  const message =
    typeof value?.message === 'string' ? value.message
    : typeof output.message === 'string' ? output.message
    : null;

  const stack =
    typeof value?.stack === 'string' ? value.stack
    : typeof output.stack === 'string' ? output.stack
    : null;

  return { errorMessage: message, errorStack: stack };
}

function mapJobRow(row: {
  id: string;
  name: string;
  state: JobStatus;
  data: Record<string, unknown>;
  output: Record<string, unknown> | null;
  retrycount: number | string;
  createdon: Date;
  startedon: Date | null;
  completedon: Date | null;
}): JobItem {
  const startedOn = row.startedon ?? null;
  const completedOn = row.completedon ?? null;
  const durationMs =
    startedOn && completedOn ?
      new Date(completedOn).getTime() - new Date(startedOn).getTime()
    : null;

  const { errorMessage, errorStack } = extractError(row.output);

  return {
    id: row.id,
    queue: row.name,
    status: row.state,
    data: row.data ?? {},
    output: row.output,
    retryCount: Number(row.retrycount),
    createdOn: new Date(row.createdon),
    startedOn: startedOn ? new Date(startedOn) : null,
    completedOn: completedOn ? new Date(completedOn) : null,
    durationMs,
    errorMessage,
    errorStack,
  };
}

// ─── Exported functions ───────────────────────────────────────────────────────

/**
 * Returns scheduled task definitions enriched with runtime info from
 * pg-boss (last run, next run, current schedule).
 */
export async function listScheduledTasks(): Promise<ScheduledTaskInfo[]> {
  const boss = getOrchestrator().getBoss();

  // Get all pg-boss schedules
  const pgSchedules = await boss.getSchedules();
  const scheduleMap = new Map(pgSchedules.map((s) => [s.name, s]));

  // Get the most recent job per scheduled-task queue (live + archive)
  // We join live jobs with a per-name sort then fall back to archive
  const liveResult = await pool.query<{
    name: string;
    state: JobStatus;
    startedon: Date | null;
    completedon: Date | null;
  }>(
    `SELECT DISTINCT ON (name)
       name,
       state,
       startedon,
       completedon
     FROM pgboss.job
     WHERE name = ANY($1::text[])
     ORDER BY name, createdon DESC`,
    [scheduledTasks.map((t) => t.name)],
  );

  const liveJobMap = new Map(liveResult.rows.map((r) => [r.name, r]));

  // For tasks not found in live table, check archive
  const archiveMissing = scheduledTasks
    .map((t) => t.name)
    .filter((n) => !liveJobMap.has(n));

  if (archiveMissing.length > 0) {
    const archiveResult = await pool.query<{
      name: string;
      state: 'completed' | 'failed' | 'expired' | 'cancelled';
      completedon: Date | null;
    }>(
      `SELECT DISTINCT ON (name)
         name,
         state,
         completedon
       FROM pgboss.archive
       WHERE name = ANY($1::text[])
       ORDER BY name, completedon DESC NULLS LAST`,
      [archiveMissing],
    );

    for (const r of archiveResult.rows) {
      if (!liveJobMap.has(r.name)) {
        liveJobMap.set(r.name, {
          name: r.name,
          state: r.state as JobStatus,
          startedon: null,
          completedon: r.completedon,
        });
      }
    }
  }

  return scheduledTasks.map((task) => {
    const pgSchedule = scheduleMap.get(task.name);
    const lastJob = liveJobMap.get(task.name);

    let lastRunAt: Date | null = null;
    let lastRunStatus: 'success' | 'failed' | 'active' | null = null;

    if (lastJob) {
      const ts = lastJob.completedon ?? lastJob.startedon ?? null;
      lastRunAt = ts ? new Date(ts) : null;
      if (lastJob.state === 'completed') lastRunStatus = 'success';
      else if (lastJob.state === 'failed') lastRunStatus = 'failed';
      else if (lastJob.state === 'active') lastRunStatus = 'active';
    }

    return {
      name: task.name,
      cron: task.cron,
      timezone: task.timezone ?? 'UTC',
      description: task.description,
      enabled: task.enabled !== false,
      scheduledAt: pgSchedule ? null : null, // pg-boss doesn't expose next_run in getSchedules()
      lastRunAt,
      lastRunStatus,
      nextRunAt: null, // pg-boss schedule table doesn't expose nextRunAt via SDK
    };
  });
}

/**
 * Detailed queue depths from pgboss.job table (all states per queue).
 * This replaces the less-informative `getQueues()` SDK call which doesn't
 * expose retry/failed counts.
 */
export async function getDetailedQueueDepths(): Promise<QueueDepth[]> {
  const result = await pool.query<{
    name: string;
    state: JobStatus;
    count: string;
  }>(
    `SELECT name, state, COUNT(*)::int as count
     FROM pgboss.job
     GROUP BY name, state
     ORDER BY name, state`,
  );

  const depthMap = new Map<string, QueueDepth>();

  for (const row of result.rows) {
    if (!depthMap.has(row.name)) {
      depthMap.set(row.name, {
        name: row.name,
        pending: 0,
        active: 0,
        retry: 0,
        failed: 0,
        completed: 0,
      });
    }
    const entry = depthMap.get(row.name)!;
    const count = Number(row.count);
    if (row.state === 'created') entry.pending += count;
    else if (row.state === 'active') entry.active += count;
    else if (row.state === 'retry') entry.retry += count;
    else if (row.state === 'failed') entry.failed += count;
    else if (row.state === 'completed') entry.completed += count;
    else if (row.state === 'cancelled') {
      // cancelled is not part of QueueDepth — skip
    }
  }

  return Array.from(depthMap.values());
}

/**
 * Returns the most recent jobs across all queues (live table only).
 * Does not include archived (completed/failed long ago) jobs.
 */
export async function listRecentJobs(opts: {
  limit?: number;
  queue?: string;
} = {}): Promise<JobItem[]> {
  const { limit = 100, queue } = opts;

  const result = await pool.query<{
    id: string;
    name: string;
    state: JobStatus;
    data: Record<string, unknown>;
    output: Record<string, unknown> | null;
    retrycount: number;
    createdon: Date;
    startedon: Date | null;
    completedon: Date | null;
  }>(
    queue ?
      `SELECT id, name, state, data, output, retrycount, createdon, startedon, completedon
       FROM pgboss.job
       WHERE name = $1
       ORDER BY createdon DESC
       LIMIT $2`
    : `SELECT id, name, state, data, output, retrycount, createdon, startedon, completedon
       FROM pgboss.job
       ORDER BY createdon DESC
       LIMIT $1`,
    queue ? [queue, limit] : [limit],
  );

  return result.rows.map(mapJobRow);
}

/**
 * Returns failed jobs created in the last N days (from live table).
 */
export async function listFailedJobs(sinceDays = 7): Promise<JobItem[]> {
  const result = await pool.query<{
    id: string;
    name: string;
    state: JobStatus;
    data: Record<string, unknown>;
    output: Record<string, unknown> | null;
    retrycount: number;
    createdon: Date;
    startedon: Date | null;
    completedon: Date | null;
  }>(
    `SELECT id, name, state, data, output, retrycount, createdon, startedon, completedon
     FROM pgboss.job
     WHERE state = 'failed'
       AND createdon >= NOW() - ($1 || ' days')::interval
     ORDER BY createdon DESC
     LIMIT 200`,
    [sinceDays],
  );

  return result.rows.map(mapJobRow);
}

/**
 * Returns a single job by id (full payload + error detail).
 */
export async function getJobById(id: string): Promise<JobItem | null> {
  const result = await pool.query<{
    id: string;
    name: string;
    state: JobStatus;
    data: Record<string, unknown>;
    output: Record<string, unknown> | null;
    retrycount: number;
    createdon: Date;
    startedon: Date | null;
    completedon: Date | null;
  }>(
    `SELECT id, name, state, data, output, retrycount, createdon, startedon, completedon
     FROM pgboss.job
     WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  if (!row) return null;
  return mapJobRow(row);
}

/**
 * Retries a failed job by re-sending it on the same queue with the
 * original data. Uses `boss.send()` since `boss.retry()` in v12 only
 * works on jobs still in the live `pgboss.job` table with state=failed
 * and requires the queue name — we have both, so we use the native API.
 */
export async function retryJob(opts: {
  jobId: string;
  queue: string;
}): Promise<void> {
  const { jobId, queue } = opts;
  const boss = getOrchestrator().getBoss();
  await boss.retry(queue, jobId);
}

/**
 * Cancels a pending/active job.
 * pg-boss v12 `cancel(name, id)` sets state=cancelled in pgboss.job.
 */
export async function cancelJob(opts: {
  jobId: string;
  queue: string;
}): Promise<void> {
  const { jobId, queue } = opts;
  const boss = getOrchestrator().getBoss();
  await boss.cancel(queue, jobId);
}

/**
 * Triggers a one-off run of a scheduled task by enqueueing a job in its queue.
 */
export async function triggerScheduledTask(name: string): Promise<void> {
  const task = scheduledTasks.find((t) => t.name === name);
  if (!task) throw new Error(`No scheduled task registered with name: ${name}`);

  const boss = getOrchestrator().getBoss();
  const jobId = await boss.send(name, task.data ?? {});
  if (!jobId) throw new Error(`Failed to enqueue task "${name}": pg-boss returned null`);
}
