/**
 * Workflow Template Registry
 *
 * Centralizes all workflow templates for registration.
 * Email-service specific workflows will be registered here.
 */

import type { WorkflowTemplateWithHandlers } from '#app/workflows/types';

/**
 * All workflow templates with their handler references.
 */
export const workflowTemplates: WorkflowTemplateWithHandlers[] = [];
