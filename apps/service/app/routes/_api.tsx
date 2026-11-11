/**
 * API layout — applies API key authentication middleware to all /v1/* routes.
 * This layout has no UI; it exists purely to scope the middleware.
 */
import { Outlet } from 'react-router';
import { apiKeyAuthMiddleware } from '#app/middleware/api-key-auth';
import { apiVersionHeaderMiddleware } from '#app/middleware/api-version-header';

export const middleware = [apiVersionHeaderMiddleware, apiKeyAuthMiddleware];

export default function ApiLayout() {
  return <Outlet />;
}
