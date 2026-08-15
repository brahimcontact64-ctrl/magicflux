/**
 * Server-side ownership assertion helpers.
 *
 * Every function:
 *   - calls assertTrustedUserId() first (UUID v4 validation)
 *   - queries the DB with BOTH the user_id AND the resource id
 *   - throws a generic SECURITY error on failure (no information leakage)
 *   - logs only the first 8 characters of each ID
 *
 * NEVER call these functions client-side.
 * NEVER expose the thrown error message verbatim to API callers —
 * catch it and return a safe 404/403 instead.
 */

import { createServiceClient } from '@/lib/supabase-server';
import { assertTrustedUserId } from '@/lib/credentials/storage';

// ── Task 1: Workflow ownership ────────────────────────────────────────────────

/**
 * Asserts that userId is the owner of workflowId.
 *
 * Throws 'SECURITY: workflow not found or access denied' if:
 * - userId is not a valid UUID v4
 * - workflowId is empty or not a string
 * - the workflow does not exist
 * - the workflow belongs to a different user
 *
 * Use before deploy, regenerate, duplicate, graph mutate, test, webhook,
 * execution list, and any operation that takes a workflow ID from client input.
 */
export async function assertWorkflowOwnership(
  userId: string,
  workflowId: string
): Promise<void> {
  assertTrustedUserId(userId);

  if (!workflowId || typeof workflowId !== 'string') {
    throw new Error('SECURITY: workflowId must be a non-empty string');
  }

  const db = createServiceClient();
  const { data } = await db
    .from('workflows')
    .select('id')
    .eq('id', workflowId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) {
    console.warn(
      `[SECURITY] workflow ownership denied: wf=${workflowId.slice(0, 8)}… uid=${userId.slice(0, 8)}…`
    );
    throw new Error('SECURITY: workflow not found or access denied');
  }
}

// ── Task 2: Credential ownership ──────────────────────────────────────────────

/**
 * Asserts that userId owns at least one credential row for provider.
 *
 * Call before reading or deleting credentials for an existing connection.
 * Do NOT call before saving new credentials (INSERT paths) — assertTrustedUserId
 * inside storage.ts is sufficient for those paths.
 *
 * Throws 'SECURITY: credentials not found or access denied' if:
 * - userId is not a valid UUID v4
 * - provider is empty or not a string
 * - no integration_credentials rows exist for (userId, provider)
 */
export async function assertCredentialOwnership(
  userId: string,
  provider: string
): Promise<void> {
  assertTrustedUserId(userId);

  if (!provider || typeof provider !== 'string') {
    throw new Error('SECURITY: provider must be a non-empty string');
  }

  const db = createServiceClient();
  const { data } = await db
    .from('integration_credentials')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', provider)
    .limit(1)
    .maybeSingle();

  if (!data) {
    console.warn(
      `[SECURITY] credential ownership denied: provider=${provider} uid=${userId.slice(0, 8)}…`
    );
    throw new Error('SECURITY: credentials not found or access denied');
  }
}

// ── Task 3: Execution ownership ───────────────────────────────────────────────

/**
 * Asserts that userId owns the given execution in workflow_executions_v2.
 *
 * Throws 'SECURITY: execution not found or access denied' if:
 * - userId is not a valid UUID v4
 * - executionId is empty or not a string
 * - the execution does not exist
 * - the execution belongs to a different user
 *
 * Use before replay, control (pause/cancel/resume/rewind), step reads,
 * and any operation that takes an execution ID from client input.
 */
export async function assertExecutionOwnership(
  userId: string,
  executionId: string
): Promise<void> {
  assertTrustedUserId(userId);

  if (!executionId || typeof executionId !== 'string') {
    throw new Error('SECURITY: executionId must be a non-empty string');
  }

  const db = createServiceClient();
  const { data } = await db
    .from('workflow_executions_v2')
    .select('id')
    .eq('id', executionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!data) {
    console.warn(
      `[SECURITY] execution ownership denied: exec=${executionId.slice(0, 8)}… uid=${userId.slice(0, 8)}…`
    );
    throw new Error('SECURITY: execution not found or access denied');
  }
}
