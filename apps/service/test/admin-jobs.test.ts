/**
 * Tests for admin jobs route (loader + action) and underlying model functions.
 *
 * We mock the entire #app/models/jobs.server module so no real pg-boss or
 * database connection is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock declarations — must come before any imports of the mocked modules ──

const mockListScheduledTasks = vi.fn();
const mockGetDetailedQueueDepths = vi.fn();
const mockListRecentJobs = vi.fn();
const mockListFailedJobs = vi.fn();
const mockRetryJob = vi.fn();
const mockCancelJob = vi.fn();
const mockTriggerScheduledTask = vi.fn();

vi.mock('#app/models/jobs.server', () => ({
  listScheduledTasks: mockListScheduledTasks,
  getDetailedQueueDepths: mockGetDetailedQueueDepths,
  listRecentJobs: mockListRecentJobs,
  listFailedJobs: mockListFailedJobs,
  retryJob: mockRetryJob,
  cancelJob: mockCancelJob,
  triggerScheduledTask: mockTriggerScheduledTask,
}));

// Auth middleware helpers
vi.mock('#app/middleware/helpers', () => ({
  getUser: () => ({ id: 'admin-1', name: 'Test Admin', role: 'admin', email: 'a@b.com' }),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCHEDULED_TASK_FIXTURE = {
  name: 'idempotency-cleanup',
  cron: '0 * * * *',
  timezone: 'UTC',
  description: 'Delete idempotent_requests rows older than 25 hours',
  enabled: true,
  scheduledAt: null,
  lastRunAt: new Date('2025-05-21T10:00:00Z'),
  lastRunStatus: 'success' as const,
  nextRunAt: null,
};

const QUEUE_DEPTH_FIXTURE = {
  name: 'default',
  pending: 0,
  active: 1,
  retry: 0,
  failed: 2,
  completed: 50,
};

const JOB_FIXTURE = {
  id: 'job-abc-123',
  queue: 'default',
  status: 'failed' as const,
  data: { workflowId: 'wf-1', workflowType: 'email-send' },
  output: { value: { message: 'SMTP timeout', stack: 'Error: SMTP timeout\n  at send' } },
  retryCount: 3,
  createdOn: new Date('2025-05-21T09:00:00Z'),
  startedOn: new Date('2025-05-21T09:00:01Z'),
  completedOn: new Date('2025-05-21T09:00:05Z'),
  durationMs: 4000,
  errorMessage: 'SMTP timeout',
  errorStack: 'Error: SMTP timeout\n  at send',
};

// ─── Import route after mocks ─────────────────────────────────────────────────

const { loader, action } = await import('../app/routes/admin.jobs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContext() {
  return {};
}

function makeFormRequest(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields).toString();
  return new Request('http://localhost/admin/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

// ─── Loader tests ─────────────────────────────────────────────────────────────

describe('admin.jobs loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListScheduledTasks.mockResolvedValue([SCHEDULED_TASK_FIXTURE]);
    mockGetDetailedQueueDepths.mockResolvedValue([QUEUE_DEPTH_FIXTURE]);
    mockListRecentJobs.mockResolvedValue([JOB_FIXTURE]);
    mockListFailedJobs.mockResolvedValue([JOB_FIXTURE]);
  });

  it('returns scheduled tasks, queue depths, recent jobs, and failed jobs', async () => {
    const result = await loader({
      request: new Request('http://localhost/admin/jobs'),
      context: makeContext(),
      params: {},
    } as Parameters<typeof loader>[0]);

    expect(result.scheduledTasks).toHaveLength(1);
    expect(result.scheduledTasks[0].name).toBe('idempotency-cleanup');
    expect(result.queueDepths).toHaveLength(1);
    expect(result.queueDepths[0].name).toBe('default');
    expect(result.recentJobs).toHaveLength(1);
    expect(result.recentJobs[0].id).toBe('job-abc-123');
    expect(result.failedJobs).toHaveLength(1);
    expect(result.failedJobs[0].errorMessage).toBe('SMTP timeout');
  });

  it('calls listRecentJobs with limit 100', async () => {
    await loader({
      request: new Request('http://localhost/admin/jobs'),
      context: makeContext(),
      params: {},
    } as Parameters<typeof loader>[0]);

    expect(mockListRecentJobs).toHaveBeenCalledWith({ limit: 100 });
  });

  it('calls listFailedJobs with 7 days', async () => {
    await loader({
      request: new Request('http://localhost/admin/jobs'),
      context: makeContext(),
      params: {},
    } as Parameters<typeof loader>[0]);

    expect(mockListFailedJobs).toHaveBeenCalledWith(7);
  });

  it('handles empty state — all empty arrays', async () => {
    mockListScheduledTasks.mockResolvedValue([]);
    mockGetDetailedQueueDepths.mockResolvedValue([]);
    mockListRecentJobs.mockResolvedValue([]);
    mockListFailedJobs.mockResolvedValue([]);

    const result = await loader({
      request: new Request('http://localhost/admin/jobs'),
      context: makeContext(),
      params: {},
    } as Parameters<typeof loader>[0]);

    expect(result.scheduledTasks).toEqual([]);
    expect(result.queueDepths).toEqual([]);
    expect(result.recentJobs).toEqual([]);
    expect(result.failedJobs).toEqual([]);
  });
});

// ─── Action tests ─────────────────────────────────────────────────────────────

describe('admin.jobs action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRetryJob.mockResolvedValue(undefined);
    mockCancelJob.mockResolvedValue(undefined);
    mockTriggerScheduledTask.mockResolvedValue(undefined);
  });

  it('intent=retry calls retryJob with correct jobId and queue', async () => {
    const req = makeFormRequest({
      intent: 'retry',
      jobId: 'job-abc-123',
      queue: 'default',
    });

    const result = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as Parameters<typeof action>[0]);

    expect(mockRetryJob).toHaveBeenCalledWith({ jobId: 'job-abc-123', queue: 'default' });
    expect(result).toMatchObject({ ok: true });
  });

  it('intent=cancel calls cancelJob with correct jobId and queue', async () => {
    const req = makeFormRequest({
      intent: 'cancel',
      jobId: 'job-xyz-456',
      queue: 'sequential',
    });

    const result = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as Parameters<typeof action>[0]);

    expect(mockCancelJob).toHaveBeenCalledWith({ jobId: 'job-xyz-456', queue: 'sequential' });
    expect(result).toMatchObject({ ok: true });
  });

  it('intent=trigger calls triggerScheduledTask with correct name', async () => {
    const req = makeFormRequest({
      intent: 'trigger',
      name: 'idempotency-cleanup',
    });

    const result = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as Parameters<typeof action>[0]);

    expect(mockTriggerScheduledTask).toHaveBeenCalledWith('idempotency-cleanup');
    expect(result).toMatchObject({ ok: true });
  });

  it('unknown intent returns 400', async () => {
    const req = makeFormRequest({ intent: 'delete-everything' });

    const result = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as Parameters<typeof action>[0]);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  it('retry missing jobId returns 400', async () => {
    const req = makeFormRequest({ intent: 'retry', queue: 'default' }); // missing jobId

    const result = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as Parameters<typeof action>[0]);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(mockRetryJob).not.toHaveBeenCalled();
  });

  it('cancel missing queue returns 400', async () => {
    const req = makeFormRequest({ intent: 'cancel', jobId: 'job-1' }); // missing queue

    const result = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as Parameters<typeof action>[0]);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(mockCancelJob).not.toHaveBeenCalled();
  });

  it('trigger missing name returns 400', async () => {
    const req = makeFormRequest({ intent: 'trigger' }); // missing name

    const result = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as Parameters<typeof action>[0]);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(mockTriggerScheduledTask).not.toHaveBeenCalled();
  });
});
