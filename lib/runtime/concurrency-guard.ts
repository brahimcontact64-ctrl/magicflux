import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';

/**
 * Per-user / per-workflow concurrency limiting — atomic reservation.
 *
 * Phase 8 shipped a check-then-act guard (SELECT count(*) WHERE status =
 * 'running', then trust it). That is race-prone by construction: two
 * concurrent requests can both read "0 running" before either has inserted
 * its execution row, and both pass a limit of 1. Phase 8.1 replaces it with
 * reserveConcurrencySlot(), backed by the reserve_concurrency_slot()
 * Postgres function (see the phase8_1 migration) — a transaction-scoped
 * advisory lock on (user_id, workflow_id) serializes concurrent reservation
 * attempts for the same scope before the count is taken, so the count is
 * never stale relative to a race. This is a single round trip, not a
 * SELECT-then-INSERT pair split across two PostgREST calls.
 *
 * A reservation must always be released exactly once per execution — on
 * success, failure, cancellation, or enqueue failure — via
 * releaseConcurrencySlot(). Reservations also carry a TTL and are reclaimed
 * automatically (lazily inside reserve_concurrency_slot, and proactively via
 * reclaimExpiredConcurrencyReservations()) so a crashed worker cannot leak a
 * slot forever.
 */

const DEFAULT_MAX_CONCURRENT_PER_USER = Number(process.env.RUNTIME_MAX_CONCURRENT_PER_USER ?? 10);
const DEFAULT_MAX_CONCURRENT_PER_WORKFLOW = Number(process.env.RUNTIME_MAX_CONCURRENT_PER_WORKFLOW ?? 3);
const DEFAULT_RESERVATION_TTL_SECONDS = Number(process.env.RUNTIME_CONCURRENCY_RESERVATION_TTL_SECONDS ?? 30 * 60);

export type ConcurrencyReservationResult =
  | { reserved: true }
  | { reserved: false; reason: string; code: 'USER_CONCURRENCY_LIMIT' | 'WORKFLOW_CONCURRENCY_LIMIT'; limit: number; current: number };

/**
 * Atomically reserves one concurrency slot for (userId, workflowId), keyed
 * by executionId. Call this once, before enqueueing/starting an execution;
 * always pair with releaseConcurrencySlot() on every exit path.
 */
export async function reserveConcurrencySlot(params: {
  executionId: string;
  userId: string;
  workflowId: string;
  maxPerUser?: number;
  maxPerWorkflow?: number;
  ttlSeconds?: number;
}): Promise<ConcurrencyReservationResult> {
  const db = createServiceClient();
  const maxPerUser = params.maxPerUser ?? DEFAULT_MAX_CONCURRENT_PER_USER;
  const maxPerWorkflow = params.maxPerWorkflow ?? DEFAULT_MAX_CONCURRENT_PER_WORKFLOW;
  const ttlSeconds = params.ttlSeconds ?? DEFAULT_RESERVATION_TTL_SECONDS;

  const { data, error } = await db.rpc('reserve_concurrency_slot', {
    p_execution_id: params.executionId,
    p_user_id: params.userId,
    p_workflow_id: params.workflowId,
    p_max_per_user: maxPerUser,
    p_max_per_workflow: maxPerWorkflow,
    p_ttl_seconds: ttlSeconds,
  });

  if (error) {
    // Fail closed: an unreadable reservation result must never be treated as "reserved".
    return {
      reserved: false,
      code: 'USER_CONCURRENCY_LIMIT',
      reason: `Concurrency reservation failed: ${error.message}`,
      limit: maxPerUser,
      current: maxPerUser,
    };
  }

  const result = data as { reserved: boolean; reason?: string; current?: number; limit?: number };
  if (result.reserved) return { reserved: true };

  return {
    reserved: false,
    code: (result.reason as 'USER_CONCURRENCY_LIMIT' | 'WORKFLOW_CONCURRENCY_LIMIT') ?? 'USER_CONCURRENCY_LIMIT',
    reason: result.reason === 'WORKFLOW_CONCURRENCY_LIMIT'
      ? `This workflow already has ${result.current} execution(s) running (limit ${result.limit}).`
      : `You already have ${result.current} execution(s) running across all workflows (limit ${result.limit}).`,
    limit: Number(result.limit ?? 0),
    current: Number(result.current ?? 0),
  };
}

/** Idempotent — safe to call even if the execution was never reserved, or already released. */
export async function releaseConcurrencySlot(params: { executionId: string }): Promise<void> {
  const db = createServiceClient();
  await db.rpc('release_concurrency_slot', { p_execution_id: params.executionId });
}

/** Proactive sweep for reservations left behind by a crashed worker; safe to call repeatedly. */
export async function reclaimExpiredConcurrencyReservations(): Promise<number> {
  const db = createServiceClient();
  const { data } = await db.rpc('reclaim_expired_concurrency_reservations', {});
  return Number(data ?? 0);
}
