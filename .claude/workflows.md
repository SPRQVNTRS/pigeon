# Workflow Orchestrator Guide

This project uses a pg-boss-backed workflow orchestration system for background job processing.

## Architecture

```
WorkflowOrchestrator (Public API)
         │
         ▼
  ExecutionEngine (Stage/operation processing)
         │
    ┌────┼────┐
    ▼    ▼    ▼
Templates  Operations  Database
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Workflow** | Complete unit of work, progresses through stages |
| **Stage** | Logical grouping of operations (sequential) |
| **Operation** | Smallest unit, single responsibility, idempotent |
| **Template** | Declarative workflow definition |

## Directory Structure

```
app/workflows/
├── index.ts           # Public API: registerAllWorkflows()
├── types.ts           # Types and WORKFLOW_TYPES constants
├── templates/         # Workflow definitions
│   ├── index.ts       # Template registry
│   └── *.ts           # Individual templates
└── operations/        # Handler implementations
    ├── index.ts       # Handler registry (operationHandlers)
    └── {domain}/      # Domain-specific handlers
```

## Creating a Workflow

### 1. Define Template

```typescript
// app/workflows/templates/my-workflow.ts
import type { WorkflowTemplateWithHandlers } from '#app/workflows/types';
import { operationHandlers } from '#app/workflows/operations';

export const myWorkflowTemplate: WorkflowTemplateWithHandlers = {
  type: 'my-workflow',
  queue: 'default',
  version: '1.0.0',
  description: 'What this workflow does',
  estimatedDurationSeconds: 30,
  stages: [
    {
      name: 'stage-name',
      operations: [
        {
          type: 'my.operation',
          handler: operationHandlers.my.operation,
          timeout: 30000,
          maxAttempts: 3,
          critical: true,
        },
      ],
    },
  ],
};
```

### 2. Implement Handler

```typescript
// app/workflows/operations/my/operation.ts
import type { OperationHandler } from '@sprqvntrs/workflows';

export const myOperationHandler: OperationHandler = async (ctx) => {
  // ctx.workflowId, ctx.operationId, ctx.initialContext
  try {
    return { status: 'completed', data: { /* output */ } };
  } catch (error) {
    return { status: 'failed', reason: error.message };
  }
};
```

### 3. Register Handler

```typescript
// app/workflows/operations/index.ts
export const operationHandlers = {
  my: { operation: myOperationHandler },
} as const;
```

### 4. Register Template

```typescript
// app/workflows/templates/index.ts
export const workflowTemplates = [..., myWorkflowTemplate];
export { myWorkflowTemplate };
```

## Database Operations

Workflows run outside HTTP context. Use explicit tenant context:

```typescript
import { withTenantContext, getDb } from '#drizzle/tenant';

const [result] = await withTenantContext(
  { userId: input.authorId ?? 0, orgId: input.organizationId, isSuperadmin: false },
  () => getDb().insert(articles).values({ ... }).returning()
);
```

## Context Types

Define in `app/workflows/types.ts`:

```typescript
export interface MyWorkflowContext {
  param1: string;
  organizationId: string;  // Required for tenant-scoped data
}
```

## Reference

- Architecture: [docs/workflow-orchestrator-architecture.md](../docs/workflow-orchestrator-architecture.md)
- Multi-tenancy: [docs/multi-tenancy.md](../docs/multi-tenancy.md)
- Example: [app/workflows/templates/horoscope-workflow.ts](../app/workflows/templates/horoscope-workflow.ts)
