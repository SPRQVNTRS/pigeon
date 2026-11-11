/**
 * Metric Event Commands
 *
 * NOTE: Metric events were part of the starter template and have been removed
 * from this service. This command stub is kept to avoid CLI registration errors.
 */

import { Command } from 'commander';
import { printWarning } from '../lib/output';

export function registerMetricEventCommands(program: Command): void {
  const metricEvent = program
    .command('metric-event')
    .description('Metric event commands (removed)');

  metricEvent
    .command('list')
    .description('List metric events (not available)')
    .action(async () => {
      printWarning('Metric events have been removed from this service.');
    });
}
