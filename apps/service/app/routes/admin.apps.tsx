import type { Route } from './+types/admin.apps';
import * as React from 'react';
import { Link } from 'react-router';
import { AppWindow, Globe, KeyRound, Users, Webhook } from 'lucide-react';
import AdminShell from '#app/components/admin-shell';
import { listApps } from '#app/models/apps.server';
import { countApiKeys } from '#app/models/api-keys.server';
import { countAudiences } from '#app/models/audiences.server';
import { countWebhooks } from '#app/models/webhooks.server';
import { countDomains } from '#app/models/domains.server';
import { getUser } from '#app/middleware/helpers';
import { Button } from '#app/components/ui/button';

export const handle = { title: 'Apps' };

export async function loader({ context }: Route.LoaderArgs) {
  const user = getUser(context);
  const apps = await listApps();

  const appCounts = await Promise.all(
    apps.map(async (app) => {
      const [keyCount, audienceCount, webhookCount, domainCount] = await Promise.all([
        countApiKeys(app.id),
        countAudiences(app.id),
        countWebhooks(app.id),
        countDomains(app.id),
      ]);
      return { appId: app.id, keyCount, audienceCount, webhookCount, domainCount };
    }),
  );

  const countsById = new Map(appCounts.map((c) => [c.appId, c]));

  const appsWithCounts = apps.map((app) => ({
    ...app,
    ...(countsById.get(app.id) ?? { keyCount: 0, audienceCount: 0, webhookCount: 0, domainCount: 0 }),
  }));

  return { user, apps: appsWithCounts };
}

type CountBadgeProps = {
  to: string;
  icon: React.ReactNode;
  label: string;
  count: number;
};

function CountBadge({ to, icon, label, count }: CountBadgeProps) {
  return (
    <Link
      to={to}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors tabular-nums"
      title={`Go to ${label}`}
    >
      {icon}
      {count}
    </Link>
  );
}

export default function AdminApps({ loaderData }: Route.ComponentProps) {
  const { user, apps } = loaderData;
  const [search, setSearch] = React.useState('');

  const filteredApps = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (app) =>
        app.name.toLowerCase().includes(q) ||
        app.id.toLowerCase().includes(q),
    );
  }, [apps, search]);

  return (
    <AdminShell user={user}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Apps
          </h1>
          <Button asChild size="sm">
            <Link to="/admin/apps/new">New App</Link>
          </Button>
        </div>

        {apps.length > 0 && (
          <input
            type="search"
            placeholder="Filter apps by name or ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full max-w-sm rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        )}

        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          {apps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <AppWindow size={40} className="text-zinc-300 dark:text-zinc-600 mb-3" />
              <p className="text-sm font-medium text-zinc-500">No apps yet</p>
              <p className="text-xs text-zinc-400 mt-1 mb-4">
                Create your first app to get started.
              </p>
              <Button asChild size="sm">
                <Link to="/admin/apps/new">New App</Link>
              </Button>
            </div>
          ) : filteredApps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-sm font-medium text-zinc-500">No apps match &ldquo;{search}&rdquo;</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    App ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Resources
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredApps.map((app) => (
                  <tr
                    key={app.id}
                    className="relative border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                      <Link
                        to={`/admin/apps/${app.id}`}
                        className="before:absolute before:inset-0 focus:outline-none focus-visible:before:ring-2 focus-visible:before:ring-blue-500 focus-visible:before:ring-inset"
                      >
                        {app.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500 tabular-nums">
                      {app.id.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <CountBadge
                          to={`/admin/apps/${app.id}/domains`}
                          icon={<Globe size={10} />}
                          label="Domains"
                          count={app.domainCount}
                        />
                        <CountBadge
                          to={`/admin/apps/${app.id}/keys`}
                          icon={<KeyRound size={10} />}
                          label="API Keys"
                          count={app.keyCount}
                        />
                        <CountBadge
                          to={`/admin/apps/${app.id}/audiences`}
                          icon={<Users size={10} />}
                          label="Audiences"
                          count={app.audienceCount}
                        />
                        <CountBadge
                          to={`/admin/apps/${app.id}/webhooks`}
                          icon={<Webhook size={10} />}
                          label="Webhooks"
                          count={app.webhookCount}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500 tabular-nums">
                      {new Date(app.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
