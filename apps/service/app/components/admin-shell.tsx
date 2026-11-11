import * as React from 'react';
import { Link, Form, useLocation } from 'react-router';
import {
  LayoutDashboard,
  AppWindow,
  Globe,
  KeyRound,
  Users,
  Webhook,
  LogOut,
  ListTodo,
} from 'lucide-react';
import type { SelectUser } from '#drizzle/schema';
import { ThemeToggle } from '#app/components/theme-toggle';

type CurrentApp = { id: string; name: string };

type AdminShellProps = {
  user: SelectUser;
  currentApp?: CurrentApp | null;
  children: React.ReactNode;
};

// ─── Sidebar nav link ───────────────────────────────────────────────────────

type NavLinkProps = {
  to: string;
  icon: React.ReactNode;
  children: React.ReactNode;
};

function NavLink({ to, icon, children }: NavLinkProps) {
  const location = useLocation();
  const isActive =
    to === '/admin/dashboard'
      ? location.pathname === '/admin/dashboard' || location.pathname === '/admin'
      : location.pathname.startsWith(to);

  return (
    <Link
      to={to}
      className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
        isActive
          ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white font-medium'
          : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-100'
      }`}
    >
      <span className="shrink-0 text-current opacity-70">{icon}</span>
      {children}
    </Link>
  );
}

// ─── Breadcrumb ─────────────────────────────────────────────────────────────

type BreadcrumbItem = { label: string; to?: string };

function buildBreadcrumbs(
  pathname: string,
  currentApp: CurrentApp | null | undefined,
): BreadcrumbItem[] {
  // /admin or /admin/dashboard
  if (pathname === '/admin' || pathname === '/admin/dashboard') {
    return [{ label: 'Dashboard' }];
  }

  // /admin/apps — flat list
  if (pathname === '/admin/apps' || pathname === '/admin/apps/new') {
    const crumbs: BreadcrumbItem[] = [{ label: 'Apps', to: '/admin/apps' }];
    if (pathname === '/admin/apps/new') {
      crumbs.push({ label: 'New App' });
    }
    return crumbs;
  }

  // /admin/apps/:appId/... — app-scoped pages
  const appScopedMatch = pathname.match(/^\/admin\/apps\/([^/]+)(\/.*)?$/);
  if (!appScopedMatch) {
    return [{ label: 'Admin' }];
  }

  const appCrumb: BreadcrumbItem = currentApp
    ? { label: currentApp.name, to: `/admin/apps/${currentApp.id}` }
    : { label: 'App', to: appScopedMatch[1] ? `/admin/apps/${appScopedMatch[1]}` : undefined };

  const rest = appScopedMatch[2] ?? '';

  if (!rest || rest === '/') {
    return [{ label: 'Apps', to: '/admin/apps' }, { label: appCrumb.label }];
  }

  // Resource pages
  const resourceMatch = rest.match(/^\/([^/]+)(\/([^/]+))?(\/([^/]+))?/);
  if (!resourceMatch) {
    return [{ label: 'Apps', to: '/admin/apps' }, appCrumb];
  }

  const resource = resourceMatch[1]; // e.g. domains, keys, audiences, webhooks
  const resourceLabel = RESOURCE_LABELS[resource] ?? resource;
  const subId = resourceMatch[3];
  const subAction = resourceMatch[5];

  const crumbs: BreadcrumbItem[] = [
    { label: 'Apps', to: '/admin/apps' },
    appCrumb,
  ];

  if (resource === 'domains') {
    if (!subId) {
      crumbs.push({ label: 'Domains' });
    } else if (subId === 'new') {
      crumbs.push({ label: 'Domains', to: currentApp ? `/admin/apps/${currentApp.id}/domains` : undefined });
      crumbs.push({ label: 'Add Domain' });
    } else if (subAction === 'verify') {
      crumbs.push({ label: 'Domains', to: currentApp ? `/admin/apps/${currentApp.id}/domains` : undefined });
      crumbs.push({ label: 'Verify Domain' });
    } else {
      crumbs.push({ label: 'Domains', to: currentApp ? `/admin/apps/${currentApp.id}/domains` : undefined });
      crumbs.push({ label: subId });
    }
    return crumbs;
  }

  if (resource === 'audiences') {
    if (!subId) {
      crumbs.push({ label: 'Audiences' });
    } else {
      const contactsSegment = subAction;
      crumbs.push({ label: 'Audiences', to: currentApp ? `/admin/apps/${currentApp.id}/audiences` : undefined });
      if (contactsSegment === 'contacts') {
        crumbs.push({ label: subId });
        crumbs.push({ label: 'Contacts' });
      } else {
        crumbs.push({ label: subId });
      }
    }
    return crumbs;
  }

  crumbs.push({ label: resourceLabel });
  return crumbs;
}

const RESOURCE_LABELS: Record<string, string> = {
  domains: 'Domains',
  keys: 'API Keys',
  audiences: 'Audiences',
  webhooks: 'Webhooks',
};

function Breadcrumb({ currentApp }: { currentApp: CurrentApp | null | undefined }) {
  const location = useLocation();
  const items = buildBreadcrumbs(location.pathname, currentApp);

  if (items.length === 0) return null;

  return (
    <nav className="flex items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400">
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <React.Fragment key={idx}>
            {idx > 0 && (
              <span className="text-zinc-300 dark:text-zinc-600 select-none">&rsaquo;</span>
            )}
            {isLast || !item.to ? (
              <span className={isLast ? 'text-zinc-900 dark:text-zinc-100 font-medium' : ''}>
                {item.label}
              </span>
            ) : (
              <Link
                to={item.to}
                className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
              >
                {item.label}
              </Link>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

// ─── Shell ───────────────────────────────────────────────────────────────────

export default function AdminShell({ user, currentApp, children }: AdminShellProps) {
  return (
    <div className="flex min-h-screen bg-white dark:bg-zinc-950">
      {/* Left sidebar */}
      <aside className="w-60 shrink-0 flex flex-col border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 sticky top-0 h-screen overflow-y-auto">
        {/* Header */}
        <div className="px-4 py-5 border-b border-zinc-200 dark:border-zinc-800">
          <span className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Pigeon Admin
          </span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-6">
          {/* Overview section */}
          <div>
            <p className="mb-1.5 px-3 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Overview
            </p>
            <div className="space-y-0.5">
              <NavLink to="/admin/dashboard" icon={<LayoutDashboard size={15} />}>
                Dashboard
              </NavLink>
              <NavLink to="/admin/apps" icon={<AppWindow size={15} />}>
                Apps
              </NavLink>
              <NavLink to="/admin/jobs" icon={<ListTodo size={15} />}>
                Jobs
              </NavLink>
            </div>
          </div>

          {/* App-scoped section — only when inside an app */}
          {currentApp && (
            <div>
              <p className="mb-1.5 px-3 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 truncate">
                App: {currentApp.name}
              </p>
              <div className="space-y-0.5">
                <NavLink to={`/admin/apps/${currentApp.id}/domains`} icon={<Globe size={15} />}>
                  Domains
                </NavLink>
                <NavLink to={`/admin/apps/${currentApp.id}/keys`} icon={<KeyRound size={15} />}>
                  API Keys
                </NavLink>
                <NavLink to={`/admin/apps/${currentApp.id}/audiences`} icon={<Users size={15} />}>
                  Audiences
                </NavLink>
                <NavLink to={`/admin/apps/${currentApp.id}/webhooks`} icon={<Webhook size={15} />}>
                  Webhooks
                </NavLink>
              </div>
            </div>
          )}
        </nav>

        {/* Footer */}
        <div className="border-t border-zinc-200 dark:border-zinc-800">
          <div className="px-4 py-4 space-y-2">
            <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate">
              {user.name}
            </p>
            <Form action="/logout" method="post">
              <button
                type="submit"
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
              >
                <LogOut size={13} />
                Sign out
              </button>
            </Form>
          </div>
          <div
            className="px-3 py-2 font-mono text-[10px] text-zinc-400 dark:text-zinc-600 border-t border-zinc-200 dark:border-zinc-800"
            title={`Build ${__BUILD_HASH__}`}
          >
            {__BUILD_HASH__}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 px-8 py-8 max-w-5xl">
        <div className="flex items-center justify-between mb-6">
          <Breadcrumb currentApp={currentApp} />
          <ThemeToggle />
        </div>
        {children}
      </main>
    </div>
  );
}
