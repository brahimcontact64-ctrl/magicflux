// Incident 9.9.17C -- this module is reachable from scripts/runtime-worker.ts
// (the standalone Railway worker), which has no bundler to special-case the
// bare 'server-only' package -- see lib/runtime/server-only-guard.ts for why
// that import alone crashed the worker during module resolution.
import '@/lib/runtime/server-only-guard';

import { createServiceClient } from '@/lib/supabase-server';

/**
 * Phase 9.9.11A -- Part D: durable side-effect ledger, wired into the live
 * execution path (runtime/node-runner.ts).
 *
 * What this closes that lib/runtime/idempotency.ts and provider-outcome.ts
 * (both already live since Phase 9.9.11) do NOT: those protect a single
 * execution attempt within one process (an event is only ever dispatched
 * once; a network-ambiguous outcome within one node's own retry loop is
 * never blindly retried). Neither protects against the PROCESS ITSELF
 * crashing after a provider call has already, definitely succeeded but
 * before that success was persisted anywhere -- on recovery, nothing
 * before this could tell a fresh attempt "this exact effect already
 * happened". Airtable, Gmail, and Slack all lack a caller-supplied
 * idempotency mechanism for the operations this platform performs, so a
 * durable, CAS-claimed ledger row -- written BEFORE the provider is ever
 * called -- is the mechanism that closes that gap.
 *
 * CRITICAL TRUTH this module does NOT overstate (Phase 9.9.11A, Part 5):
 * it cannot eliminate the fundamental window where a provider accepts a
 * side effect and the process crashes before the DB can record success --
 * that attempt correctly recovers as 'indeterminate', not a false
 * 'succeeded' or 'failed'. The goal is never blindly duplicating an
 * uncertain external side effect, never a false exactly-once claim.
 *
 * Canonical key: (execution_id, node_id, effect_key) -- effect_key exists
 * because a single node COULD in principle perform more than one distinct
 * external effect; every current call site passes DEFAULT_EFFECT_KEY since
 * no existing node type (Airtable/Gmail/Slack) ever does today, but the
 * schema does not assume that stays true. The DB's own UNIQUE constraint is
 * the sole arbiter of "first claim wins" (insert-and-catch-23505, never
 * check-then-insert), exactly like runtime_execution_locks.idempotency_key
 * already proves for event-level idempotency.
 */

export type SideEffectStatus = 'not_started' | 'in_progress' | 'succeeded' | 'failed' | 'indeterminate';

/** Every current call site's effect_key -- see the module doc comment for why this column exists at all. */
export const DEFAULT_EFFECT_KEY = 'primary';

/** A stale in_progress row (no update in this long) is treated as an unresolved crash, never as proof of failure OR success. Generous relative to any single provider call's own timeout (Airtable/Slack/Gmail handlers all bound their own fetch to 10-20s) -- this only ever fires for a genuinely abandoned attempt, never a real in-flight one. */
export const SIDE_EFFECT_LEASE_MS = 5 * 60_000;

export type SideEffectLedgerRow = {
  id: string;
  status: SideEffectStatus;
  providerRef: unknown;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
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
    updatedAt: String(raw.updated_at ?? new Date(0).toISOString()),
  };
}

/** True when an 'in_progress' row has not been touched within the lease window -- the caller's signal that this is an abandoned/crashed attempt, never proof of what the provider actually did. */
export function isStaleInProgress(row: SideEffectLedgerRow, leaseMs: number = SIDE_EFFECT_LEASE_MS): boolean {
  if (row.status !== 'in_progress') return false;
  return Date.now() - new Date(row.updatedAt).getTime() > leaseMs;
}

/**
 * Attempts to claim the ledger row for (executionId, nodeId, effectKey)
 * before calling a non-idempotent provider.
 *   - No row exists yet: inserts one as 'in_progress' and claims it.
 *   - A row exists in a state safe to retry ('failed' or 'not_started' --
 *     KNOWN to have never reached the provider): atomically (CAS on
 *     status) flips it to 'in_progress' and claims it.
 *   - A row exists as 'succeeded': NEVER claimed -- the caller must treat
 *     this as duplicate_suppressed and skip the provider entirely.
 *   - A row exists as 'indeterminate': NEVER claimed -- must never be
 *     blindly retried (Part E/5).
 *   - A row exists as 'in_progress': NEVER claimed, whether fresh (a
 *     genuine concurrent attempt) or stale (a crashed one) -- claiming
 *     never speculatively resolves this either way (Part 5/6). A stale row
 *     is a job for reconcileStaleSideEffects() below, never an automatic
 *     silent retry here.
 */
export async function claimSideEffect(params: {
  userId: string;
  workflowId: string;
  executionId: string;
  nodeId: string;
  effectKey?: string;
  effectType: string;
}): Promise<ClaimResult> {
  const db = createServiceClient();
  const effectKey = params.effectKey ?? DEFAULT_EFFECT_KEY;

  const { error: insertError } = await db.from('workflow_side_effects').insert({
    user_id: params.userId,
    workflow_id: params.workflowId,
    execution_id: params.executionId,
    node_id: params.nodeId,
    effect_key: effectKey,
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
    .select('id, status, provider_ref, attempts, last_error, updated_at')
    .eq('execution_id', params.executionId)
    .eq('node_id', params.nodeId)
    .eq('effect_key', effectKey)
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
  effectKey?: string;
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
    .eq('node_id', params.nodeId)
    .eq('effect_key', params.effectKey ?? DEFAULT_EFFECT_KEY);
}

/** Read-only lookup for observability/reconciliation tooling -- never used to decide whether to call a provider (claimSideEffect is the only gate for that). */
export async function getSideEffectStatus(params: { executionId: string; nodeId: string; effectKey?: string }): Promise<SideEffectLedgerRow | null> {
  const db = createServiceClient();
  const { data } = await db
    .from('workflow_side_effects')
    .select('id, status, provider_ref, attempts, last_error, updated_at')
    .eq('execution_id', params.executionId)
    .eq('node_id', params.nodeId)
    .eq('effect_key', params.effectKey ?? DEFAULT_EFFECT_KEY)
    .maybeSingle();
  return data ? toRow(data) : null;
}

export type OperatorVerificationResult =
  | { ok: true; previousStatus: SideEffectStatus }
  | { ok: false; reason: string };

/**
 * Phase 9.9.14 -- Part H/I: the ONE mutation that lets an operator resolve
 * a genuinely indeterminate side effect -- the recovery control plane this
 * phase's own audit found was entirely missing (getSideEffectStatus()
 * existed for exactly this purpose per its own doc comment but nothing
 * ever called it). Deliberately narrow and deterministic, matching Part
 * H's explicit instruction to implement ONLY actions whose semantics can
 * be made auditable: this NEVER calls the provider again itself and NEVER
 * guesses -- it records what a human has ALREADY manually confirmed by
 * checking the provider directly (a real Airtable record, a real Slack
 * message, a real sent email). Marking 'failed' does not itself retry
 * anything; it only makes the row claimable again (claimSideEffect's own
 * CAS rules already allow re-claiming a 'failed' row) so a SEPARATE,
 * explicit resume/retry action can proceed safely -- 'succeeded' can never
 * be retried at all, by the same existing CAS rules.
 *
 * CAS-guarded: only ever transitions a row that is STILL 'indeterminate'
 * at the moment of the update, never a blind overwrite -- a concurrent
 * duplicate verification attempt loses the race harmlessly. The ORIGINAL
 * attempts/provider_ref/created_at are never altered -- this appends an
 * attributed note to last_error, it does not erase history (Part I: "No
 * destructive editing of historical execution evidence").
 */
export async function recordOperatorVerifiedOutcome(params: {
  executionId: string;
  nodeId: string;
  effectKey?: string;
  verifiedStatus: 'succeeded' | 'failed';
  verifiedBy: string;
  note: string;
}): Promise<OperatorVerificationResult> {
  const db = createServiceClient();
  const effectKey = params.effectKey ?? DEFAULT_EFFECT_KEY;

  const { data: existing } = await db
    .from('workflow_side_effects')
    .select('id, status, provider_ref, attempts, last_error, updated_at')
    .eq('execution_id', params.executionId)
    .eq('node_id', params.nodeId)
    .eq('effect_key', effectKey)
    .maybeSingle();

  if (!existing) return { ok: false, reason: 'No side-effect ledger row found for this execution/node.' };
  const row = toRow(existing);
  if (row.status !== 'indeterminate') {
    return { ok: false, reason: `This side effect is not indeterminate (currently '${row.status}') -- nothing to verify.` };
  }

  const { data: updated } = await db
    .from('workflow_side_effects')
    .update({
      status: params.verifiedStatus,
      last_error: `Operator-verified '${params.verifiedStatus}' by ${params.verifiedBy}: ${params.note}`.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    .eq('status', 'indeterminate')
    .select('id')
    .maybeSingle();

  if (!updated) {
    return { ok: false, reason: 'This side effect was already resolved by a concurrent action -- refresh and check its current state.' };
  }

  return { ok: true, previousStatus: row.status };
}

export type ReconciliationResult = { scanned: number; markedIndeterminate: number };

/**
 * Phase 9.9.11A -- Part 4/6: a stale 'in_progress' row (see
 * isStaleInProgress()) means a prior attempt crashed mid-flight -- this
 * sweep is the ONLY thing that ever moves such a row forward, and it can
 * only ever move it to 'indeterminate', never to 'succeeded' or 'failed'.
 *
 * Investigated per Phase 9.9.11A Part 6 whether a provider-specific
 * reconciliation could instead PROVE the true outcome here: none of
 * Airtable (no idempotency-key-style correlation ever sent), Slack
 * (chat.postMessage accepts no client-supplied message ID), or Gmail
 * (messages.send is not invoked with a self-generated, searchable
 * Message-ID today) give this platform a reliable, deterministic way to
 * query the provider and prove what happened. Matching an Airtable
 * record's field values or a Slack message's text after the fact is a
 * heuristic, not a proof -- explicitly what Part 6 forbids relying on. So
 * every stale row is conservatively marked 'indeterminate' and left for
 * explicit operator/user resolution, never inferred as succeeded or
 * silently retried.
 *
 * (A deterministic Gmail-specific reconciliation IS possible in principle
 * -- generating and sending our own RFC822 Message-ID header, then
 * searching Gmail for it on recovery -- but email.ts does not do this
 * today; implementing it is a scoped, separate future change, not
 * something this sweep can rely on until it exists.)
 */
export async function reconcileStaleSideEffects(params?: { batchSize?: number; leaseMs?: number }): Promise<ReconciliationResult> {
  const db = createServiceClient();
  const batchSize = params?.batchSize ?? 50;
  const leaseMs = params?.leaseMs ?? SIDE_EFFECT_LEASE_MS;
  const cutoffIso = new Date(Date.now() - leaseMs).toISOString();

  const { data: candidates } = await db
    .from('workflow_side_effects')
    .select('id, updated_at')
    .eq('status', 'in_progress')
    .lte('updated_at', cutoffIso)
    .limit(batchSize);

  const rows = (candidates ?? []) as Array<{ id: string; updated_at: string }>;
  let markedIndeterminate = 0;

  for (const row of rows) {
    // CAS: only transition if it is STILL 'in_progress' with the SAME
    // updated_at we just observed -- never a blind update that could race
    // a legitimate concurrent claimer's own progress.
    const { data: updated } = await db
      .from('workflow_side_effects')
      .update({
        status: 'indeterminate',
        last_error: 'Reconciliation sweep: no provider-specific mechanism can prove the outcome of this stale in-progress attempt.',
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('status', 'in_progress')
      .eq('updated_at', row.updated_at)
      .select('id')
      .maybeSingle();

    if (updated) markedIndeterminate += 1;
  }

  return { scanned: rows.length, markedIndeterminate };
}
