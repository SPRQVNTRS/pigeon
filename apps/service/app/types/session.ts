import type { RoleType } from '#drizzle/types/enums';

/**
 * User type stored in session
 */
export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: RoleType;
}

/**
 * Session data structure
 */
export interface SessionData {
  user: SessionUser;
}
