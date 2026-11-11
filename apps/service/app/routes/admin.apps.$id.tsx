import type { Route } from './+types/admin.apps.$id';
import { Link, useSearchParams } from 'react-router';
import * as React from 'react';
import { Copy, Check, X, Globe, KeyRound, Users, Webhook } from 'lucide-react';
import AdminShell from '#app/components/admin-shell';
import { getAppById } from '#app/models/apps.server';
import { countApiKeys } from '#app/models/api-keys.server';
import { countAudiences } from '#app/models/audiences.server';
import { countWebhooks } from '#app/models/webhooks.server';
import { countDomains } from '#app/models/domains.server';
import { getUser } from '#app/middleware/helpers';

export const handle = { title: 'App Details' };

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = getUser(context);
  const [app, keyCount, audienceCount, webhookCount, domainCount] = await Promise.all([
    getAppById(params.id),
    countApiKeys(params.id),
    countAudiences(params.id),
    countWebhooks(params.id),
    countDomains(params.id),
  ]);
  if (!app) {
    throw new Response('Not Found', { status: 404 });
  }
  return { user, app, keyCount, audienceCount, webhookCount, domainCount };
}

type ResourceCardProps = {
  to: string;
  icon: React.ReactNode;
  label: string;
  count: number;
};

function ResourceCard({ to, icon, label, count }: ResourceCardProps) {
  return (
    <Link
      to={to}
      className="flex flex-col gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow-sm transition-all"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">{label}</span>
        <span className="text-zinc-400 dark:text-zinc-500">{icon}</span>
      </div>
      <p className="text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
        {count}
      </p>
    </Link>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-4 first:pt-0 last:pb-0 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-400 mb-1">{label}</p>
      {children}
    </div>
  );
}

export default function AdminAppDetail({ loaderData }: Route.ComponentProps) {
  const { user, app, keyCount, audienceCount, webhookCount, domainCount } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const justCreated = searchParams.get('created') === '1';
  const [showBanner, setShowBanner] = React.useState(justCreated);
  const [copied, setCopied] = React.useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(app.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function dismissBanner() {
    setShowBanner(false);
    setSearchParams(
      (prev) => {
        prev.delete('created');
        return prev;
      },
      { replace: true },
    );
  }

  return (
    <AdminShell user={user} currentApp={app}>
      <div className="space-y-6 max-w-2xl">
        {showBanner && (
          <div className="flex items-center justify-between rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-4 py-3 text-sm text-green-800 dark:text-green-300">
            <span>App &ldquo;{app.name}&rdquo; created successfully.</span>
            <button
              onClick={dismissBanner}
              className="ml-4 text-green-600 hover:text-green-900 dark:text-green-400 dark:hover:text-green-100 transition-colors"
              aria-label="Dismiss"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {app.name}
        </h1>

        {/* Resource summary cards */}
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400 mb-3">Resources</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ResourceCard
              to={`/admin/apps/${app.id}/domains`}
              icon={<Globe size={16} />}
              label="Domains"
              count={domainCount}
            />
            <ResourceCard
              to={`/admin/apps/${app.id}/keys`}
              icon={<KeyRound size={16} />}
              label="API Keys"
              count={keyCount}
            />
            <ResourceCard
              to={`/admin/apps/${app.id}/audiences`}
              icon={<Users size={16} />}
              label="Audiences"
              count={audienceCount}
            />
            <ResourceCard
              to={`/admin/apps/${app.id}/webhooks`}
              icon={<Webhook size={16} />}
              label="Webhooks"
              count={webhookCount}
            />
          </div>
        </div>

        {/* App metadata — demoted to secondary section */}
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400 mb-3">Details</p>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4">
            <FieldRow label="App Name">
              <p className="text-sm text-zinc-900 dark:text-zinc-100">{app.name}</p>
            </FieldRow>

            <FieldRow label="App ID">
              <div className="flex items-center gap-2">
                <code className="text-sm font-mono text-zinc-900 dark:text-zinc-100 select-all">
                  {app.id}
                </code>
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <Check size={14} className="text-green-600" />
                  ) : (
                    <Copy size={14} />
                  )}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </FieldRow>

            <FieldRow label="Created">
              <p className="text-sm text-zinc-700 dark:text-zinc-300 tabular-nums">
                {new Date(app.createdAt).toLocaleString()}
              </p>
            </FieldRow>
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
