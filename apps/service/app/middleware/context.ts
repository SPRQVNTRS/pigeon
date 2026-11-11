import type { SelectUser } from '#drizzle/schema';
import { createContext } from 'react-router';

/**
 * Authenticated user type available in route context
 */
export type AuthenticatedUser = SelectUser;

/** User context - set by authMiddleware */
export const userContext = createContext<AuthenticatedUser | null>(null);
