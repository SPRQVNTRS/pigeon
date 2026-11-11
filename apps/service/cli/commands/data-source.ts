/**
 * Data Source Commands
 *
 * NOTE: Data sources were part of the starter template and have been removed
 * from this service. This command stub is kept to avoid CLI registration errors.
 */

import { Command } from 'commander';
import { printWarning } from '../lib/output';

export function registerDataSourceCommands(program: Command): void {
  const dataSource = program
    .command('data-source')
    .description('Data source commands (removed)');

  dataSource
    .command('list')
    .description('List data sources (not available)')
    .action(async () => {
      printWarning('Data sources have been removed from this service.');
    });
}
