/**
 * Admin API layout — applies admin secret auth middleware to all /v1/admin/* routes.
 *
 * Kept separate from _api.tsx (tenant API key auth) so the two auth layers
 * can never accidentally share middleware. Admin routes are registered under
 * this layout in routes.ts using id: '_admin_api'.
 */
import { Outlet } from 'react-router';
import { adminAuthMiddleware } from '#app/middleware/admin-auth';
import { apiVersionHeaderMiddleware } from '#app/middleware/api-version-header';

export const middleware = [apiVersionHeaderMiddleware, adminAuthMiddleware];

export default function AdminApiLayout() {
  return <Outlet />;
}
