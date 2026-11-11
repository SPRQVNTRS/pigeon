/**
 * Workflows Public API
 *
 * Main entry point for workflow templates and operation handlers.
 * Email-service specific workflows will be added in specs 04-06.
 *
 * Usage:
 * ```typescript
 * import { registerAllWorkflows } from '#app/workflows';
 * registerAllWorkflows(orchestrator);
 * ```
 */

import type { WorkflowOrchestrator, WorkflowTemplate, OperationHandler } from '@sprqvntrs/workflows';
import type { WorkflowTemplateWithHandlers } from './types';

// Re-export templates
export { workflowTemplates } from './templates';

// Re-export structured operation handlers for use in templates
export { operationHandlers } from './operations';

// Re-export types
export { WORKFLOW_TYPES } from './types';
export type {
  WorkflowTemplateWithHandlers,
  OperationWithHandler,
  StageWithHandlers,
  WorkflowType,
} from './types';

// Import for helper functions
import { workflowTemplates } from './templates';

/**
 * Extract the base WorkflowTemplate (without handlers) for orchestrator registration.
 */
function extractBaseTemplate(template: WorkflowTemplateWithHandlers): WorkflowTemplate {
  return {
    ...template,
    stages: template.stages.map((stage) => ({
      ...stage,
      operations: stage.operations.map(({ handler: _, ...op }) => op),
    })),
  };
}

/**
 * Extract all operation handlers from templates as a flat registry.
 */
function extractOperationHandlers(
  templates: WorkflowTemplateWithHandlers[]
): Record<string, OperationHandler> {
  const handlers: Record<string, OperationHandler> = {};

  for (const template of templates) {
    for (const stage of template.stages) {
      for (const operation of stage.operations) {
        handlers[operation.type] = operation.handler;
      }
    }
  }

  return handlers;
}

/**
 * Register all workflow templates and operation handlers with the orchestrator.
 */
export function registerAllWorkflows(orchestrator: WorkflowOrchestrator): void {
  const baseTemplates = workflowTemplates.map(extractBaseTemplate);
  const handlers = extractOperationHandlers(workflowTemplates);

  orchestrator.registerTemplates(baseTemplates);
  orchestrator.registerOperations(handlers);
}
