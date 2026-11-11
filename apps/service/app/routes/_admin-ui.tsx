/**
 * Admin UI layout: session auth + admin role gate for all /admin/* routes.
 *
 * Sibling to _auth.tsx (NOT nested inside it). The gate is the middleware:
 * authMiddleware sets userContext, then adminRoleMiddleware answers 403 for any
 * user without the admin role. Middleware runs for every request that matches
 * this layout, including child actions and `.data` requests that skip this
 * loader, so a child route needs no check of its own. The loader check stays
 * as defence in depth. test/admin-ui-authorization.test.ts enforces this for
 * every route under the layout.
 */
import type { Route } from './+types/_admin-ui';
import { Outlet, isRouteErrorResponse, useRouteError } from 'react-router';
import { authMiddleware } from '#app/middleware/auth';
import { adminRoleMiddleware } from '#app/middleware/admin-role';
import { getUser } from '#app/middleware/helpers';
import { assertAdmin } from '#app/services/permissions';

export const middleware = [authMiddleware, adminRoleMiddleware];

export async function loader({ context }: Route.LoaderArgs) {
  const user = getUser(context);
  assertAdmin(user);
  return { user };
}

export default function AdminUiLayout() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 403) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600">Access Denied</h1>
          <p className="mt-2 text-zinc-600">You must be an administrator to access this area.</p>
          <a href="/admin/dashboard" className="mt-4 inline-block text-blue-600 hover:underline">
            Back to Dashboard
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-red-600">Something went wrong</h1>
        <a href="/admin/dashboard" className="mt-4 inline-block text-blue-600 hover:underline">
          Back to Dashboard
        </a>
      </div>
    </div>
  );
}
