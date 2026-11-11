import type { Route } from './+types/admin.apps.$appId.domains';
import { Link } from 'react-router';
import AdminShell from '#app/components/admin-shell';
import { listDomains } from '#app/services/domain-service';
import { getUser } from '#app/middleware/helpers';
import { getAppById } from '#app/models/apps.server';
import { Button } from '#app/components/ui/button';
import { Badge } from '#app/components/ui/badge';
import { db } from '#drizzle/db';
import { dnsCheckResults } from '#drizzle/schema/dns-check-results';
import { sql, desc } from 'drizzle-orm';

export const handle = { title: 'Domains' };

// =============================================================================
// DNS health badge query types
// =============================================================================

type DnsBadgeState = 'healthy' | 'degraded' | 'failing' | 'unchecked';

interface DomainHealthRow {
  domainId: string;
  status: string;
}

interface DomainHealthSummary {
  badgeState: DnsBadgeState;
  lastCheckedAt: Date | null;
}

// =============================================================================
// Efficient single-round-trip query: most recent status per (domain_id, record_type)
// Uses a window function with the (domain_id, record_type, checked_at DESC) index.
// =============================================================================

async function getDnsHealthForDomains(
  domainIds: string[],
): Promise<Map<string, DomainHealthSummary>> {
  if (domainIds.length === 0) {
    return new Map();
  }

  // Window function: rank rows within each (domainId, recordType) partition by checkedAt DESC.
  // Only keep rank = 1 (the most recent per record type).
  const rows = await db.execute<{ domain_id: string; status: string; checked_at: Date }>(sql`
    SELECT domain_id, status, checked_at
    FROM (
      SELECT
        domain_id,
        status,
        checked_at,
        ROW_NUMBER() OVER (PARTITION BY domain_id, record_type ORDER BY checked_at DESC) AS rn
      FROM ${dnsCheckResults}
      WHERE domain_id = ANY(${sql.raw(`ARRAY[${domainIds.map((id) => `'${id}'`).join(',')}]`)})
    ) ranked
    WHERE rn = 1
  `);

  // Group by domainId and derive badge state
  const grouped = new Map<string, { statuses: string[]; maxCheckedAt: Date | null }>();

  for (const row of rows.rows) {
    const existing = grouped.get(row.domain_id);
    const checkedAt = row.checked_at instanceof Date ? row.checked_at : new Date(row.checked_at);
    if (!existing) {
      grouped.set(row.domain_id, { statuses: [row.status], maxCheckedAt: checkedAt });
    } else {
      existing.statuses.push(row.status);
      if (!existing.maxCheckedAt || checkedAt > existing.maxCheckedAt) {
        existing.maxCheckedAt = checkedAt;
      }
    }
  }

  const result = new Map<string, DomainHealthSummary>();

  for (const domainId of domainIds) {
    const data = grouped.get(domainId);
    if (!data || data.statuses.length === 0) {
      result.set(domainId, { badgeState: 'unchecked', lastCheckedAt: null });
      continue;
    }

    const hasFail = data.statuses.some((s) => s === 'fail');
    const hasError = data.statuses.some((s) => s === 'error');
    let badgeState: DnsBadgeState;

    if (hasFail) {
      badgeState = 'failing';
    } else if (hasError) {
      badgeState = 'degraded';
    } else {
      badgeState = 'healthy';
    }

    result.set(domainId, { badgeState, lastCheckedAt: data.maxCheckedAt });
  }

  return result;
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = getUser(context);
  const [domains, app] = await Promise.all([
    listDomains(params.appId),
    getAppById(params.appId),
  ]);

  const domainIds = domains.map((d) => d.id);
  const healthMap = await getDnsHealthForDomains(domainIds);

  const domainsWithHealth = domains.map((d) => ({
    ...d,
    health: healthMap.get(d.id) ?? { badgeState: 'unchecked' as DnsBadgeState, lastCheckedAt: null },
  }));

  return { user, appId: params.appId, domains: domainsWithHealth, app };
}

// =============================================================================
// Helpers
// =============================================================================

function statusVariant(status: string | null): 'default' | 'secondary' | 'destructive' {
  if (status === 'success') return 'default';
  if (status === 'failed') return 'destructive';
  return 'secondary';
}

function relativeTime(date: Date | null | undefined): string {
  if (!date) return 'Never';
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

const HEALTH_BADGE_CLASSES: Record<DnsBadgeState, string> = {
  healthy:
    'bg-green-50 text-green-700 ring-1 ring-inset ring-green-600/20 dark:bg-green-900/20 dark:text-green-300 dark:ring-green-400/30',
  degraded:
    'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-900/20 dark:text-amber-300 dark:ring-amber-400/30',
  failing:
    'bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-900/20 dark:text-red-300 dark:ring-red-400/30',
  unchecked:
    'bg-zinc-100 text-zinc-700 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-500/30',
};

const HEALTH_BADGE_LABELS: Record<DnsBadgeState, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  failing: 'Failing',
  unchecked: 'Not yet checked',
};

function DnsHealthBadge({
  badgeState,
  lastCheckedAt,
}: {
  badgeState: DnsBadgeState;
  lastCheckedAt: Date | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${HEALTH_BADGE_CLASSES[badgeState]}`}
      >
        {HEALTH_BADGE_LABELS[badgeState]}
      </span>
      <span
        className="text-xs text-zinc-500"
        title={lastCheckedAt ? lastCheckedAt.toISOString() : undefined}
      >
        {lastCheckedAt ? relativeTime(lastCheckedAt) : 'Never'}
      </span>
    </div>
  );
}

// =============================================================================
// Card border accent by health state
// =============================================================================

const HEALTH_CARD_BORDER: Record<DnsBadgeState, string> = {
  healthy: 'border-l-green-500',
  degraded: 'border-l-amber-500',
  failing: 'border-l-red-500',
  unchecked: 'border-l-zinc-400 dark:border-l-zinc-600',
};

// =============================================================================
// Component
// =============================================================================

export default function AdminAppDomains({ loaderData }: Route.ComponentProps) {
  const { user, appId, domains, app } = loaderData;
  return (
    <AdminShell user={user} currentApp={app}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Domains</h2>
          <Button asChild>
            <Link to={`/admin/apps/${appId}/domains/new`}>Add Domain</Link>
          </Button>
        </div>

        {domains.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-8 text-center text-sm text-zinc-500">
            No domains added yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {domains.map((domain) => (
              <div
                key={domain.id}
                className={`rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 relative cursor-pointer hover:shadow-sm transition-shadow border-l-4 ${HEALTH_CARD_BORDER[domain.health.badgeState]}`}
              >
                {/* Stretched link — entire card is clickable */}
                <Link
                  to={`/admin/apps/${appId}/domains/${domain.id}`}
                  className="before:absolute before:inset-0 before:rounded-lg"
                  aria-label={`View domain ${domain.name}`}
                />

                {/* Domain name + health badge */}
                <div className="flex items-start justify-between gap-2 mb-3">
                  <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 break-all">
                    {domain.name}
                  </h3>
                  <span
                    className={`shrink-0 inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${HEALTH_BADGE_CLASSES[domain.health.badgeState]}`}
                  >
                    {HEALTH_BADGE_LABELS[domain.health.badgeState]}
                  </span>
                </div>

                {/* SES verification pills */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  <Badge variant={statusVariant(domain.spfStatus)}>
                    SPF {domain.spfStatus ?? 'pending'}
                  </Badge>
                  <Badge variant={statusVariant(domain.dkimStatus)}>
                    DKIM {domain.dkimStatus ?? 'pending'}
                  </Badge>
                  <Badge variant={statusVariant(domain.dmarcStatus)}>
                    DMARC {domain.dmarcStatus ?? 'pending'}
                  </Badge>
                </div>

                {/* Last DNS check */}
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  <span className="font-medium">Last checked:</span>{' '}
                  {domain.health.lastCheckedAt ? (
                    <span title={domain.health.lastCheckedAt.toISOString()}>
                      {relativeTime(domain.health.lastCheckedAt)}
                    </span>
                  ) : (
                    'Never'
                  )}
                </p>

                {/* Created at */}
                <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                  Added {new Date(domain.createdAt).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  );
}
