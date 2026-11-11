import type { MiddlewareFunction } from 'react-router';
import { redirect } from 'react-router';
import type { SessionUser } from '#app/types/session';
import { sessionStorage } from '#app/services/session.server';
import { userContext } from './context';
import { db } from '#drizzle/db';
import { users } from '#drizzle/schema';
import { eq } from 'drizzle-orm';

/**
 * Authentication middleware that runs before route loaders/actions
 * Validates session and provides user context to routes
 */
export const authMiddleware: MiddlewareFunction = async ({ request, context }) => {
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  const sessionUser = session.get('user') as SessionUser | null;

  if (!sessionUser) {
    throw redirect('/login');
  }

  // Verify user still exists and is not deactivated
  const dbUser = await db.query.users.findFirst({
    where: eq(users.id, sessionUser.id),
  });

  if (!dbUser || dbUser.deactivated) {
    throw redirect('/login', {
      headers: { 'Set-Cookie': await sessionStorage.destroySession(session) },
    });
  }

  context.set(userContext, dbUser);
};
