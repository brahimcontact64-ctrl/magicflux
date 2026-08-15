/**
 * Phase 7.5 — Run viewer authorization tests.
 *
 * The run viewer (RunHistory/RunDetails/RunTimeline + the retry button) reads
 * and mutates execution state entirely through server routes gated by
 * lib/security/ownership.ts's assertExecutionOwnership(). These tests prove:
 *   1. The ownership primitive itself correctly distinguishes "owns" from
 *      "belongs to a different user" from "doesn't exist".
 *   2. GET /api/executions/[id] (what RunDetails calls) returns 404 — not the
 *      execution data — when a different user requests someone else's run.
 *   3. POST /api/workflows/executions/[id]/control (what the retry button
 *      calls) returns 404 for the same cross-user case, before ever reaching
 *      the execution manager.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000a1';
const ATTACKER_ID = '00000000-0000-4000-8000-0000000000b2';
const EXECUTION_ID = '00000000-0000-4000-8000-0000000000c3';

type Row = Record<string, unknown>;

// A minimal, filter-aware fake query builder — resolves data only when every
// .eq() filter matches a seeded row exactly, which is what actually lets this
// test distinguish "owns" from "cross-user" (a generic always-succeed proxy
// mock would not).
class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this {
    this.filters.push([col, val]);
    return this;
  }
  order(): this { return this; }
  limit(): this { return this; }
  select(): this { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    return { data: m[0] ?? null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve(resolve({ data: this.matched(), error: null }));
  }
}

const SEEDED_ROWS: Record<string, Row[]> = {
  workflow_executions_v2: [{ id: EXECUTION_ID, user_id: OWNER_ID, workflow_id: 'wf-1', status: 'failed', mode: 'live', input_data: {}, output_data: null }],
  v_execution_summaries: [{ id: EXECUTION_ID, user_id: OWNER_ID, workflow_id: 'wf-1', workflow_name: 'My Workflow', status: 'failed', mode: 'live', started_at: null, completed_at: null, duration_ms: null, step_count: 1, failed_step_count: 1, error_message: 'boom', retry_count: 0 }],
  v_execution_steps_final: [],
};

function freshTables(): Record<string, Row[]> {
  return {
    workflow_executions_v2: SEEDED_ROWS.workflow_executions_v2.map((r) => ({ ...r })),
    v_execution_summaries: SEEDED_ROWS.v_execution_summaries.map((r) => ({ ...r })),
    v_execution_steps_final: [],
  };
}

let tables = freshTables();

vi.mock('@/lib/supabase-server', () => ({
  getUserFromRequest: vi.fn(),
  createServiceClient: vi.fn(() => ({
    from: (name: string) => new FakeQuery(tables[name] ?? []),
  })),
}));

// mockImplementation must return from a `function`, not an arrow function —
// `new ExecutionManager()` in the route under test requires a constructable mock.
vi.mock('@/runtime/execution-manager', () => ({
  ExecutionManager: vi.fn().mockImplementation(function () {
    return {
      getExecution: vi.fn(),
      resumeExecution: vi.fn(),
      requestPause: vi.fn(),
      requestCancel: vi.fn(),
      rewindExecution: vi.fn(),
    };
  }),
}));

function makeReq(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(new URL(url), init);
}

describe('assertExecutionOwnership (the primitive every run-viewer route relies on)', () => {
  beforeEach(() => { tables = freshTables(); });

  it('resolves when the requesting user owns the execution', async () => {
    const { assertExecutionOwnership } = await import('../lib/security/ownership');
    await expect(assertExecutionOwnership(OWNER_ID, EXECUTION_ID)).resolves.toBeUndefined();
  });

  it('throws when the execution belongs to a different user', async () => {
    const { assertExecutionOwnership } = await import('../lib/security/ownership');
    await expect(assertExecutionOwnership(ATTACKER_ID, EXECUTION_ID)).rejects.toThrow(/not found or access denied/);
  });

  it('throws when the execution does not exist at all', async () => {
    const { assertExecutionOwnership } = await import('../lib/security/ownership');
    await expect(assertExecutionOwnership(OWNER_ID, 'does-not-exist')).rejects.toThrow(/not found or access denied/);
  });

  it('the error message never reveals whether the execution exists for someone else vs. not at all (same generic message either way)', async () => {
    const { assertExecutionOwnership } = await import('../lib/security/ownership');
    const crossUserErr = await assertExecutionOwnership(ATTACKER_ID, EXECUTION_ID).catch((e: Error) => e.message);
    const nonexistentErr = await assertExecutionOwnership(OWNER_ID, 'does-not-exist').catch((e: Error) => e.message);
    expect(crossUserErr).toBe(nonexistentErr);
  });
});

describe('GET /api/executions/[id] — cross-user access', () => {
  beforeEach(async () => {
    tables = freshTables();
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockReset();
  });

  it("returns the execution when the requester owns it", async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    const { GET } = await import('../app/api/executions/[id]/route');
    const res = await GET(makeReq(`http://localhost/api/executions/${EXECUTION_ID}`), { params: { id: EXECUTION_ID } });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.execution.id).toBe(EXECUTION_ID);
  });

  it('returns 404 (not the execution data) when a different user requests it', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);

    const { GET } = await import('../app/api/executions/[id]/route');
    const res = await GET(makeReq(`http://localhost/api/executions/${EXECUTION_ID}`), { params: { id: EXECUTION_ID } });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.execution).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('My Workflow');
  });

  it('returns 401 when there is no authenticated user at all', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);

    const { GET } = await import('../app/api/executions/[id]/route');
    const res = await GET(makeReq(`http://localhost/api/executions/${EXECUTION_ID}`), { params: { id: EXECUTION_ID } });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/workflows/executions/[id]/control — the retry button path, cross-user access', () => {
  beforeEach(async () => {
    tables = freshTables();
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockReset();
  });

  it("returns 404 and never reaches ExecutionManager.resumeExecution when a different user tries to retry someone else's run", async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);
    const { ExecutionManager } = await import('@/runtime/execution-manager');

    const { POST } = await import('../app/api/workflows/executions/[id]/control/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/executions/${EXECUTION_ID}/control`, {
        method: 'POST',
        body: JSON.stringify({ action: 'resume' }),
      }),
      { params: { id: EXECUTION_ID } },
    );

    expect(res.status).toBe(404);
    // The ownership check happens before the execution manager is even
    // constructed — resumeExecution() is never reachable for a denied request.
    expect(ExecutionManager).not.toHaveBeenCalled();
  });

  it('allows the owning user to retry their own failed run', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { ExecutionManager } = await import('@/runtime/execution-manager');
    vi.mocked(ExecutionManager).mockImplementation(function () {
      return {
        getExecution: vi.fn().mockResolvedValue({ id: EXECUTION_ID, workflow_id: 'wf-1', mode: 'live', input_data: {}, retry_count: 0, max_retries: 3 }),
        resumeExecution: vi.fn().mockResolvedValue({ status: 'success' }),
        requestPause: vi.fn(),
        requestCancel: vi.fn(),
        rewindExecution: vi.fn(),
      } as never;
    });

    // The route also reads the parent workflow row — seed it too.
    tables.workflows = [{ id: 'wf-1', user_id: OWNER_ID, workflow_json: {} }];

    const { POST } = await import('../app/api/workflows/executions/[id]/control/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/executions/${EXECUTION_ID}/control`, {
        method: 'POST',
        body: JSON.stringify({ action: 'resume' }),
      }),
      { params: { id: EXECUTION_ID } },
    );

    expect(res.status).toBe(200);
  });
});
