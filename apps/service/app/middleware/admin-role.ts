import type { MiddlewareFunction } from 'react-router';
import { getUser } from './helpers';
import { assertAdmin } from '#app/services/permissions';

/**
 * Admin role gate for the admin UI layout. It must come after authMiddleware,
 * which puts the signed-in user in the context.
 *
 * Middleware runs for every request that matches the layout: a document GET,
 * a `.data` request that names only one child loader, and an action. A role
 * check in the layout loader alone covers none of the last two, because React
 * Router runs child loaders in parallel with the layout loader, lets a `.data`
 * request skip it, and runs an action with no loader before it.
 *
 * Throws a 403 Response for any user without the admin role.
 */
export const adminRoleMiddleware: MiddlewareFunction = ({ context }, next) => {
  assertAdmin(getUser(context));
  return next();
};
