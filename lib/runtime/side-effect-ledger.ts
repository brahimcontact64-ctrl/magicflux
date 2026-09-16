import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';

/**
 * Phase 9.9.11 -- Part D: durable side-effect ledger.
 *
 * NOT YET WIRED into the live execution path (runtime/node-runner.ts) --
 * this module is designed, implemented, and unit-tested (against a mocked
 * DB, matching this codebase's established convention) against the
 * migration drafted in supabase/migrations/20260916170907_add_workflow_side_effects_ledger.sql,
 * which has NOT been applied to production. See the Phase 9.9.11 report
 * for why: the migration requires explicit approval before being applied,
 * per the standing rule, and this module must never be called against a
 * table that doesn't exist yet.
 *
 * What this closes that lib/runtime/idempotency.ts and provider-outcome.ts
 * (both already live) do NOT: those protect a single execution attempt
 * within one process (an event is only ever dispatched once; an ambiguous
 * network outcome within one node's retry loop is never blindly retried).
 * Neither protects against the PROCESS ITSELF crashing after a provider
 * call has already, definitely succeeded but before that success was
 * persisted anywhere -- on recovery, nothing today can tell a fresh
 * attempt "this exact node's effect already happened". Airtable, Gmail,
 * and Slack all lack a caller-supplied idempotency mechanism for the
 * operations this platform performs, so a durable, CAS-claimed ledger row
 * -- written BEFORE the provider is ever called -- is the only way to
 * close that gap safely.
 *
 * Canonical key: (execution_id, node_id) -- the DB's own UNIQUE constraint
 * is the sole arbiter of "first claim wins", exactly like
 * runtime_execution_locks.idempotency_key already proves for event-level
 * idempotency (insert-and-catch-23505, never check-then-insert).
 */

export type SideEffectStatus = 'not_started' | 'in_progress' | 'succeeded' | 'failed' | 'indeterminate';

export type SideEffectLedgerRow = {
  id: string;
  status: SideEffectStatus;
  providerRef: unknown;
  attempts: number;
  lastError: string | null;
};

export type ClaimResult =
  | { claimed: true }
  | { claimed: false; existing: SideEffectLedgerRow };

function toRow(raw: Record<string, unknown>): SideEffectLedgerRow {
  return {
    id: String(raw.id),
    status: raw.status as SideEffectStatus,
    providerRef: raw.provider_ref ?? null,
    attempts: Number(raw.attempts ?? 0),
    lastError: (raw.last_error as string | null) ?? null,
  };
}

/**
 * Attempts to claim the ledger row for (executionId, nodeId) before calling
 * a non-idempotent provider. Three outcomes:
 *   - No row exists yet: inserts one as 'in_progress' and claims it.
 *   - A row exists in a state safe to retry ('failed' -- the prior attempt
 *     is KNOWN to have never reached the provider, or 'not_started'):
 *     atomically (CAS on status) flips it to 'in_progress' and claims it.
 *   - A row exists as 'succeeded' or 'indeterminate': NEVER claimed --
 *     the caller must not call the provider again (a 'succeeded' effect
 *     should short-circuit as already-done; an 'indeterminate' one must
 *     never be blindly retried, per Part E).
 *   - A row exists as 'in_progress': NEVER claimed -- either a genuine
 *     concurrent attempt is running right now, or a prior attempt crashed
 *     while in flight. Either way this caller must not also call the
 *     provider; a stale 'in_progress' row is a job for an explicit
 *     reconciliation sweep (mirroring lib/runtime/review-resume.ts's
 *     recoverStuckReviewResumes()), never an automatic silent retry here.
 */
export async function claimSideEffect(params: {
  userId: string;
  workflowId: string;
  executionId: string;
  nodeId: string;
  effectType: string;
}): Promise<ClaimResult> {
  const db = createServiceClient();

  const { error: insertError } = await db.from('workflow_side_effects').insert({
    user_id: params.userId,
    workflow_id: params.workflowId,
    execution_id: params.executionId,
    node_id: params.nodeId,
    effect_type: params.effectType,
    status: 'in_progress',
    attempts: 1,
  });

  if (!insertError) return { claimed: true };

  if (insertError.code !== '23505') {
    throw new Error(`Failed to claim side-effect ledger row: ${insertError.message}`);
  }

  // Someone got there first (a genuinely earlier claim, possibly from a
  // prior crashed attempt) -- inspect it rather than assume.
  const { data: existing } = await db
    .from('workflow_side_effects')
    .select('id, status, provider_ref, attempts, last_error')
    .eq('execution_id', params.executionId)
    .eq('node_id', params.nodeId)
    .maybeSingle();

  if (!existing) {
    // Row vanished between the conflict and this read (e.g. a concurrent
    // delete/cascade) -- cannot confirm safety either way; never guess.
    throw new Error('Side-effect ledger row conflicted but could not be read back.');
  }

  const row = toRow(existing);

  if (row.status === 'failed' || row.status === 'not_started') {
    // Safe to retry -- CAS the row back to 'in_progress' only if it is
    // STILL in the state we just observed (never a blind unconditional
    // update, which could race a concurrent claimer the same way).
    const { data: recas, error: recasError } = await db
      .from('workflow_side_effects')
      .update({ status: 'in_progress', attempts: row.attempts + 1, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', row.status)
      .select('id')
      .maybeSingle();

    if (recasError) throw new Error(`Failed to re-claim side-effect ledger row: ${recasError.message}`);
    if (recas) return { claimed: true };
    // Lost the re-claim race to a concurrent retrier -- fall through and
    // report the (now stale) row as unclaimed rather than double-claim.
  }

  return { claimed: false, existing: row };
}

/** Records the definitive outcome of a claimed side effect. Only ever called by the caller that successfully claimed it. */
export async function recordSideEffectOutcome(params: {
  executionId: string;
  nodeId: string;
  status: 'succeeded' | 'failed' | 'indeterminate';
  providerRef?: unknown;
  error?: string;
}): Promise<void> {
  const db = createServiceClient();
  await db
    .from('workflow_side_effects')
    .update({
      status: params.status,
      provider_ref: params.providerRef ?? null,
      last_error: params.error ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('execution_id', params.executionId)
    .eq('node_id', params.nodeId);
}

/** Read-only lookup for observability/reconciliation tooling -- never used to decide whether to call a provider (claimSideEffect is the only gate for that). */
export async function getSideEffectStatus(params: { executionId: string; nodeId: string }): Promise<SideEffectLedgerRow | null> {
  const db = createServiceClient();
  const { data } = await db
    .from('workflow_side_effects')
    .select('id, status, provider_ref, attempts, last_error')
    .eq('execution_id', params.executionId)
    .eq('node_id', params.nodeId)
    .maybeSingle();
  return data ? toRow(data) : null;
}
