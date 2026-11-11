import type { RoleType } from '#drizzle/types/enums';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, serial, text, boolean, timestamp } from 'drizzle-orm/pg-core';

// Workflow tables from the orchestrator package
import {
  workflows as _workflows,
  workflowOperations as _workflowOperations,
  workflowLocks as _workflowLocks,
} from '@sprqvntrs/workflows/schema';

export const workflows = _workflows;
export const workflowOperations = _workflowOperations;
export const workflowLocks = _workflowLocks;

// =============================================================================
// Users
// =============================================================================

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').unique().notNull(),
  deactivated: boolean('deactivated').default(false).notNull(),
  name: text('name').notNull(),
  password: text('password').notNull(),
  role: text('role').$type<RoleType>().default('editor').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export type InsertUser = InferInsertModel<typeof users>;
export type SelectUser = InferSelectModel<typeof users>;
