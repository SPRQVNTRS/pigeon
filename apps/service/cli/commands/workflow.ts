/**
 * Workflow Commands
 */

import { Command } from 'commander';
import { db } from '#drizzle/db';
import { workflows, workflowOperations } from '#drizzle/schema';
import { eq, desc, and } from 'drizzle-orm';
import { output, outputJson, outputTable, printError, printSuccess, printWarning, printSection, c } from '../lib/output';
import {
  workflowColumns,
  printWorkflowDetail,
  operationColumns,
  type WorkflowRow,
  type OperationRow,
} from '../lib/formatters/workflow';
import type { OutputFormat } from '../lib/types';

export function registerWorkflowCommands(program: Command): void {
  const workflow = program
    .command('workflow')
    .description('Manage workflows');

  // List workflows
  workflow
    .command('list')
    .description('List workflows')
    .option('-f, --format <format>', 'Output format: table, json, ids', 'table')
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('--offset <n>', 'Offset for pagination', '0')
    .option('--status <status>', 'Filter by status (pending, running, completed, failed, cancelled)')
    .option('--type <type>', 'Filter by workflow type')
    .action(async (options) => {
      await listWorkflows(options);
    });

  // Get workflow by ID
  workflow
    .command('get <id>')
    .description('Get workflow details by ID')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .option('--with-operations', 'Include workflow operations')
    .action(async (id, options) => {
      await getWorkflow(id, options);
    });

  // List operations for a workflow
  workflow
    .command('operations <workflowId>')
    .description('List operations for a workflow')
    .option('-f, --format <format>', 'Output format: table, json', 'table')
    .option('--status <status>', 'Filter by status')
    .action(async (workflowId, options) => {
      await listOperations(workflowId, options);
    });

  // Get workflow context
  workflow
    .command('context <id>')
    .description('Get workflow context JSON')
    .action(async (id) => {
      await getWorkflowContext(id);
    });

  // Cancel workflow
  workflow
    .command('cancel <id>')
    .description('Cancel a pending or running workflow')
    .option('--force', 'Force cancel even if running')
    .action(async (id, options) => {
      await cancelWorkflow(id, options);
    });

  // Workflow stats
  workflow
    .command('stats')
    .description('Show workflow statistics')
    .action(async () => {
      await showStats();
    });
}

interface ListWorkflowsOptions {
  format: OutputFormat;
  limit: string;
  offset: string;
  status?: string;
  type?: string;
}

async function listWorkflows(options: ListWorkflowsOptions): Promise<void> {
  const limit = parseInt(options.limit, 10);
  const offset = parseInt(options.offset, 10);

  // Build conditions
  const conditions = [];
  if (options.status) {
    conditions.push(eq(workflows.status, options.status));
  }
  if (options.type) {
    conditions.push(eq(workflows.type, options.type));
  }

  const allWorkflows = await db.query.workflows.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: [desc(workflows.createdAt)],
  });

  const total = allWorkflows.length;
  const paginatedWorkflows = allWorkflows.slice(offset, offset + limit);

  output(options.format, paginatedWorkflows as WorkflowRow[], workflowColumns, { total, limit, offset });
}

async function getWorkflow(
  id: string,
  options: { format: OutputFormat; withOperations?: boolean },
): Promise<void> {
  const workflow = await db.query.workflows.findFirst({
    where: eq(workflows.id, id),
  });

  if (!workflow) {
    printError(`Workflow with ID ${id} not found`);
    process.exitCode = 1;
    return;
  }

  if (options.format === 'json') {
    if (options.withOperations) {
      const operations = await db.query.workflowOperations.findMany({
        where: eq(workflowOperations.workflowId, id),
        orderBy: [workflowOperations.createdAt],
      });
      outputJson({ ...workflow, operations });
    } else {
      outputJson(workflow);
    }
    return;
  }

  printWorkflowDetail(workflow as WorkflowRow);

  if (options.withOperations) {
    const operations = await db.query.workflowOperations.findMany({
      where: eq(workflowOperations.workflowId, id),
      orderBy: [workflowOperations.createdAt],
    });

    if (operations.length > 0) {
      printSection('Operations');
      outputTable(operations as OperationRow[], operationColumns);
    }
  }
}

async function listOperations(
  workflowId: string,
  options: { format: OutputFormat; status?: string },
): Promise<void> {
  const workflow = await db.query.workflows.findFirst({
    where: eq(workflows.id, workflowId),
  });

  if (!workflow) {
    printError(`Workflow with ID ${workflowId} not found`);
    process.exitCode = 1;
    return;
  }

  const conditions = [eq(workflowOperations.workflowId, workflowId)];
  if (options.status) {
    conditions.push(eq(workflowOperations.status, options.status));
  }

  const operations = await db.query.workflowOperations.findMany({
    where: and(...conditions),
    orderBy: [workflowOperations.createdAt],
  });

  if (options.format === 'json') {
    outputJson(operations);
    return;
  }

  if (operations.length === 0) {
    printWarning(`Workflow ${workflowId} has no operations`);
    return;
  }

  outputTable(operations as OperationRow[], operationColumns, {
    total: operations.length,
    limit: operations.length,
    offset: 0,
  });
}

async function getWorkflowContext(id: string): Promise<void> {
  const workflow = await db.query.workflows.findFirst({
    where: eq(workflows.id, id),
  });

  if (!workflow) {
    printError(`Workflow with ID ${id} not found`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(workflow.context, null, 2));
}

async function cancelWorkflow(id: string, options: { force?: boolean }): Promise<void> {
  const workflow = await db.query.workflows.findFirst({
    where: eq(workflows.id, id),
  });

  if (!workflow) {
    printError(`Workflow with ID ${id} not found`);
    process.exitCode = 1;
    return;
  }

  if (workflow.status === 'completed') {
    printWarning('Cannot cancel a completed workflow');
    return;
  }

  if (workflow.status === 'cancelled') {
    printWarning('Workflow is already cancelled');
    return;
  }

  if (workflow.status === 'failed') {
    printWarning('Workflow has already failed');
    return;
  }

  if (workflow.status === 'running' && !options.force) {
    printWarning('Workflow is currently running. Use --force to cancel it');
    return;
  }

  await db
    .update(workflows)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(eq(workflows.id, id));

  printSuccess(`Workflow ${id} has been cancelled`);
}

async function showStats(): Promise<void> {
  const allWorkflows = await db.query.workflows.findMany();

  // Calculate stats
  const stats = {
    total: allWorkflows.length,
    byStatus: {} as Record<string, number>,
    byType: {} as Record<string, number>,
  };

  for (const w of allWorkflows) {
    stats.byStatus[w.status] = (stats.byStatus[w.status] || 0) + 1;
    stats.byType[w.type] = (stats.byType[w.type] || 0) + 1;
  }

  printSection('Workflow Statistics');
  console.log(`Total workflows: ${c.bold(String(stats.total))}`);

  printSection('By Status');
  for (const [status, count] of Object.entries(stats.byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status}: ${count}`);
  }

  printSection('By Type');
  for (const [type, count] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }
}
