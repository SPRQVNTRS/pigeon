import type { Route } from './+types/admin.apps.$appId.domains.$domainId';
import { useSearchParams, Form, useFetcher, useRevalidator } from 'react-router';
import * as React from 'react';
import AdminShell from '#app/components/admin-shell';
import { getDomain } from '#app/services/domain-service';
import { getUser } from '#app/middleware/helpers';
import { getAppById } from '#app/models/apps.server';
import { Badge } from '#app/components/ui/badge';
import { Button } from '#app/components/ui/button';
import { CONFIG } from '#config';
import { buildDmarcRecordValue } from '#app/lib/ses/dmarc-record';
import { db } from '#drizzle/db';
import { dnsCheckResults } from '#drizzle/schema/dns-check-results';
import { eq, desc } from 'drizzle-orm';
import { RefreshCw } from 'lucide-react';

export const handle = { title: 'Domain Details' };

// =============================================================================
// DNS record types (6 total) and health row type
// =============================================================================

const DNS_RECORD_TYPES = [
  'dkim_cname_1',
  'dkim_cname_2',
  'dkim_cname_3',
  'spf_txt',
  'dmarc_txt',
  'ses_verified',
] as const;

type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

interface DnsHealthRow {
  recordType: DnsRecordType;
  status: string | null;
  expected: string | null;
  actual: string | null;
  checkedAt: Date | null;
  errorMessage: string | null;
}

// =============================================================================
// DNS health query: most recent row per record type for one domain
// =============================================================================

async function getDnsHealthForDomain(domainId: string): Promise<DnsHealthRow[]> {
  // Fetch all results ordered by checked_at DESC; the index supports this efficiently.
  const rows = await db
    .select()
    .from(dnsCheckResults)
    .where(eq(dnsCheckResults.domainId, domainId))
    .orderBy(desc(dnsCheckResults.checkedAt));

  // Keep only the most recent row per record type
  const seenTypes = new Set<string>();
  const latestByType = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    if (!seenTypes.has(row.recordType)) {
      seenTypes.add(row.recordType);
      latestByType.set(row.recordType, row);
    }
  }

  // Return all 6 record types; fill in nulls for unchecked ones
  return DNS_RECORD_TYPES.map((recordType) => {
    const row = latestByType.get(recordType);
    if (!row) {
      return {
        recordType,
        status: null,
        expected: null,
        actual: null,
        checkedAt: null,
        errorMessage: null,
      };
    }
    return {
      recordType,
      status: row.status,
      expected: row.expected,
      actual: row.actual ?? null,
      checkedAt: row.checkedAt instanceof Date ? row.checkedAt : new Date(row.checkedAt),
      errorMessage: null, // error detail is surfaced via `actual` field per M76/02 schema
    };
  });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = getUser(context);
  const [domain, app, dnsHealth] = await Promise.all([
    getDomain({ domainId: params.domainId, appId: params.appId }),
    getAppById(params.appId),
    getDnsHealthForDomain(params.domainId),
  ]);
  if (!domain) {
    throw new Response('Not Found', { status: 404 });
  }
  return {
    user,
    domain,
    appId: params.appId,
    app,
    dmarcRua: CONFIG.aws.dmarcRua,
    dnsHealth,
  };
}

// =============================================================================
// UI helpers
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

const DNS_STATUS_CLASSES: Record<string, string> = {
  pass:
    'bg-green-50 text-green-700 ring-1 ring-inset ring-green-600/20 dark:bg-green-900/20 dark:text-green-300 dark:ring-green-400/30',
  verified:
    'bg-green-50 text-green-700 ring-1 ring-inset ring-green-600/20 dark:bg-green-900/20 dark:text-green-300 dark:ring-green-400/30',
  error:
    'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-900/20 dark:text-amber-300 dark:ring-amber-400/30',
  fail:
    'bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-900/20 dark:text-red-300 dark:ring-red-400/30',
  checking:
    'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-900/20 dark:text-amber-300 dark:ring-amber-400/30',
  unchecked:
    'bg-zinc-100 text-zinc-700 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-500/30',
};

function getDnsStatusClass(status: string | null, isPolling: boolean): string {
  if (isPolling) return DNS_STATUS_CLASSES.checking;
  if (!status) return DNS_STATUS_CLASSES.unchecked;
  return DNS_STATUS_CLASSES[status] ?? DNS_STATUS_CLASSES.unchecked;
}

function getDnsStatusLabel(status: string | null, isPolling: boolean): string {
  if (isPolling) return 'Checking…';
  if (!status) return 'Not checked';
  const labels: Record<string, string> = {
    pass: 'Pass',
    verified: 'Verified',
    error: 'Error',
    fail: 'Fail',
  };
  return labels[status] ?? status;
}

const RECORD_TYPE_LABELS: Record<DnsRecordType, string> = {
  dkim_cname_1: 'DKIM CNAME 1',
  dkim_cname_2: 'DKIM CNAME 2',
  dkim_cname_3: 'DKIM CNAME 3',
  spf_txt: 'SPF TXT',
  dmarc_txt: 'DMARC TXT',
  ses_verified: 'SES Verified',
};

function isDkimCname(recordType: DnsRecordType): boolean {
  return recordType === 'dkim_cname_1' || recordType === 'dkim_cname_2' || recordType === 'dkim_cname_3';
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="ml-2 text-xs text-blue-600 hover:underline dark:text-blue-400 shrink-0"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function DnsRow({
  label,
  host,
  value,
  type,
  priority,
}: {
  label: string;
  host: string;
  value: string;
  type: string;
  priority?: number;
}) {
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-700 p-4 space-y-2 bg-zinc-50 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{type}</span>
        <span className="text-xs text-zinc-500">{label}</span>
        {priority !== undefined && (
          <span className="text-xs text-zinc-400">Priority: {priority}</span>
        )}
      </div>
      <div className="space-y-1">
        <div className="flex items-start gap-2">
          <span className="text-xs text-zinc-400 w-10 shrink-0 pt-0.5">Host</span>
          <code className="flex-1 text-xs font-mono text-zinc-800 dark:text-zinc-200 break-all">
            {host}
          </code>
          <CopyButton text={host} />
        </div>
        <div className="flex items-start gap-2">
          <span className="text-xs text-zinc-400 w-10 shrink-0 pt-0.5">Value</span>
          <code className="flex-1 text-xs font-mono text-zinc-800 dark:text-zinc-200 break-all">
            {value}
          </code>
          <CopyButton text={value} />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// DNS Health Section with polling
// =============================================================================

type PollStatus = 'queued' | 'running' | 'completed' | 'failed' | 'not_found';

interface DnsCheckFetcherData {
  jobId?: string;
  status?: PollStatus;
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 15000;

function DnsHealthSection({
  dnsHealth,
  appId,
  domainId,
}: {
  dnsHealth: DnsHealthRow[];
  appId: string;
  domainId: string;
}) {
  const revalidator = useRevalidator();
  const enqueueFetcher = useFetcher<DnsCheckFetcherData>();
  const pollFetcher = useFetcher<DnsCheckFetcherData>();

  const [isPolling, setIsPolling] = React.useState(false);
  const [pollError, setPollError] = React.useState<string | null>(null);
  const [pollTimeout, setPollTimeout] = React.useState(false);

  const jobId = enqueueFetcher.data?.jobId ?? null;
  const pollStatus = pollFetcher.data?.status ?? null;

  // When enqueue completes and we get a jobId, start polling
  React.useEffect(() => {
    if (!jobId) return;
    setIsPolling(true);
    setPollError(null);
    setPollTimeout(false);
  }, [jobId]);

  // Poll loop: load the status endpoint every second, up to 15s
  React.useEffect(() => {
    if (!isPolling || !jobId) return;

    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += POLL_INTERVAL_MS;

      if (elapsed >= POLL_TIMEOUT_MS) {
        clearInterval(interval);
        setIsPolling(false);
        setPollTimeout(true);
        return;
      }

      pollFetcher.load(`/admin/apps/${appId}/domains/${domainId}/dns-check/${jobId}`);
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isPolling, jobId, appId, domainId]); // pollFetcher intentionally omitted — stable ref

  // React to poll results
  React.useEffect(() => {
    if (!isPolling) return;
    if (pollStatus === 'completed') {
      setIsPolling(false);
      revalidator.revalidate();
    } else if (pollStatus === 'failed' || pollStatus === 'not_found') {
      setIsPolling(false);
      setPollError('DNS check job failed. Please try again or check server logs.');
    }
  }, [pollStatus, isPolling]); // revalidator intentionally omitted — stable ref

  const isEnqueuing = enqueueFetcher.state !== 'idle';
  const isDisabled = isEnqueuing || isPolling;

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500 font-medium">DNS Health</p>
          <p className="mt-0.5 text-xs text-zinc-400">
            Most recent check result per record type.
          </p>
        </div>
        <enqueueFetcher.Form
          method="post"
          action={`/admin/apps/${appId}/domains/${domainId}/dns-check`}
        >
          <button
            type="submit"
            disabled={isDisabled}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw size={14} className={isDisabled ? 'animate-spin' : ''} />
            {isDisabled ? 'Checking…' : 'Verify Now'}
          </button>
        </enqueueFetcher.Form>
      </div>

      {/* Error banner */}
      {pollError && (
        <div className="flex items-center justify-between rounded-md border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <span>{pollError}</span>
          <button
            type="button"
            onClick={() => setPollError(null)}
            className="ml-4 text-red-400 hover:text-red-600"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Timeout banner */}
      {pollTimeout && (
        <div className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <span>
            Check is taking longer than expected. Results will appear after the next scheduled run.
          </span>
          <button
            type="button"
            onClick={() => setPollTimeout(false)}
            className="ml-4 text-amber-500 hover:text-amber-700"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Health table */}
      <div className="rounded-md border border-zinc-100 dark:border-zinc-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                Record Type
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                Status
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                Expected
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                Actual
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500 tabular-nums">
                Last Checked
              </th>
            </tr>
          </thead>
          <tbody>
            {dnsHealth.map((row) => (
              <tr
                key={row.recordType}
                className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors"
              >
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300 font-medium">
                  {RECORD_TYPE_LABELS[row.recordType]}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${getDnsStatusClass(row.status, isPolling)}`}
                  >
                    {getDnsStatusLabel(row.status, isPolling)}
                  </span>
                </td>
                <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400 max-w-xs">
                  {row.expected ? (
                    isDkimCname(row.recordType) ? (
                      <code className="font-mono text-xs break-all">{row.expected}</code>
                    ) : (
                      <span className="text-xs break-all">{row.expected}</span>
                    )
                  ) : (
                    <span className="text-xs text-zinc-400">-</span>
                  )}
                </td>
                <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400 max-w-xs">
                  <div>
                    {row.actual ? (
                      <span className="text-xs break-all">{row.actual}</span>
                    ) : (
                      <span className="text-xs text-zinc-400">-</span>
                    )}
                    {(row.status === 'fail' || row.status === 'error') && row.actual && (
                      <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{row.actual}</p>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 tabular-nums">
                  {row.checkedAt ? (
                    <span
                      className="text-xs text-zinc-500"
                      title={row.checkedAt.toISOString()}
                    >
                      {relativeTime(row.checkedAt)}
                    </span>
                  ) : (
                    <span className="text-xs text-zinc-400">Never</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =============================================================================
// Main component
// =============================================================================

export default function AdminAppDomainDetail({ loaderData }: Route.ComponentProps) {
  const { user, domain, appId, app, dmarcRua, dnsHealth } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();

  const justCreated = searchParams.get('created') === '1';
  const justVerified = searchParams.get('verified') === '1';
  const verifyError = searchParams.get('error') === 'verify';

  const [showCreatedBanner, setShowCreatedBanner] = React.useState(justCreated);
  const [showVerifiedBanner, setShowVerifiedBanner] = React.useState(justVerified);

  function dismissBanner(key: string) {
    setShowCreatedBanner(false);
    setShowVerifiedBanner(false);
    setSearchParams(
      (prev) => {
        prev.delete(key);
        return prev;
      },
      { replace: true },
    );
  }

  const tokens = domain.dkimTokens ?? [];
  const region = domain.region ?? 'eu-central-1';

  return (
    <AdminShell user={user} currentApp={app}>
      <div className="space-y-6">
        {showCreatedBanner && (
          <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300">
            <span>Domain &ldquo;{domain.name}&rdquo; registered successfully.</span>
            <button
              onClick={() => dismissBanner('created')}
              className="ml-4 text-green-600 hover:text-green-900"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {showVerifiedBanner && (
          <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300">
            <span>Verification check queued. Status will update within a few minutes.</span>
            <button
              onClick={() => dismissBanner('verified')}
              className="ml-4 text-blue-600 hover:text-blue-900"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
        {verifyError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
            Verification job could not be queued. Please try again or check the server logs.
          </div>
        )}

        <div className="flex items-center gap-4">
          <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{domain.name}</h2>
          <Badge variant={statusVariant(domain.dkimStatus)}>{domain.dkimStatus ?? 'pending'}</Badge>
        </div>

        {/* Fields panel */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-6 space-y-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Domain Name</p>
            <p className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">{domain.name}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Domain ID</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="text-sm font-mono text-zinc-900 dark:text-zinc-100">{domain.id}</code>
              <CopyButton text={domain.id} />
            </div>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Region</p>
            <p className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">{region}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Created At</p>
            <p className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">
              {new Date(domain.createdAt).toLocaleString()}
            </p>
          </div>
          {domain.verifiedAt && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Verified At</p>
              <p className="mt-1 text-sm text-zinc-900 dark:text-zinc-100">
                {new Date(domain.verifiedAt).toLocaleString()}
              </p>
            </div>
          )}
        </div>

        {/* DNS Records panel */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-6 space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">DNS Records</h3>
            <p className="mt-1 text-sm text-zinc-500">
              Publish these records at your DNS provider, then click Verify Now.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Required Records
            </p>
            {tokens.length === 0 && (
              <p className="text-sm text-zinc-500 italic">
                DKIM tokens not yet available. They are populated when the domain is created via
                SES.
              </p>
            )}
            {tokens.map((token, idx) => (
              <DnsRow
                key={token}
                label={`DKIM record ${idx + 1} of 3`}
                type="CNAME"
                host={`${token}._domainkey.${domain.name}`}
                value={`${token}.dkim.amazonses.com`}
              />
            ))}
            <DnsRow
              label="SPF: required for sending"
              type="TXT"
              host={domain.name}
              value={`"v=spf1 include:amazonses.com ~all"`}
            />
            <DnsRow
              label="DMARC: aggregate reporting"
              type="TXT"
              host={`_dmarc.${domain.name}`}
              value={buildDmarcRecordValue(dmarcRua)}
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Optional: Custom Mail-From Subdomain
            </p>
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-300 mb-2">
              <strong>Caution:</strong> Do NOT publish this MX record at the apex domain (
              {domain.name}) if it already receives mail (e.g. Google Workspace). Use the{' '}
              <code>bounces.{domain.name}</code> subdomain pattern below instead.
            </div>
            <DnsRow
              label="Custom Mail-From subdomain (opt-in)"
              type="MX"
              host={`bounces.${domain.name}`}
              value={`feedback-smtp.${region}.amazonses.com`}
              priority={10}
            />
          </div>
        </div>

        {/* Verification Status panel */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-6 space-y-4">
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Verification Status
          </h3>
          <div className="flex flex-wrap gap-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">SPF</span>
              <Badge variant={statusVariant(domain.spfStatus)}>
                {domain.spfStatus ?? 'pending'}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">DKIM</span>
              <Badge variant={statusVariant(domain.dkimStatus)}>
                {domain.dkimStatus ?? 'pending'}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">DMARC</span>
              <Badge variant={statusVariant(domain.dmarcStatus)}>
                {domain.dmarcStatus ?? 'pending'}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">MX</span>
              <Badge variant={statusVariant(domain.mxStatus)}>
                {domain.mxStatus ?? 'pending'}
              </Badge>
            </div>
          </div>
          <Form
            method="post"
            action={`/admin/apps/${appId}/domains/${domain.id}/verify`}
          >
            <Button type="submit">Verify Now</Button>
          </Form>
          <p className="text-xs text-zinc-500">
            Triggers a fresh SES DNS check. Results typically appear within a few minutes.
          </p>
        </div>

        {/* DNS Health section */}
        <DnsHealthSection
          dnsHealth={dnsHealth}
          appId={appId}
          domainId={domain.id}
        />
      </div>
    </AdminShell>
  );
}
