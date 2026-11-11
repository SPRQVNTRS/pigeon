import type { SelectUser as User, InsertUser } from '#drizzle/schema';
import type { SessionUser } from '#app/types/session';
import invariant from 'tiny-invariant';
import bcrypt from 'bcryptjs';
import { Authenticator } from 'remix-auth';
import { FormStrategy } from 'remix-auth-form';
import { createUser, getUserByEmail } from '#app/models/users.server';

// Create an instance of the authenticator, pass a generic with what
// strategies will return and will store in the session
export const authenticator = new Authenticator<SessionUser>();

// Tell the Authenticator to use the form strategy
authenticator.use(
  new FormStrategy(async ({ form }) => {
    const email = form.get('email');
    const password = form.get('password');
    // You can validate the inputs however you want
    invariant(typeof email === 'string', 'email must be a string');
    invariant(email.length > 0, 'email must not be empty');

    invariant(typeof password === 'string', 'password must be a string');
    invariant(password.length > 0, 'password must not be empty');

    return await login({ email, password });
  }),
  // each strategy has a name and can be changed to use another one
  // same strategy multiple times, especially useful for the OAuth2 strategy.
  'user-pass',
);

/**
 * Authenticate user and return session data
 */
export async function login({
  email,
  password,
}: {
  email: string;
  password: string;
}): Promise<SessionUser> {
  const user = await getUserByEmail(email);
  if (!user) {
    throw new Error('Incorrect Login');
  }

  if (user.deactivated) {
    throw new Error('Account Deactivated');
  }

  const isValid = await bcrypt.compare(password, user.password);

  if (!isValid) {
    throw new Error('Incorrect Login');
  }

  const sessionUser: SessionUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };

  return sessionUser;
}

/**
 * Convert a database user to a session user (for refreshing session)
 */
export function userToSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

export async function register(user: InsertUser) {
  const exists = await getUserByEmail(user.email);
  if (exists) {
    return { error: `User already exists with that email` };
  }

  const newUser = await createUser(user);
  if (!newUser) {
    return {
      error: `Something went wrong trying to create a new user.`,
      fields: { email: user.email, password: user.password },
    };
  }
}
