import 'server-only';

import type { ExecutionMode } from '@/lib/workflow-runtime/types';

// ─── Runtime context types ────────────────────────────────────────────────────
// Separate from NodeHandlerContext — this describes the CALLER's execution context,
// not the per-node context passed to handlers.

export type RuntimeExecutionContext = {
  userId: string;
  workflowId: string;
  mode: ExecutionMode;
  idempotencyKey?: string;
  maxRetries?: number;
  /** Resolved credential providers for pre-flight validation */
  resolvedProviders?: string[];
};

export type CredentialPreflightResult = {
  valid: boolean;
  missingProviders: string[];
  errors: string[];
};
