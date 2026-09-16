/**
 * Phase 9.9.11A -- Part 4: the node-type-aware policy layer between
 * runtime/node-runner.ts and lib/runtime/side-effect-ledger.ts.
 *
 * Decides WHICH node invocations are non-idempotent external side effects
 * that need the ledger's protection (today: Airtable create/update/delete,
 * Gmail/email send, Slack post -- never a read-only Airtable list/get,
 * which is naturally safe to repeat), and how to translate a claimed
 * ledger row plus a handler's real result into the ledger's own
 * succeeded/failed/indeterminate vocabulary -- kept here, next to the
 * node-type-specific knowledge of each handler's output shape, rather than
 * duplicated into node-runner.ts itself.
 */

import type { EngineNode, NodeHandlerResult } from '../types';

const AIRTABLE_TYPES = new Set(['n8n-nodes-base.airtable', 'n8n-nodes-base.airtabletrigger']);
const EMAIL_TYPES = new Set(['n8n-nodes-base.gmail', 'n8n-nodes-base.gmailtrigger', 'n8n-nodes-base.emailsend', 'n8n-nodes-base.emailreadimap']);
const SLACK_TYPES = new Set(['n8n-nodes-base.slack', 'n8n-nodes-base.slacktrigger']);

const AIRTABLE_MUTATING_OPERATIONS = new Set(['create', 'update', 'delete']);

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * True only for a node invocation that will perform a real, non-idempotent
 * external write if dispatched -- an Airtable 'list'/'get' is deliberately
 * excluded (reading data is always safe to repeat; ledger-gating it would
 * add overhead and a misleading "effect" record for something that never
 * mutates anything).
 */
export function isLedgerProtectedSideEffect(node: EngineNode): boolean {
  const type = String(node.type ?? '').toLowerCase();
  if (EMAIL_TYPES.has(type) || SLACK_TYPES.has(type)) return true;
  if (AIRTABLE_TYPES.has(type)) {
    const operation = String(asRecord(node.parameters).operation ?? 'create').toLowerCase();
    return AIRTABLE_MUTATING_OPERATIONS.has(operation);
  }
  return false;
}

/** Informational label stored in the ledger row (effect_type) -- never part of the uniqueness guarantee. */
export function deriveEffectType(node: EngineNode): string {
  const type = String(node.type ?? '').toLowerCase();
  if (AIRTABLE_TYPES.has(type)) {
    const operation = String(asRecord(node.parameters).operation ?? 'create').toLowerCase();
    return `airtable_${operation}`;
  }
  if (EMAIL_TYPES.has(type)) return 'email_send';
  if (SLACK_TYPES.has(type)) return 'slack_post';
  return type || 'unknown';
}

/** Extracts whatever provider-returned identifier a successful result carries, for observability/reconciliation -- never a secret, never a message body. */
export function extractProviderRef(node: EngineNode, outputData: unknown): Record<string, unknown> | null {
  const type = String(node.type ?? '').toLowerCase();
  const out = asRecord(outputData);
  if (AIRTABLE_TYPES.has(type)) {
    if (out.airtable_id) return { airtable_id: out.airtable_id };
    if (out.airtable_deleted_id) return { airtable_deleted_id: out.airtable_deleted_id };
    return null;
  }
  if (EMAIL_TYPES.has(type) && out.messageId) return { messageId: out.messageId };
  if (SLACK_TYPES.has(type) && out.ts) return { ts: out.ts };
  return null;
}

/**
 * Classifies a handler's REAL result (never called for a duplicate-
 * suppressed short-circuit, which never invokes the handler at all) into
 * the ledger's own vocabulary. Mirrors provider-outcome.ts's existing
 * nonRetryable contract exactly: a nonRetryable failure is the same
 * network-ambiguous outcome already classified indeterminate at the
 * single-attempt layer (Phase 9.9.11) -- the ledger persists that same
 * classification durably rather than inventing a second one.
 */
export function classifyResultForLedger(result: NodeHandlerResult): 'succeeded' | 'failed' | 'indeterminate' {
  const terminal = result.status === 'simulated_success' ? 'success' : result.status;
  if (terminal === 'success' || terminal === 'skipped') return 'succeeded';
  if (result.nonRetryable) return 'indeterminate';
  return 'failed';
}

/** Builds the outputData for a duplicate-suppressed short-circuit -- never calls the provider, so this can only ever be reconstructed from the ledger's own stored reference, never a full replay of the original response. */
export function buildDuplicateSuppressedOutputData(inputData: unknown, providerRef: unknown): Record<string, unknown> {
  return {
    ...asRecord(inputData),
    duplicate_suppressed: true,
    ...(providerRef && typeof providerRef === 'object' ? (providerRef as Record<string, unknown>) : {}),
  };
}
