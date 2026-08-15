import type { EngineResult } from '@/lib/workflow-runtime/types';

// ─── Production runtime result ────────────────────────────────────────────────
// Wraps EngineResult with additional metadata from the production runtime facade.

export type RuntimeExecutionResult = EngineResult & {
  /** True if execution was blocked by missing credentials */
  credentialError?: boolean;
  /** Providers that were missing credentials when checked pre-flight */
  missingCredentialProviders?: string[];
  /** True if execution was blocked by missing required node parameters */
  parameterError?: boolean;
  /** Per-node required-parameter validation failures found pre-flight */
  missingParameters?: Array<{ nodeId: string; nodeName: string; field: string; message: string }>;
};

export type CredentialPreflightError = {
  code: 'MISSING_CREDENTIALS';
  missingProviders: string[];
  message: string;
};

export function isCredentialPreflightError(v: unknown): v is CredentialPreflightError {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).code === 'MISSING_CREDENTIALS'
  );
}
