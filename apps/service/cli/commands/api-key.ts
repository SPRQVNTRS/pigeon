/**
 * API Key Commands
 */

import { Command } from 'commander';
import { createApiKey, revokeApiKey, listApiKeys } from '#app/models/api-keys.server';
import { output, printSuccess, printWarning } from '../lib/output';
import { apiKeyColumns } from '../lib/formatters/api-key';
import { toPublicApiKey } from '#app/lib/api-key-public';
import type { OutputFormat } from '../lib/types';

export function registerApiKeyCommands(program: Command): void {
  const apiKey = program
    .command('api-key')
    .description('Manage API keys');

  apiKey
    .command('list')
    .description('List API keys for an app')
    .requiredOption('--app <appId>', 'App ID')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .action(async (options) => {
      await listKeys(options);
    });

  apiKey
    .command('create')
    .description('Create a new API key for an app')
    .requiredOption('--app <appId>', 'App ID')
    .requiredOption('--name <name>', 'Key name/label')
    .action(async (options) => {
      await createKey(options);
    });

  apiKey
    .command('revoke <id>')
    .description('Revoke an API key')
    .requiredOption('--app <appId>', 'App ID (required for scope check)')
    .action(async (id, options) => {
      await revokeKey(id, options.app);
    });
}

async function listKeys(options: { app: string; format: OutputFormat }): Promise<void> {
  // The key hash never reaches the terminal, not even with --format json.
  const results = (await listApiKeys(options.app)).map(toPublicApiKey);
  output(options.format, results, apiKeyColumns, { total: results.length, limit: results.length, offset: 0 });
}

async function createKey(options: { app: string; name: string }): Promise<void> {
  const { plaintext, record } = await createApiKey({ appId: options.app, name: options.name });

  printSuccess(`API key created: ${record.name}`);
  printWarning('Store this key securely — it will not be shown again:');
  console.log(`\n  ${plaintext}\n`);
}

async function revokeKey(id: string, appId: string): Promise<void> {
  const record = await revokeApiKey(id, appId);
  printSuccess(`API key "${record.name}" (${record.prefix}...) has been revoked`);
}
