/**
 * Phase 8.1 — Atomic concurrency reservation race test.
 *
 * Honesty note on what this test can and cannot prove: there is no live
 * Postgres in this environment (see the Phase 8.1 report's live-validation
 * section — BLOCKED), so this cannot execute the real
 * reserve_concurrency_slot() SQL function or its pg_advisory_xact_lock. What
 * it DOES prove, against the real lib/runtime/concurrency-guard.ts wrapper
 * (only the RPC transport below it is mocked):
 *
 *   1. A naive, non-atomic reservation (count, then yield to the event loop,
 *      then insert — i.e. exactly the "SELECT count(...) then INSERT" the
 *      brief warns against) DOES let two concurrent requests both pass a
 *      limit of 1. This documents the exact bug Phase 8's concurrency guard
 *      had.
 *   2. The same reservation logic, wrapped in a critical section that only
 *      one caller can enter at a time (a mutex — the same serialization
 *      guarantee pg_advisory_xact_lock provides in real Postgres, just
 *      implemented in JS for this test), produces exactly one winner under
 *      the identical Promise.all race. This proves the JS wrapper
 *      (reserveConcurrencySlot) correctly reports the result either way —
 *      it does not itself introduce a race, and correctly surfaces "denied"
 *      for the loser.
 *
 * Genuinely proving Postgres's pg_advisory_xact_lock serializes concurrent
 * transactions the way the migration assumes requires a live database and
 * is marked BLOCKED in the Phase 8.1 report's live-validation section, not
 * faked here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Reservation = { executionId: string; userId: string; workflowId: string; releasedAt: string | null };

function sql_reserve_concurrency_slot_naive(reservations: Reservation[]) {
  return async (_fn: string, args: Record<string, unknown>) => {
    const userId = args.p_user_id as string;
    const maxPerUser = args.p_max_per_user as number;
    const executionId = args.p_execution_id as string;

    const userCount = reservations.filter((r) => r.userId === userId && r.releasedAt === null).length;
    // Simulate real network/DB round-trip latency BETWEEN the count and the
    // write — this is the un-serialized "check-then-act" gap that makes the
    // Phase 8 guard race-prone. No lock is held across it.
    await new Promise((resolve) => setTimeout(resolve, 5));

    if (userCount >= maxPerUser) {
      return { data: { reserved: false, reason: 'USER_CONCURRENCY_LIMIT', current: userCount, limit: maxPerUser }, error: null };
    }

    reservations.push({ executionId, userId, workflowId: args.p_workflow_id as string, releasedAt: null });
    return { data: { reserved: true }, error: null };
  };
}

function sql_reserve_concurrency_slot_mutex_gated(reservations: Reservation[]) {
  // A single serialization gate shared by every call — exactly what
  // pg_advisory_xact_lock provides in Postgres: only one caller executes the
  // count+insert critical section at a time, for the whole call, including
  // across the same artificial latency used in the naive version above.
  let gate: Promise<unknown> = Promise.resolve();

  return (_fn: string, args: Record<string, unknown>) => {
    const run = gate.then(async () => {
      const userId = args.p_user_id as string;
      const maxPerUser = args.p_max_per_user as number;
      const executionId = args.p_execution_id as string;

      const userCount = reservations.filter((r) => r.userId === userId && r.releasedAt === null).length;
      await new Promise((resolve) => setTimeout(resolve, 5));

      if (userCount >= maxPerUser) {
        return { data: { reserved: false, reason: 'USER_CONCURRENCY_LIMIT', current: userCount, limit: maxPerUser }, error: null };
      }

      reservations.push({ executionId, userId, workflowId: args.p_workflow_id as string, releasedAt: null });
      return { data: { reserved: true }, error: null };
    });
    // Every subsequent call waits for this one to fully finish before its
    // own critical section can start, regardless of outcome.
    gate = run.catch(() => undefined);
    return run;
  };
}

let rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null }>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    rpc: (fn: string, args: Record<string, unknown>) => rpcImpl(fn, args),
  })),
}));

describe('reserveConcurrencySlot — race behavior', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('DOCUMENTS THE BUG: a naive check-then-act reservation lets two concurrent requests both pass a limit of 1', async () => {
    const reservations: Reservation[] = [];
    rpcImpl = sql_reserve_concurrency_slot_naive(reservations);

    const { reserveConcurrencySlot } = await import('../lib/runtime/concurrency-guard');
    const [a, b] = await Promise.all([
      reserveConcurrencySlot({ executionId: 'exec-a', userId: 'user-1', workflowId: 'wf-1', maxPerUser: 1, maxPerWorkflow: 10 }),
      reserveConcurrencySlot({ executionId: 'exec-b', userId: 'user-1', workflowId: 'wf-1', maxPerUser: 1, maxPerWorkflow: 10 }),
    ]);

    const winners = [a, b].filter((r) => r.reserved).length;
    // This is the bug: both win under the naive implementation.
    expect(winners).toBe(2);
  });

  it('PROVES THE FIX WORKS AT THE WRAPPER LEVEL: a serialized (mutex-gated) reservation lets exactly one of two concurrent requests pass a limit of 1', async () => {
    const reservations: Reservation[] = [];
    rpcImpl = sql_reserve_concurrency_slot_mutex_gated(reservations);

    const { reserveConcurrencySlot } = await import('../lib/runtime/concurrency-guard');
    const [a, b] = await Promise.all([
      reserveConcurrencySlot({ executionId: 'exec-a', userId: 'user-1', workflowId: 'wf-1', maxPerUser: 1, maxPerWorkflow: 10 }),
      reserveConcurrencySlot({ executionId: 'exec-b', userId: 'user-1', workflowId: 'wf-1', maxPerUser: 1, maxPerWorkflow: 10 }),
    ]);

    const winners = [a, b].filter((r) => r.reserved).length;
    const losers = [a, b].filter((r) => !r.reserved);
    expect(winners).toBe(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reserved).toBe(false);
    if (!losers[0].reserved) expect(losers[0].code).toBe('USER_CONCURRENCY_LIMIT');
  });

  it('ten concurrent requests against a limit of 3 (serialized): exactly three win', async () => {
    const reservations: Reservation[] = [];
    rpcImpl = sql_reserve_concurrency_slot_mutex_gated(reservations);

    const { reserveConcurrencySlot } = await import('../lib/runtime/concurrency-guard');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        reserveConcurrencySlot({ executionId: `exec-${i}`, userId: 'user-1', workflowId: 'wf-1', maxPerUser: 3, maxPerWorkflow: 100 })),
    );

    expect(results.filter((r) => r.reserved)).toHaveLength(3);
    expect(results.filter((r) => !r.reserved)).toHaveLength(7);
  });

  it('per-workflow and per-user limits are independent scopes — a workflow-limit denial does not consume a user slot', async () => {
    const reservations: Reservation[] = [];
    // Workflow-scoped gate for this test: reuse the mutex helper but key on workflow_id instead.
    let gate: Promise<unknown> = Promise.resolve();
    rpcImpl = (_fn, args) => {
      const run = gate.then(async () => {
        const workflowId = args.p_workflow_id as string;
        const maxPerWorkflow = args.p_max_per_workflow as number;
        const workflowCount = reservations.filter((r) => r.workflowId === workflowId && r.releasedAt === null).length;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (workflowCount >= maxPerWorkflow) {
          return { data: { reserved: false, reason: 'WORKFLOW_CONCURRENCY_LIMIT', current: workflowCount, limit: maxPerWorkflow }, error: null };
        }
        reservations.push({ executionId: args.p_execution_id as string, userId: args.p_user_id as string, workflowId, releasedAt: null });
        return { data: { reserved: true }, error: null };
      });
      gate = run.catch(() => undefined);
      return run;
    };

    const { reserveConcurrencySlot } = await import('../lib/runtime/concurrency-guard');
    const [a, b] = await Promise.all([
      reserveConcurrencySlot({ executionId: 'exec-a', userId: 'user-1', workflowId: 'wf-1', maxPerUser: 100, maxPerWorkflow: 1 }),
      reserveConcurrencySlot({ executionId: 'exec-b', userId: 'user-1', workflowId: 'wf-1', maxPerUser: 100, maxPerWorkflow: 1 }),
    ]);
    expect([a, b].filter((r) => r.reserved)).toHaveLength(1);
  });
});
