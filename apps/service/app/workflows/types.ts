/**
 * Workflow Types & Constants
 *
 * Centralized type definitions for workflow templates with handler references.
 */

import type { OperationHandler, WorkflowTemplate as BaseWorkflowTemplate } from '@sprqvntrs/workflows';

// =============================================================================
// WORKFLOW TYPES
// =============================================================================

export const WORKFLOW_TYPES = {
  DUMMY: 'dummy-workflow',
  HOROSCOPE: 'generate-horoscope',
} as const;

export type WorkflowType = (typeof WORKFLOW_TYPES)[keyof typeof WORKFLOW_TYPES];

// =============================================================================
// EXTENDED TEMPLATE TYPES
// =============================================================================

/**
 * Operation definition with handler reference.
 * The handler is co-located with the operation config for easy navigation.
 */
export interface OperationWithHandler {
  type: string;
  handler: OperationHandler;
  timeout?: number;
  maxAttempts?: number;
  critical?: boolean;
}

/**
 * Stage definition with operations that include handlers.
 */
export interface StageWithHandlers {
  name: string;
  description?: string;
  operations: OperationWithHandler[];
}

/**
 * Extended workflow template that includes handler references.
 * This is the format used in template definitions.
 */
export interface WorkflowTemplateWithHandlers extends Omit<BaseWorkflowTemplate, 'stages'> {
  stages: StageWithHandlers[];
}

// =============================================================================
// CONTEXT TYPES
// =============================================================================

export interface DummyWorkflowContext {
  message?: string;
  userId?: string;
}

export interface HoroscopeWorkflowContext {
  sign?: ZodiacSign;
  authorId?: number;
}

export type ZodiacSign =
  | 'aries'
  | 'taurus'
  | 'gemini'
  | 'cancer'
  | 'leo'
  | 'virgo'
  | 'libra'
  | 'scorpio'
  | 'sagittarius'
  | 'capricorn'
  | 'aquarius'
  | 'pisces';
