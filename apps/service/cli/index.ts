#!/usr/bin/env node
/**
 * Factory Stack CLI (Single-Tenant)
 *
 * A Laravel-style CLI for managing users, workflows, and database.
 *
 * Usage:
 *   pnpm cli --help
 *   pnpm cli user list
 *   pnpm cli workflow list --status=failed
 */

// Suppress verbose logging BEFORE any imports
process.env.CLI_MODE = 'true';
process.env.LOG_LEVEL = 'error';

import 'dotenv/config';
import { Command } from 'commander';
import { pool } from '#drizzle/db';
import { setColorsEnabled } from './lib/output';

// Import command registrations
import { registerUserCommands } from './commands/user';
import { registerWorkflowCommands } from './commands/workflow';
import { registerOperationCommands } from './commands/operation';
import { registerDbCommands } from './commands/db';
import { registerMetricEventCommands } from './commands/metric-event';
import { registerApiKeyCommands } from './commands/api-key';
import { registerDataSourceCommands } from './commands/data-source';

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('factory-cli')
    .description('Factory Stack CLI - Manage users, workflows, and database')
    .version('1.0.0')
    .option('--no-color', 'Disable colored output')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      if (opts.color === false) {
        setColorsEnabled(false);
      }
    });

  // Register all command groups
  registerUserCommands(program);
  registerWorkflowCommands(program);
  registerOperationCommands(program);
  registerDbCommands(program);
  registerMetricEventCommands(program);
  registerApiKeyCommands(program);
  registerDataSourceCommands(program);

  // Parse arguments
  await program.parseAsync(process.argv);
}

// Run and handle cleanup
main()
  .catch((error) => {
    console.error('CLI Error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Clean up database pool
    await pool.end();
  });
