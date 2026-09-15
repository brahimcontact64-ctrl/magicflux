/**
 * Phase 9.9.6 (Part D) — node mutex lease renewal / duplicate side-effect
 * dispatch safety.
 *
 * Root cause: acquireNodeMutex()'s 30-second lease was never renewed while
 * a handler was actually running (unlike the execution-level lock, already
 * renewed every 15s for its 45s lease -- see runtime/workflow-engine.ts's
 * pre-existing lockRenewTimer). A side-effect network operation exceeding
 * 30 seconds could let the lease expire mid-flight, opening a window for a
 * second worker to acquire the "free" mutex and dispatch the SAME
 * Email/Slack/Airtable side effect concurrently -- a real duplicate-
 * delivery risk, not just a theoretical one, given the production incident
 * involved exactly this kind of long-running SMTP call.
 *
 * These tests exercise the real acquireNodeMutex/renewNodeMutex/
 * releaseNodeMutex functions from runtime/hardening-layer.ts against a
 * fake Supabase client, with fake timers controlling `Date.now()`
 * precisely so lease-expiry races are deterministic rather than relying
 * on real sleeps.
 *
 * IMPORTANT SCOPE NOTE (explicitly required by this phase): this proves
 * MagicFlux-side execution deduplication -- one worker cannot dispatch a
 * node while another legitimately still owns it. It does NOT and cannot
 * claim exactly-once delivery at the external provider (Airtable/Slack/
 * SMTP) -- a provider-side retry, a lost acknowledgement, or a provider's
 * own at-least-once semantics are outside what a client-side mutex can
 * guarantee. That distinction is deliberate and is asserted below.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  private pendingDelete = false;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  limit(): this { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
  }
  private apply(): void {
    // Deferred until await-time (then()/maybeSingle()), so every .eq() in
    // the real chain (.update(patch).eq(a).eq(b).eq(c)) has already been
    // recorded before filtering/mutating -- matching real Supabase's
    // "the update/delete only takes effect once the whole chain resolves."
    if (this.pendingPatch) {
      for (const row of this.matched()) Object.assign(row, this.pendingPatch);
      this.pendingPatch = null;
    }
    if (this.pendingDelete) {
      const keep = this.rows.filter((r) => !this.filters.every(([c, v]) => r[c] === v));
      this.rows.length = 0;
      this.rows.push(...keep);
      this.pendingDelete = false;
    }
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    const data = m[0] ? { ...m[0] } : null;
    this.apply();
    return { data, error: null };
  }
  then<T>(resolve: (v: { error: null }) => T): Promise<T> {
    this.apply();
    return Promise.resolve(resolve({ error: null }));
  }
  insert(row: Row): { error: null } | Promise<{ error: null }> {
    this.rows.push({ ...row });
    return { error: null };
  }
  update(patch: Row): this {
    this.pendingPatch = patch;
    return this;
  }
  delete(): this {
    this.pendingDelete = true;
    return this;
  }
}

let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = [])),
  }),
}));

const EXEC_ID = 'exec-1';
const WORKFLOW_ID = 'wf-1';
const USER_ID = 'user-1';
const NODE_ID = 'Send Email';

beforeEach(() => {
  tables = { runtime_node_mutexes: [] };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Phase 9.9.6 -- node mutex lease renewal keeps ownership valid for as long as a handler is genuinely still running', () => {
  it('renewNodeMutex extends the lease for the current owner', async () => {
    const { acquireNodeMutex, renewNodeMutex } = await import('../runtime/hardening-layer');

    const acquired = await acquireNodeMutex({ executionId: EXEC_ID, workflowId: WORKFLOW_ID, userId: USER_ID, nodeId: NODE_ID, ownerId: 'worker-A', leaseSeconds: 30 });
    expect(acquired.acquired).toBe(true);

    const before = tables.runtime_node_mutexes[0].lease_expires_at as string;

    vi.advanceTimersByTime(20_000); // 20s in, before the original 30s lease would expire
    const renewed = await renewNodeMutex({ executionId: EXEC_ID, nodeId: NODE_ID, ownerId: 'worker-A', leaseSeconds: 30 });
    expect(renewed).toBe(true);

    const after = tables.runtime_node_mutexes[0].lease_expires_at as string;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('renewNodeMutex refuses to extend a lease no longer owned by the caller (a different worker already stole it)', async () => {
    const { acquireNodeMutex, renewNodeMutex } = await import('../runtime/hardening-layer');

    await acquireNodeMutex({ executionId: EXEC_ID, workflowId: WORKFLOW_ID, userId: USER_ID, nodeId: NODE_ID, ownerId: 'worker-A', leaseSeconds: 30 });

    // worker-A's lease genuinely expires with no renewal; worker-B steals it.
    vi.advanceTimersByTime(31_000);
    const stolen = await acquireNodeMutex({ executionId: EXEC_ID, workflowId: WORKFLOW_ID, userId: USER_ID, nodeId: NODE_ID, ownerId: 'worker-B', leaseSeconds: 30 });
    expect(stolen.acquired).toBe(true);

    // worker-A (unaware it lost ownership) tries to renew -- must be refused,
    // never silently re-extending a lease it no longer legitimately holds.
    const staleRenew = await renewNodeMutex({ executionId: EXEC_ID, nodeId: NODE_ID, ownerId: 'worker-A', leaseSeconds: 30 });
    expect(staleRenew).toBe(false);
    expect(tables.runtime_node_mutexes[0].owner_id).toBe('worker-B');
  });

  it('WITHOUT renewal, a long-running handler (>30s) lets a second worker acquire the "free" mutex mid-flight -- reproducing the pre-fix vulnerability', async () => {
    const { acquireNodeMutex } = await import('../runtime/hardening-layer');

    const acquired = await acquireNodeMutex({ executionId: EXEC_ID, workflowId: WORKFLOW_ID, userId: USER_ID, nodeId: NODE_ID, ownerId: 'worker-A', leaseSeconds: 30 });
    expect(acquired.acquired).toBe(true);

    // worker-A is still genuinely executing a slow SMTP call (e.g. 35s),
    // but never renews -- exactly the pre-Part-D behavior.
    vi.advanceTimersByTime(35_000);

    const concurrent = await acquireNodeMutex({ executionId: EXEC_ID, workflowId: WORKFLOW_ID, userId: USER_ID, nodeId: NODE_ID, ownerId: 'worker-B', leaseSeconds: 30 });
    expect(concurrent.acquired).toBe(true); // the exact vulnerability Part D closes
  });

  it('WITH periodic renewal (as workflow-engine.ts now does every 10s for a 30s lease), a second worker can never acquire the mutex while the first is still genuinely running the same 35s handler', async () => {
    const { acquireNodeMutex, renewNodeMutex } = await import('../runtime/hardening-layer');

    await acquireNodeMutex({ executionId: EXEC_ID, workflowId: WORKFLOW_ID, userId: USER_ID, nodeId: NODE_ID, ownerId: 'worker-A', leaseSeconds: 30 });

    // Simulate the engine's renewal timer firing every 10s across a 35s handler.
    for (let elapsed = 10_000; elapsed <= 35_000; elapsed += 10_000) {
      vi.advanceTimersByTime(10_000);
      const renewed = await renewNodeMutex({ executionId: EXEC_ID, nodeId: NODE_ID, ownerId: 'worker-A', leaseSeconds: 30 });
      expect(renewed).toBe(true);

      const attempt = await acquireNodeMutex({ executionId: EXEC_ID, workflowId: WORKFLOW_ID, userId: USER_ID, nodeId: NODE_ID, ownerId: 'worker-B', leaseSeconds: 30 });
      expect(attempt.acquired).toBe(false); // never able to steal it while worker-A keeps renewing
    }

    expect(tables.runtime_node_mutexes[0].owner_id).toBe('worker-A');
  });

  it('releasing the mutex after the handler completes immediately frees it for the next node/attempt', async () => {
    const { acquireNodeMutex, releaseNodeMutex } = await import('../runtime/hardening-layer');

    await acquireNodeMutex({ executionId: EXEC_ID, workflowId: WORKFLOW_ID, userId: USER_ID, nodeId: NODE_ID, ownerId: 'worker-A', leaseSeconds: 30 });
    await releaseNodeMutex({ executionId: EXEC_ID, nodeId: NODE_ID, ownerId: 'worker-A' });

    const next = await acquireNodeMutex({ executionId: EXEC_ID, workflowId: WORKFLOW_ID, userId: USER_ID, nodeId: NODE_ID, ownerId: 'worker-A', leaseSeconds: 30 });
    expect(next.acquired).toBe(true);
  });
});

