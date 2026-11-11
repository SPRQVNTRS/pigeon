/**
 * User Commands
 */

import { Command } from 'commander';
import { db } from '#drizzle/db';
import { users } from '#drizzle/schema';
import { eq } from 'drizzle-orm';
import { output, outputJson, printError, printSuccess, printWarning } from '../lib/output';
import { userColumns, printUserDetail } from '../lib/formatters/user';
import type { OutputFormat } from '../lib/types';
import type { SelectUser } from '#drizzle/schema';

/**
 * Sanitize user data by removing sensitive fields
 */
function sanitizeUser(user: SelectUser): Omit<SelectUser, 'password'> {
  const { password, ...safeUser } = user;
  return safeUser;
}

export function registerUserCommands(program: Command): void {
  const user = program
    .command('user')
    .description('Manage users');

  // List users
  user
    .command('list')
    .description('List all users')
    .option('-f, --format <format>', 'Output format: table, json, ids', 'table')
    .option('-l, --limit <n>', 'Limit results', '50')
    .option('--offset <n>', 'Offset for pagination', '0')
    .option('--active', 'Show only active users')
    .option('--deactivated', 'Show only deactivated users')
    .action(async (options) => {
      await listUsers(options);
    });

  // Get user by ID
  user
    .command('get <id>')
    .description('Get user details by ID')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .action(async (id, options) => {
      await getUser(parseInt(id, 10), options);
    });

  // Get user by email
  user
    .command('find <email>')
    .description('Find user by email')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .action(async (email, options) => {
      await findUserByEmail(email, options);
    });

  // Activate user
  user
    .command('activate <id>')
    .description('Activate a deactivated user')
    .action(async (id) => {
      await setUserActive(parseInt(id, 10), true);
    });

  // Deactivate user
  user
    .command('deactivate <id>')
    .description('Deactivate a user')
    .action(async (id) => {
      await setUserActive(parseInt(id, 10), false);
    });
}

interface ListUsersOptions {
  format: OutputFormat;
  limit: string;
  offset: string;
  active?: boolean;
  deactivated?: boolean;
}

async function listUsers(options: ListUsersOptions): Promise<void> {
  const limit = parseInt(options.limit, 10);
  const offset = parseInt(options.offset, 10);

  let allUsers = await db.query.users.findMany({
    orderBy: (users, { asc }) => [asc(users.id)],
  });

  // Apply filters
  if (options.active) {
    allUsers = allUsers.filter((u) => !u.deactivated);
  }
  if (options.deactivated) {
    allUsers = allUsers.filter((u) => u.deactivated);
  }

  const total = allUsers.length;
  const paginatedUsers = allUsers.slice(offset, offset + limit);
  const sanitizedUsers = paginatedUsers.map(sanitizeUser);

  output(options.format, sanitizedUsers, userColumns, { total, limit, offset });
}

async function getUser(id: number, options: { format: OutputFormat }): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, id),
  });

  if (!user) {
    printError(`User with ID ${id} not found`);
    process.exitCode = 1;
    return;
  }

  if (options.format === 'json') {
    outputJson(sanitizeUser(user));
  } else {
    printUserDetail(user);
  }
}

async function findUserByEmail(email: string, options: { format: OutputFormat }): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (!user) {
    printError(`User with email "${email}" not found`);
    process.exitCode = 1;
    return;
  }

  if (options.format === 'json') {
    outputJson(sanitizeUser(user));
  } else {
    printUserDetail(user);
  }
}

async function setUserActive(id: number, active: boolean): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, id),
  });

  if (!user) {
    printError(`User with ID ${id} not found`);
    process.exitCode = 1;
    return;
  }

  if (active && !user.deactivated) {
    printWarning(`User ${user.email} is already active`);
    return;
  }

  if (!active && user.deactivated) {
    printWarning(`User ${user.email} is already deactivated`);
    return;
  }

  await db.update(users).set({ deactivated: !active }).where(eq(users.id, id));

  printSuccess(`User ${user.email} has been ${active ? 'activated' : 'deactivated'}`);
}
