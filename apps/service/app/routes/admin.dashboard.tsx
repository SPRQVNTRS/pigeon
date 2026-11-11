import type { Route } from './+types/admin.dashboard';
import { Link, useSearchParams } from 'react-router';
import { Mail, AlertTriangle, TrendingUp, Inbox, Plus, KeyRound, Globe } from 'lucide-react';
import AdminShell from '#app/components/admin-shell';
import { listApps } from '#app/models/apps.server';
import { getDashboardStats, parseRange } from '#app/models/dashboard.server';
import { getUser } from '#app/middleware/helpers';
import type { Range } from '#app/models/dashboard.server';

export const handle = { title: 'Admin Dashboard' };

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = getUser(context);
  const url = new URL(request.url);
  const range = parseRange(url.searchParams.get('range'));

  const [apps, stats] = await Promise.all([listApps(), getDashboardStats(range)]);

  const appMap = new Map(apps.map((a) => [a.id, a.name]));

  // Build per-app stats
  const sentMap = new Map(stats.emailSentByApp.map((r) => [r.appId, r.count]));
  const bounceMap = new Map(stats.bounceByApp.map((r) => [r.appId, r.count]));
  const failureMap = new Map<string, number>();
  for (const wh of stats.failedWebhooks) {
    failureMap.set(wh.appId, (failureMap.get(wh.appId) ?? 0) + 1);
  }

  const allAppIds = new Set([
    ...sentMap.keys(),
    ...bounceMap.keys(),
    ...failureMap.keys(),
    ...apps.map((a) => a.id),
  ]);

  const perAppStats = Array.from(allAppIds).map((appId) => {
    const emailsSent = sentMap.get(appId) ?? 0;
    const bounceCount = bounceMap.get(appId) ?? 0;
    const webhookFailureCount = failureMap.get(appId) ?? 0;
    const bounceRate = emailsSent > 0 ? bounceCount / emailsSent : null;
    return {
      appId,
      appName: appMap.get(appId) ?? appId,
      emailsSent,
      bounceCount,
      webhookFailureCount,
      bounceRate,
    };
  });

  const totalEmailsSent = perAppStats.reduce((s, a) => s + a.emailsSent, 0);
  const totalBounceCount = perAppStats.reduce((s, a) => s + a.bounceCount, 0);
  const totalWebhookFailures = perAppStats.reduce((s, a) => s + a.webhookFailureCount, 0);
  const aggregateBounceRate = totalEmailsSent > 0 ? totalBounceCount / totalEmailsSent : null;

  return {
    user,
    range,
    perAppStats,
    aggregate: {
      emailsSent: totalEmailsSent,
      bounceCount: totalBounceCount,
      webhookFailureCount: totalWebhookFailures,
      bounceRate: aggregateBounceRate,
    },
    recentEmails: stats.recentEmails.map((e) => ({
      ...e,
      appName: appMap.get(e.appId) ?? e.appId,
    })),
    recentFailedWebhooks: stats.failedWebhooks.map((w) => ({
      ...w,
      appName: appMap.get(w.appId) ?? w.appId,
    })),
  };
}

// =============================================================================
// Helpers
// =============================================================================

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

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function formatBounceRate(rate: number | null): string {
  if (rate === null) return '-';
  return `${(rate * 100).toFixed(1)}%`;
}

type StatusVariant = 'success' | 'warning' | 'error' | 'neutral';

function statusVariant(status: string): StatusVariant {
  if (status === 'delivered') return 'success';
  if (status === 'bounced' || status === 'complained') return 'error';
  if (status === 'sending' || status === 'queued') return 'warning';
  return 'neutral';
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    delivered: 'Delivered',
    bounced: 'Bounced',
    complained: 'Complained',
    sending: 'Sending',
    queued: 'Queued',
    failed: 'Failed',
  };
  return map[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

const STATUS_CLASSES: Record<StatusVariant, string> = {
  success:
    'bg-green-50 text-green-700 ring-1 ring-inset ring-green-600/20 dark:bg-green-900/20 dark:text-green-300 dark:ring-green-400/30',
  warning:
    'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-900/20 dark:text-amber-300 dark:ring-amber-400/30',
  error:
    'bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-900/20 dark:text-red-300 dark:ring-red-400/30',
  neutral:
    'bg-zinc-100 text-zinc-700 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-500/30',
};

function StatusPill({ status }: { status: string }) {
  const variant = statusVariant(status);
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[variant]}`}
    >
      {statusLabel(status)}
    </span>
  );
}

const RANGE_OPTIONS: { label: string; value: Range }[] = [
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
  { label: '90d', value: '90d' },
];

// =============================================================================
// Component
// =============================================================================

export default function AdminDashboard({ loaderData }: Route.ComponentProps) {
  const { user, range, perAppStats, aggregate, recentEmails, recentFailedWebhooks } = loaderData;
  const [, setSearchParams] = useSearchParams();

  function setRange(r: Range) {
    setSearchParams({ range: r });
  }

  return (
    <AdminShell user={user}>
      <div className="space-y-8">
        {/* Header + time range selector */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Dashboard
          </h1>
          <div className="flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-1">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setRange(opt.value)}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  range === opt.value
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Quick actions */}
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-3">
            Quick Actions
          </h2>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/admin/apps/new"
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              <Plus size={14} />
              New App
            </Link>
            <Link
              to="/admin/apps"
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              <KeyRound size={14} />
              Manage API Keys
            </Link>
            <Link
              to="/admin/apps"
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              <Globe size={14} />
              Verify a Domain
            </Link>
          </div>
        </div>

        {/* Stat cards */}
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-3">
            Overview
          </h2>
          <div className="grid grid-cols-3 gap-4">
            <StatCard
              label="Emails Sent"
              value={aggregate.emailsSent.toLocaleString()}
              icon={<Mail size={16} className="text-zinc-400" />}
            />
            <StatCard
              label="Bounce Rate"
              value={formatBounceRate(aggregate.bounceRate)}
              icon={<TrendingUp size={16} className="text-zinc-400" />}
            />
            <StatCard
              label="Webhook Failures"
              value={aggregate.webhookFailureCount.toLocaleString()}
              icon={<AlertTriangle size={16} className="text-zinc-400" />}
            />
          </div>

          {perAppStats.length > 1 && (
            <div className="mt-4 rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <div className="px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
                <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Per App</p>
              </div>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {perAppStats.map((a) => (
                  <div
                    key={a.appId}
                    className="grid grid-cols-4 gap-4 items-center bg-white dark:bg-zinc-900 px-4 py-3 text-sm"
                  >
                    <Link
                      to={`/admin/apps/${a.appId}`}
                      className="font-medium text-zinc-900 dark:text-zinc-100 truncate hover:underline hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                    >
                      {a.appName}
                    </Link>
                    <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
                      {a.emailsSent.toLocaleString()} sent
                    </span>
                    <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
                      {formatBounceRate(a.bounceRate)} bounce
                    </span>
                    <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
                      {a.webhookFailureCount} failures
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Recent emails */}
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-3">
            Recent Emails
          </h2>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
            {recentEmails.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Inbox size={40} className="text-zinc-300 dark:text-zinc-600 mb-3" />
                <p className="text-sm font-medium text-zinc-500">No emails yet</p>
                <p className="text-xs text-zinc-400 mt-1">Sent emails will appear here.</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                      To
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Subject
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                      App
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Sent
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recentEmails.map((email) => (
                    <tr
                      key={email.id}
                      className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-400 tabular-nums">
                        {truncate(email.toAddresses[0] ?? '-', 40)}
                      </td>
                      <td
                        className="px-4 py-3 text-zinc-700 dark:text-zinc-300 max-w-xs"
                        title={email.subject}
                      >
                        {truncate(email.subject, 50)}
                      </td>
                      <td className="px-4 py-3 text-zinc-500 text-xs">
                        <Link
                          to={`/admin/apps/${email.appId}`}
                          className="hover:underline hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                        >
                          {email.appName}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill status={email.status} />
                      </td>
                      <td className="px-4 py-3 text-zinc-500 text-xs tabular-nums">
                        {relativeTime(email.sentAt ?? email.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Recent webhook failures */}
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-3">
            Recent Webhook Failures
          </h2>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
            {recentFailedWebhooks.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-500">
                No webhook failures in this period.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Webhook URL
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                      App
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Last Failure
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500" />
                  </tr>
                </thead>
                <tbody>
                  {recentFailedWebhooks.map((wh) => (
                    <tr
                      key={wh.id}
                      className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                        {truncate(wh.url, 60)}
                      </td>
                      <td className="px-4 py-3 text-zinc-500 text-xs">
                        <Link
                          to={`/admin/apps/${wh.appId}`}
                          className="hover:underline hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                        >
                          {wh.appName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-zinc-500 text-xs tabular-nums">
                        {relativeTime(wh.lastFailureAt)}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          to={`/admin/apps/${wh.appId}/webhooks/${wh.id}`}
                          className="text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AdminShell>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</p>
        {icon}
      </div>
      <p className="text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
        {value}
      </p>
    </div>
  );
}
