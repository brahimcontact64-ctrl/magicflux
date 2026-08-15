/**
 * Phase 8 — Concurrency limits (lib/runtime/concurrency-guard.ts) and the
 * plan-quota live-execution counting fix (lib/billing/plan-limits.ts).
 *
 * Before this: there was no per-user or per-workflow concurrent-execution
 * cap anywhere (confirmed by audit — only global BullMQ per-queue worker
 * concurrency existed, shared across every tenant). Separately,
 * getExecutionUsage() only counted the legacy workflow_runs table, which
 * only the two manual "Test" routes ever insert into — a user triggering
 * unlimited real webhook/live executions never counted against their
 * monthly plan limit at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000f2';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private gteFilters: Array<[string, unknown]> = [];
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  gte(col: string, val: unknown): this { this.gteFilters.push([col, val]); return this; }
  select(_cols?: string, _opts?: { count?: string; head?: boolean }): this { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) =>
      this.filters.every(([c, v]) => r[c] === v) &&
      this.gteFilters.every(([c, v]) => String(r[c]) >= String(v)),
    );
  }
  then<T>(resolve: (v: { count: number; data: Row[]; error: null }) => T): Promise<T> {
    const matched = this.matched();
    return Promise.resolve(resolve({ count: matched.length, data: matched, error: null }));
  }
}

class FakeDb {
  tables = new Map<string, Row[]>();
  from(name: string) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    const rows = this.tables.get(name)!;
    return { select: () => new FakeQuery(rows) };
  }
}

const fakeDb = new FakeDb();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
}));

beforeEach(() => { fakeDb.tables.clear(); });

// ─── Concurrency guard ───────────────────────────────────────────────────────
//
// Phase 8's checkConcurrencyLimits() (SELECT count(*) WHERE status='running',
// then trust it) was replaced in Phase 8.1 by an atomic RPC-backed
// reservation — see lib/runtime/concurrency-guard.ts's reserveConcurrencySlot().
// The coverage that used to live here (allow-under-limit, block-at-limit on
// both dimensions, tenant isolation) is superseded, not dropped: it now
// lives in tests/concurrency-atomic.test.ts (which additionally proves a
// genuine two-way race, something the old check-then-act design could never
// pass) and tests/crash-safety-concurrency-reclaim.test.ts (expiry/reclaim,
// fail-closed on RPC error). The "does not count completed/failed executions"
// case no longer applies: the new design counts unreleased reservation rows
// in runtime_concurrency_reservations, not workflow_executions_v2.status.

// ─── Quota: live-execution counting fix ─────────────────────────────────────

describe('getExecutionUsage (fixed to count live executions, not just workflow_runs)', () => {
  it('counts workflow_executions_v2 rows created this month, regardless of mode', async () => {
    const now = new Date();
    fakeDb.tables.set('workflow_executions_v2', [
      { id: 'e1', user_id: USER_A, mode: 'live', created_at: now.toISOString() },
      { id: 'e2', user_id: USER_A, mode: 'test', created_at: now.toISOString() },
      { id: 'e3', user_id: USER_A, mode: 'live', created_at: now.toISOString() },
    ]);
    const { getExecutionUsage } = await import('../lib/billing/plan-limits');
    const usage = await getExecutionUsage(USER_A);
    expect(usage).toBe(3);
  });

  it('a live webhook-triggered execution now counts toward quota (previously it never did)', async () => {
    const now = new Date();
    fakeDb.tables.set('workflow_executions_v2', [
      { id: 'e1', user_id: USER_A, mode: 'live', created_at: now.toISOString() },
    ]);
    const { getExecutionUsage } = await import('../lib/billing/plan-limits');
    expect(await getExecutionUsage(USER_A)).toBe(1);
  });

  it('does not count another month\'s executions', async () => {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    fakeDb.tables.set('workflow_executions_v2', [
      { id: 'e1', user_id: USER_A, mode: 'live', created_at: lastMonth.toISOString() },
    ]);
    const { getExecutionUsage } = await import('../lib/billing/plan-limits');
    expect(await getExecutionUsage(USER_A)).toBe(0);
  });

  it('does not count another user\'s executions', async () => {
    const now = new Date();
    fakeDb.tables.set('workflow_executions_v2', [
      { id: 'e1', user_id: '00000000-0000-4000-8000-0000000000f4', mode: 'live', created_at: now.toISOString() },
    ]);
    const { getExecutionUsage } = await import('../lib/billing/plan-limits');
    expect(await getExecutionUsage(USER_A)).toBe(0);
  });
});
