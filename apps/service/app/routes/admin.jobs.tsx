import type { Route } from './+types/admin.jobs';
import * as React from 'react';
import { Form, useFetcher } from 'react-router';
import {
  Play,
  RotateCw,
  X,
  CheckCircle,
  AlertTriangle,
  ListTodo,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import AdminShell from '#app/components/admin-shell';
import { getUser } from '#app/middleware/helpers';
import {
  listScheduledTasks,
  getDetailedQueueDepths,
  listRecentJobs,
  listFailedJobs,
  retryJob,
  cancelJob,
  triggerScheduledTask,
} from '#app/models/jobs.server';

export const handle = { title: 'Jobs & Scheduler' };

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ context }: Route.LoaderArgs) {
  const user = getUser(context);

  const [scheduledTasks, queueDepths, recentJobs, failedJobs] = await Promise.all([
    listScheduledTasks(),
    getDetailedQueueDepths(),
    listRecentJobs({ limit: 100 }),
    listFailedJobs(7),
  ]);

  return { user, scheduledTasks, queueDepths, recentJobs, failedJobs };
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'retry') {
    const jobId = formData.get('jobId');
    const queue = formData.get('queue');
    if (typeof jobId !== 'string' || typeof queue !== 'string') {
      return new Response('Missing jobId or queue', { status: 400 });
    }
    await retryJob({ jobId, queue });
    return { ok: true };
  }

  if (intent === 'cancel') {
    const jobId = formData.get('jobId');
    const queue = formData.get('queue');
    if (typeof jobId !== 'string' || typeof queue !== 'string') {
      return new Response('Missing jobId or queue', { status: 400 });
    }
    await cancelJob({ jobId, queue });
    return { ok: true };
  }

  if (intent === 'trigger') {
    const name = formData.get('name');
    if (typeof name !== 'string') {
      return new Response('Missing name', { status: 400 });
    }
    await triggerScheduledTask(name);
    return { ok: true };
  }

  return new Response('Unknown intent', { status: 400 });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(date: Date | string | null | undefined): string {
  if (!date) return '-';
  const d = date instanceof Date ? date : new Date(date);
  const diff = Date.now() - d.getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

// ─── Status pill ─────────────────────────────────────────────────────────────

type StatusVariant = 'success' | 'error' | 'active' | 'pending' | 'cancelled';

const STATUS_CLASSES: Record<StatusVariant, string> = {
  success:
    'bg-green-50 text-green-700 ring-1 ring-inset ring-green-600/20 dark:bg-green-900/20 dark:text-green-300 dark:ring-green-400/30',
  error:
    'bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-900/20 dark:text-red-300 dark:ring-red-400/30',
  active:
    'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-900/20 dark:text-amber-300 dark:ring-amber-400/30',
  pending:
    'bg-zinc-100 text-zinc-700 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-500/30',
  cancelled:
    'bg-zinc-50 text-zinc-500 ring-1 ring-inset ring-zinc-400/20 dark:bg-zinc-900 dark:text-zinc-500 dark:ring-zinc-600/30',
};

function jobStatusVariant(status: string): StatusVariant {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'active') return 'active';
  if (status === 'cancelled') return 'cancelled';
  return 'pending'; // created, retry
}

function jobStatusLabel(status: string): string {
  const map: Record<string, string> = {
    created: 'Pending',
    active: 'Active',
    retry: 'Retrying',
    completed: 'Success',
    cancelled: 'Cancelled',
    failed: 'Failed',
  };
  return map[status] ?? status;
}

function StatusPill({ status }: { status: string }) {
  const variant = jobStatusVariant(status);
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[variant]}`}
    >
      {jobStatusLabel(status)}
    </span>
  );
}

function LastRunBadge({ status }: { status: 'success' | 'failed' | 'active' | null }) {
  if (!status) return <span className="text-xs text-zinc-400">-</span>;
  const cls =
    status === 'success' ? 'text-green-600 dark:text-green-400'
    : status === 'failed' ? 'text-red-600 dark:text-red-400'
    : 'text-amber-600 dark:text-amber-400';
  const label = status === 'success' ? 'OK' : status === 'failed' ? 'Failed' : 'Running';
  return <span className={`text-xs font-medium ${cls}`}>{label}</span>;
}

// ─── Section header ──────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-3">
      {children}
    </p>
  );
}

// ─── Card wrapper ─────────────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
      {children}
    </div>
  );
}

// ─── Trigger button ───────────────────────────────────────────────────────────

function TriggerButton({ name }: { name: string }) {
  const fetcher = useFetcher();
  const isLoading = fetcher.state !== 'idle';

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="trigger" />
      <input type="hidden" name="name" value={name} />
      <button
        type="submit"
        disabled={isLoading}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
        title="Run now"
      >
        <Play size={11} />
        {isLoading ? 'Running…' : 'Run Now'}
      </button>
    </fetcher.Form>
  );
}

// ─── Job action buttons ───────────────────────────────────────────────────────

type JobActionButtonsProps = {
  jobId: string;
  queue: string;
  status: string;
};

function JobActionButtons({ jobId, queue, status }: JobActionButtonsProps) {
  const fetcher = useFetcher();
  const isLoading = fetcher.state !== 'idle';
  const canRetry = status === 'failed' || status === 'cancelled';
  const canCancel = status === 'created' || status === 'active' || status === 'retry';

  if (!canRetry && !canCancel) return null;

  return (
    <div className="flex items-center gap-1">
      {canRetry && (
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="retry" />
          <input type="hidden" name="jobId" value={jobId} />
          <input type="hidden" name="queue" value={queue} />
          <button
            type="submit"
            disabled={isLoading}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
            title="Retry job"
          >
            <RotateCw size={11} />
            Retry
          </button>
        </fetcher.Form>
      )}
      {canCancel && (
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="cancel" />
          <input type="hidden" name="jobId" value={jobId} />
          <input type="hidden" name="queue" value={queue} />
          <button
            type="submit"
            disabled={isLoading}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
            title="Cancel job"
          >
            <X size={11} />
            Cancel
          </button>
        </fetcher.Form>
      )}
    </div>
  );
}

// ─── Expandable job row ───────────────────────────────────────────────────────

type JobRowProps = {
  job: Route.ComponentProps['loaderData']['recentJobs'][number];
};

function JobRow({ job }: JobRowProps) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <>
      <tr
        className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-4 py-3 text-xs font-mono text-zinc-500 dark:text-zinc-400 tabular-nums">
          {job.queue}
        </td>
        <td className="px-4 py-3">
          <StatusPill status={job.status} />
        </td>
        <td className="px-4 py-3 text-xs text-zinc-500 tabular-nums" title={job.createdOn.toISOString()}>
          {relativeTime(job.createdOn)}
        </td>
        <td className="px-4 py-3 text-xs text-zinc-500 tabular-nums" title={job.completedOn?.toISOString()}>
          {relativeTime(job.completedOn)}
        </td>
        <td className="px-4 py-3 text-xs text-zinc-500 tabular-nums">
          {formatDuration(job.durationMs)}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <JobActionButtons jobId={job.id} queue={job.queue} status={job.status} />
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-zinc-50/70 dark:bg-zinc-800/30">
          <td colSpan={6} className="px-4 py-4">
            <div className="space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-1">
                  Job ID
                </p>
                <code className="text-xs font-mono text-zinc-600 dark:text-zinc-300 select-all">
                  {job.id}
                </code>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-1">
                  Payload
                </p>
                <pre className="text-xs font-mono text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-900 rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(job.data, null, 2)}
                </pre>
              </div>
              {job.retryCount > 0 && (
                <p className="text-xs text-zinc-500">Retry count: {job.retryCount}</p>
              )}
              {job.errorMessage && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-red-500 mb-1">
                    Error
                  </p>
                  <p className="text-xs text-red-600 dark:text-red-400">{job.errorMessage}</p>
                </div>
              )}
              {job.errorStack && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-1">
                    Stack Trace
                  </p>
                  <pre className="text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-900 rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">
                    {job.errorStack}
                  </pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Jobs table ───────────────────────────────────────────────────────────────

type JobsTableProps = {
  jobs: Route.ComponentProps['loaderData']['recentJobs'];
};

function JobsTable({ jobs }: JobsTableProps) {
  if (jobs.length === 0) return null;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-zinc-100 dark:border-zinc-800">
          <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
            Queue
          </th>
          <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
            Status
          </th>
          <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
            Created
          </th>
          <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
            Completed
          </th>
          <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
            Duration
          </th>
          <th className="px-4 py-3" />
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
      </tbody>
    </table>
  );
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function AdminJobs({ loaderData }: Route.ComponentProps) {
  const { user, scheduledTasks, queueDepths, recentJobs, failedJobs } = loaderData;

  const enabledTasks = scheduledTasks.filter((t) => t.enabled);
  const disabledTasks = scheduledTasks.filter((t) => !t.enabled);

  return (
    <AdminShell user={user}>
      <div className="space-y-8">
        {/* Page title */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Jobs &amp; Scheduler
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            pg-boss queue inspector: retry failed jobs, cancel pending ones, trigger scheduled tasks manually.
          </p>
        </div>

        {/* Section A — Scheduled tasks */}
        <div>
          <SectionHeader>Scheduled Tasks</SectionHeader>
          <Card>
            {scheduledTasks.length === 0 ? (
              <p className="text-sm text-zinc-500">No scheduled tasks registered.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-100 dark:border-zinc-800">
                      <th className="pb-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                        Task
                      </th>
                      <th className="pb-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                        Cron
                      </th>
                      <th className="pb-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                        TZ
                      </th>
                      <th className="pb-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                        Last Run
                      </th>
                      <th className="pb-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                        Status
                      </th>
                      <th className="pb-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {enabledTasks.map((task) => (
                      <tr
                        key={task.name}
                        className="border-b border-zinc-100 dark:border-zinc-800 last:border-0"
                      >
                        <td className="py-3 pr-4">
                          <p className="font-medium text-zinc-900 dark:text-zinc-100 font-mono text-xs">
                            {task.name}
                          </p>
                          <p className="text-xs text-zinc-500 mt-0.5">{task.description}</p>
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs text-zinc-600 dark:text-zinc-400 tabular-nums">
                          {task.cron}
                        </td>
                        <td className="py-3 pr-4 text-xs text-zinc-500">{task.timezone}</td>
                        <td
                          className="py-3 pr-4 text-xs text-zinc-500 tabular-nums"
                          title={task.lastRunAt?.toISOString()}
                        >
                          {relativeTime(task.lastRunAt)}
                        </td>
                        <td className="py-3 pr-4">
                          <LastRunBadge status={task.lastRunStatus} />
                        </td>
                        <td className="py-3">
                          <TriggerButton name={task.name} />
                        </td>
                      </tr>
                    ))}
                    {disabledTasks.map((task) => (
                      <tr
                        key={task.name}
                        className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 opacity-40"
                      >
                        <td className="py-3 pr-4">
                          <p className="font-medium text-zinc-900 dark:text-zinc-100 font-mono text-xs">
                            {task.name}
                          </p>
                          <p className="text-xs text-zinc-500 mt-0.5">{task.description}</p>
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                          {task.cron}
                        </td>
                        <td className="py-3 pr-4 text-xs text-zinc-500">{task.timezone}</td>
                        <td className="py-3 pr-4 text-xs text-zinc-500">-</td>
                        <td className="py-3 pr-4">
                          <span className="text-xs text-zinc-400">Disabled</span>
                        </td>
                        <td className="py-3" />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* Section B — Queue depths */}
        <div>
          <SectionHeader>Queue Depths</SectionHeader>
          {queueDepths.length === 0 ? (
            <Card>
              <p className="text-sm text-zinc-500">No queues found.</p>
            </Card>
          ) : (
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Queue
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Pending
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Active
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Retry
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Failed
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Completed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {queueDepths.map((q) => (
                    <tr
                      key={q.name}
                      className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 bg-white dark:bg-zinc-900 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                        {q.name}
                      </td>
                      <td className="px-4 py-3 text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                        {q.pending}
                      </td>
                      <td className="px-4 py-3 text-right text-xs tabular-nums text-amber-600 dark:text-amber-400">
                        {q.active > 0 ? q.active : <span className="text-zinc-400">{q.active}</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                        {q.retry}
                      </td>
                      <td className="px-4 py-3 text-right text-xs tabular-nums">
                        {q.failed > 0 ? (
                          <span className="text-red-600 dark:text-red-400 font-medium">{q.failed}</span>
                        ) : (
                          <span className="text-zinc-400">{q.failed}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-xs tabular-nums text-zinc-500">
                        {q.completed}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Section C — Recent jobs */}
        <div>
          <SectionHeader>Recent Jobs (last 100)</SectionHeader>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
            {recentJobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <ListTodo size={40} className="text-zinc-300 dark:text-zinc-600 mb-3" />
                <p className="text-sm font-medium text-zinc-500">No jobs in the queue</p>
                <p className="text-xs text-zinc-400 mt-1">
                  Jobs will appear here once they are created.
                </p>
              </div>
            ) : (
              <JobsTable jobs={recentJobs} />
            )}
          </div>
        </div>

        {/* Section D — Failed jobs (last 7 days) */}
        <div>
          <SectionHeader>Failed Jobs: Last 7 Days</SectionHeader>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
            {failedJobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <CheckCircle
                  size={36}
                  className="text-green-400 dark:text-green-600 mb-2"
                />
                <p className="text-sm font-medium text-zinc-500">
                  No failed jobs in the last 7 days
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-red-50/50 dark:bg-red-900/10">
                  <AlertTriangle size={14} className="text-red-500 shrink-0" />
                  <p className="text-xs text-red-700 dark:text-red-400 font-medium">
                    {failedJobs.length} failed job{failedJobs.length !== 1 ? 's' : ''} require attention
                  </p>
                </div>
                <JobsTable jobs={failedJobs} />
              </>
            )}
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
