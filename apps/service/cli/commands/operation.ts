/**
 * Operation Commands
 */

import { Command } from 'commander';
import { db } from '#drizzle/db';
import { workflowOperations, workflows } from '#drizzle/schema';
import { eq, desc, and } from 'drizzle-orm';
import { output, outputJson, printError, printSection, c } from '../lib/output';
import { operationColumns, printOperationDetail, type OperationRow } from '../lib/formatters/workflow';
import type { OutputFormat } from '../lib/types';

export function registerOperationCommands(program: Command): void {
  const operation = program
    .command('operation')
    .description('Manage workflow operations');

  // List operations
  operation
    .command('list')
    .description('List operations')
    .option('-f, --format <format>', 'Output format: table, json, ids', 'table')
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('--offset <n>', 'Offset for pagination', '0')
    .option('--status <status>', 'Filter by status (pending, running, completed, failed, skipped)')
    .option('--workflow <id>', 'Filter by workflow ID')
    .option('--type <type>', 'Filter by operation type')
    .option('--failed', 'Show only failed operations')
    .action(async (options) => {
      await listOperations(options);
    });

  // Get operation by ID
  operation
    .command('get <id>')
    .description('Get operation details by ID')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .action(async (id, options) => {
      await getOperation(id, options);
    });

  // Get operation result data
  operation
    .command('data <id>')
    .description('Get operation result data')
    .option('--summary', 'Show summary instead of full data')
    .action(async (id, options) => {
      await getOperationData(id, options);
    });

  // Get operation error/logs
  operation
    .command('logs <id>')
    .description('Get operation error and logs')
    .option('--full', 'Show full error details')
    .action(async (id, options) => {
      await getOperationLogs(id, options);
    });

  // Find operations by criteria
  operation
    .command('find')
    .description('Find operations by criteria')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .option('--type <type>', 'Operation type pattern')
    .option('--status <status>', 'Operation status')
    .option('--stage <stage>', 'Workflow stage')
    .option('-l, --limit <n>', 'Limit results', '20')
    .action(async (options) => {
      await findOperations(options);
    });

  // Operation stats
  operation
    .command('stats')
    .description('Show operation statistics')
    .option('--workflow <id>', 'Filter by workflow ID')
    .action(async (options) => {
      await showOperationStats(options);
    });
}

interface ListOperationsOptions {
  format: OutputFormat;
  limit: string;
  offset: string;
  status?: string;
  workflow?: string;
  type?: string;
  failed?: boolean;
}

async function listOperations(options: ListOperationsOptions): Promise<void> {
  const limit = parseInt(options.limit, 10);
  const offset = parseInt(options.offset, 10);

  // Build conditions
  const conditions = [];
  if (options.status) {
    conditions.push(eq(workflowOperations.status, options.status));
  }
  if (options.workflow) {
    conditions.push(eq(workflowOperations.workflowId, options.workflow));
  }
  if (options.type) {
    conditions.push(eq(workflowOperations.type, options.type));
  }
  if (options.failed) {
    conditions.push(eq(workflowOperations.status, 'failed'));
  }

  const allOperations = await db.query.workflowOperations.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: [desc(workflowOperations.createdAt)],
  });

  const total = allOperations.length;
  const paginatedOperations = allOperations.slice(offset, offset + limit);

  output(options.format, paginatedOperations as OperationRow[], operationColumns, { total, limit, offset });
}

async function getOperation(id: string, options: { format: OutputFormat }): Promise<void> {
  const operation = await db.query.workflowOperations.findFirst({
    where: eq(workflowOperations.id, id),
  });

  if (!operation) {
    printError(`Operation with ID ${id} not found`);
    process.exitCode = 1;
    return;
  }

  if (options.format === 'json') {
    outputJson(operation);
    return;
  }

  printOperationDetail(operation as OperationRow);
}

async function getOperationData(id: string, options: { summary?: boolean }): Promise<void> {
  const operation = await db.query.workflowOperations.findFirst({
    where: eq(workflowOperations.id, id),
  });

  if (!operation) {
    printError(`Operation with ID ${id} not found`);
    process.exitCode = 1;
    return;
  }

  if (!operation.result) {
    printError('Operation has no result data');
    return;
  }

  if (options.summary) {
    const result = operation.result as Record<string, unknown>;
    printSection('Operation Result Summary');
    console.log(`Type: ${typeof operation.result}`);
    if (typeof result === 'object' && result !== null) {
      console.log(`Keys: ${Object.keys(result).join(', ')}`);
      for (const [key, value] of Object.entries(result)) {
        if (typeof value === 'string') {
          console.log(`  ${key}: ${value.length > 100 ? value.slice(0, 100) + '...' : value}`);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          console.log(`  ${key}: ${value}`);
        } else if (Array.isArray(value)) {
          console.log(`  ${key}: Array(${value.length})`);
        } else if (typeof value === 'object' && value !== null) {
          console.log(`  ${key}: Object(${Object.keys(value).length} keys)`);
        }
      }
    }
  } else {
    console.log(JSON.stringify(operation.result, null, 2));
  }
}

async function getOperationLogs(id: string, options: { full?: boolean }): Promise<void> {
  const operation = await db.query.workflowOperations.findFirst({
    where: eq(workflowOperations.id, id),
  });

  if (!operation) {
    printError(`Operation with ID ${id} not found`);
    process.exitCode = 1;
    return;
  }

  if (!operation.errorMessage) {
    console.log(c.dim('No error message for this operation'));
    return;
  }

  printSection('Error Message');
  console.log(c.red(operation.errorMessage));

  // Check if result contains additional error info
  if (operation.result && options.full) {
    const result = operation.result as Record<string, unknown>;
    if (result.error || result.stack || result.details) {
      printSection('Additional Error Details');
      if (result.error) console.log(`Error: ${result.error}`);
      if (result.stack) {
        printSection('Stack Trace');
        console.log(c.dim(String(result.stack)));
      }
      if (result.details) {
        printSection('Details');
        console.log(JSON.stringify(result.details, null, 2));
      }
    }
  }
}

interface FindOperationsOptions {
  format: OutputFormat;
  type?: string;
  status?: string;
  stage?: string;
  limit: string;
}

async function findOperations(options: FindOperationsOptions): Promise<void> {
  const limit = parseInt(options.limit, 10);

  // Build conditions
  const conditions = [];
  if (options.status) {
    conditions.push(eq(workflowOperations.status, options.status));
  }
  if (options.type) {
    conditions.push(eq(workflowOperations.type, options.type));
  }
  if (options.stage) {
    conditions.push(eq(workflowOperations.stage, options.stage));
  }

  if (conditions.length === 0) {
    printError('At least one search criterion is required (--type, --status, or --stage)');
    process.exitCode = 1;
    return;
  }

  const operations = await db.query.workflowOperations.findMany({
    where: and(...conditions),
    orderBy: [desc(workflowOperations.createdAt)],
    limit,
  });

  output(options.format, operations as OperationRow[], operationColumns, {
    total: operations.length,
    limit,
    offset: 0,
  });
}

async function showOperationStats(options: { workflow?: string }): Promise<void> {
  const conditions = options.workflow
    ? eq(workflowOperations.workflowId, options.workflow)
    : undefined;

  const allOperations = await db.query.workflowOperations.findMany({
    where: conditions,
  });

  // Calculate stats
  const stats = {
    total: allOperations.length,
    byStatus: {} as Record<string, number>,
    byType: {} as Record<string, number>,
    byStage: {} as Record<string, number>,
    avgAttempts: 0,
  };

  let totalAttempts = 0;
  for (const op of allOperations) {
    stats.byStatus[op.status] = (stats.byStatus[op.status] || 0) + 1;
    stats.byType[op.type] = (stats.byType[op.type] || 0) + 1;
    stats.byStage[op.stage] = (stats.byStage[op.stage] || 0) + 1;
    totalAttempts += op.attempts;
  }
  stats.avgAttempts = allOperations.length > 0 ? totalAttempts / allOperations.length : 0;

  printSection('Operation Statistics');
  console.log(`Total operations: ${c.bold(String(stats.total))}`);
  console.log(`Average attempts: ${stats.avgAttempts.toFixed(2)}`);

  printSection('By Status');
  for (const [status, count] of Object.entries(stats.byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status}: ${count}`);
  }

  printSection('By Type');
  for (const [type, count] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  printSection('By Stage');
  for (const [stage, count] of Object.entries(stats.byStage).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${stage}: ${count}`);
  }
}
