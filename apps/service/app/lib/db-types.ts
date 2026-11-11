/**
 * Database handle types, importable without opening a connection.
 *
 * `#drizzle/db` builds a pool from CONFIG the moment it is imported. Code that
 * takes the handle as a parameter (the retention pass, the recipient erase)
 * imports these types instead, so a test can hand it a handle for a throwaway
 * database.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '#drizzle/schema/index';

export type Database = NodePgDatabase<typeof schema>;

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** A handle a model function can run its SQL on: the pool, or an open transaction. */
export type Executor = Database | Transaction;
