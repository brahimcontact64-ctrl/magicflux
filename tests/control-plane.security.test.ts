/**
 * Phase 8 — Security tests for the new production control-plane surface:
 *   - POST /api/workflows/[id]/webhook: lifecycle gating, HTTP method
 *     validation, oversized-payload rejection, quota bypass, concurrency
 *     bypass, unauthorized-workflow-status leakage.
 *   - GET  /api/cron/dispatch-schedules: CRON_SECRET bearer auth (the
 *     only thing standing between the public internet and firing every
 *     due schedule for every tenant).
 *   - POST /api/workflows/[id]/lifecycle: cross-tenant activate/pause
 *     attempts must not affect another user's workflow (IDOR).
 *
 * guardWebhookRequest (pre-existing signature/replay/rate-limit guard) is
 * mocked to always allow — it is not part of this phase's changes and has
 * its own responsibility boundary; these tests isolate the NEW gates added
 * in Phase 8 (lifecycle status, method allowlist, body size, quota,
 * concurrency, deployment-version resolution).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = '00000000-0000-4000-8000-0000000000d1';
const ATTACKER_ID = '00000000-0000-4000-8000-0000000000d2';
const WORKFLOW_ID = 'wf-control-plane';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  private isDelete = false;
  constructor(private rows: Row[], private table: string) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  gte(col: string, val: unknown): this { this.filters.push([`__gte__${col}`, val]); return this; }
  select(): this { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every(([c, v]) => {
      if (c.startsWith('__gte__')) return String(r[c.slice(7)] ?? '') >= String(v);
      return r[c] === v;
    }));
  }
  private applyPendingPatch(): Row[] {
    const m = this.matched();
    if (this.pendingPatch) for (const row of m) Object.assign(row, this.pendingPatch);
    if (this.isDelete) {
      for (const row of m) {
        const idx = this.rows.indexOf(row);
        if (idx >= 0) this.rows.splice(idx, 1);
      }
    }
    return m;
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.applyPendingPatch();
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  async single(): Promise<{ data: Row | null; error: { code: string } | null }> {
    const m = this.applyPendingPatch();
    return m[0] ? { data: { ...m[0] }, error: null } : { data: null, error: { code: 'PGRST116' } };
  }
  then<T>(resolve: (v: { data: Row[]; count: number; error: { code: string } | null }) => T): Promise<T> {
    if (this.insertError) return Promise.resolve(resolve({ data: [], count: 0, error: this.insertError }));
    const m = this.applyPendingPatch();
    return Promise.resolve(resolve({ data: m.map((r) => ({ ...r })), count: m.length, error: null }));
  }
  update(patch: Row): this {
    this.pendingPatch = patch;
    return this;
  }
  delete(): this {
    this.isDelete = true;
    return this;
  }
  insert(row?: Row): this {
    if (row && this.table === 'runtime_execution_locks' && row.idempotency_key) {
      const conflict = this.rows.some((r) => r.idempotency_key === row.idempotency_key);
      if (conflict) { this.insertError = { code: '23505' }; return this; }
    }
    if (row) this.rows.push({ ...row });
    return this;
  }
  private insertError: { code: string } | null = null;
}

const SEEDED_WORKFLOW: Row = {
  id: WORKFLOW_ID,
  user_id: OWNER_ID,
  status: 'active',
  active_deployment_version_id: null,
  workflow_json: { nodes: [], connections: {} },
};

let tables: Record<string, Row[]>;

function freshTables(): Record<string, Row[]> {
  return {
    workflows: [{ ...SEEDED_WORKFLOW }],
    workflow_executions_v2: [],
    deployment_versions: [],
    runtime_webhook_request_log: [],
    runtime_security_alerts: [],
  };
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = []), name),
    // Phase 8.1: concurrency is now an atomic RPC, not a SELECT count(*) the
    // route does itself. Derive the same "is this scope at its limit"
    // answer these tests already seed via tables.workflow_executions_v2's
    // 'running' rows, so the existing seed-based test setup keeps working
    // against the new reservation-based implementation.
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'reserve_concurrency_slot') {
        const running = (tables.workflow_executions_v2 ?? []).filter((r) => r.status === 'running');
        const workflowRunning = running.filter((r) => r.workflow_id === args.p_workflow_id).length;
        const maxPerWorkflow = Number(args.p_max_per_workflow ?? 3);
        if (workflowRunning >= maxPerWorkflow) {
          return { data: { reserved: false, reason: 'WORKFLOW_CONCURRENCY_LIMIT', current: workflowRunning, limit: maxPerWorkflow }, error: null };
        }
        const userRunning = running.filter((r) => r.user_id === args.p_user_id).length;
        const maxPerUser = Number(args.p_max_per_user ?? 10);
        if (userRunning >= maxPerUser) {
          return { data: { reserved: false, reason: 'USER_CONCURRENCY_LIMIT', current: userRunning, limit: maxPerUser }, error: null };
        }
        return { data: { reserved: true }, error: null };
      }
      return { data: null, error: null };
    }),
  })),
  getUserFromRequest: vi.fn(),
}));

type EnqueueParams = { queueName: string; taskType: string; payload: Record<string, unknown>; dedupeKey?: string };
const enqueueRuntimeJobMock = vi.fn(async (_params: EnqueueParams) => ({ enqueued: true, queueJobId: 'job-1' }));
vi.mock('@/lib/runtime/queue', () => ({
  enqueueRuntimeJob: (params: EnqueueParams) => enqueueRuntimeJobMock(params),
}));

vi.mock('@/lib/runtime/webhook-security', () => ({
  guardWebhookRequest: vi.fn(async (input: { rawBody: string }) => ({
    allowed: true,
    suspiciousScore: 0,
    requestHash: `hash:${input.rawBody.length}`,
  })),
  suspiciousExecutionScore: vi.fn(() => 0),
}));

const runWorkflowExecutionMock = vi.fn(async (_opts: { workflowJson: unknown; deploymentVersionId: string | null }) => ({ executionId: 'exec-1', status: 'success', currentNodeId: null, error: null }));
vi.mock('@/lib/workflow-runtime/engine', () => ({
  runWorkflowExecution: runWorkflowExecutionMock,
}));

const pollDueSchedulesMock = vi.fn(async () => ({ fired: 0, skipped: 0, errors: 0 }));
vi.mock('@/lib/runtime/scheduler', () => ({
  pollDueSchedules: pollDueSchedulesMock,
}));

function makeReq(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(new URL(url), init);
}

beforeEach(() => {
  tables = freshTables();
  runWorkflowExecutionMock.mockClear();
  enqueueRuntimeJobMock.mockClear();
  enqueueRuntimeJobMock.mockResolvedValue({ enqueued: true, queueJobId: 'job-1' });
});

// ─── Webhook: lifecycle gating ──────────────────────────────────────────────

describe('POST /api/workflows/[id]/webhook — lifecycle status gate', () => {
  it.each(['draft', 'paused', 'disabled', 'archived', 'error', 'validating'])(
    'rejects with 422 when workflow.status is "%s" (never executes)',
    async (status) => {
      tables.workflows[0].status = status;
      const { POST } = await import('../app/api/workflows/[id]/webhook/route');
      const res = await POST(
        makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/webhook`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
        { params: { id: WORKFLOW_ID } },
      );
      expect(res.status).toBe(422);
      expect(runWorkflowExecutionMock).not.toHaveBeenCalled();
    },
  );

  it('allows execution when workflow.status is "active" — dispatches (async) rather than running inline', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/webhook`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
      { params: { id: WORKFLOW_ID } },
    );
    expect(res.status).toBe(202);
    // Phase 8.1: the route no longer calls the engine directly — it enqueues.
    expect(runWorkflowExecutionMock).not.toHaveBeenCalled();
    expect(enqueueRuntimeJobMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.executionId).toBeTruthy();
  });

  it('returns 404 (not workflow status/details) for a nonexistent workflow id', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const res = await POST(
      makeReq('http://localhost/api/workflows/does-not-exist/webhook', { method: 'POST', body: '{}' }),
      { params: { id: 'does-not-exist' } },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(OWNER_ID);
  });
});

// ─── Webhook: HTTP method allowlist ─────────────────────────────────────────

describe('POST /api/workflows/[id]/webhook — HTTP method validation', () => {
  it('rejects a method not declared on the webhook trigger node with 405', async () => {
    tables.workflows[0].workflow_json = {
      nodes: [{ type: 'n8n-nodes-base.webhook', parameters: { httpMethod: 'GET' } }],
      connections: {},
    };
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/webhook`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
      { params: { id: WORKFLOW_ID } },
    );
    expect(res.status).toBe(405);
    expect(runWorkflowExecutionMock).not.toHaveBeenCalled();
  });
});

// ─── Webhook: payload size ───────────────────────────────────────────────────

describe('POST /api/workflows/[id]/webhook — oversized payload rejection', () => {
  it('rejects a request whose declared Content-Length exceeds the cap before reading the body', async () => {
    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/webhook`, {
        method: 'POST',
        body: '{}',
        headers: { 'content-length': String(50 * 1024 * 1024) },
      }),
      { params: { id: WORKFLOW_ID } },
    );
    expect(res.status).toBe(413);
    expect(runWorkflowExecutionMock).not.toHaveBeenCalled();
  });
});

// ─── Webhook: quota + concurrency bypass ────────────────────────────────────

describe('POST /api/workflows/[id]/webhook — quota and concurrency enforcement', () => {
  it('rejects with 429 PLAN_LIMIT_REACHED once the owner exceeds their monthly execution quota, and never runs the workflow', async () => {
    const now = new Date().toISOString();
    tables.workflow_executions_v2 = Array.from({ length: 25 }, (_, i) => ({
      id: `e${i}`, user_id: OWNER_ID, workflow_id: WORKFLOW_ID, status: 'success', created_at: now,
    }));

    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/webhook`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
      { params: { id: WORKFLOW_ID } },
    );

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('PLAN_LIMIT_REACHED');
    expect(runWorkflowExecutionMock).not.toHaveBeenCalled();
  });

  it('rejects with 429 when the workflow is already at its concurrency limit, and never runs the workflow again', async () => {
    tables.workflow_executions_v2 = [
      { id: 'r1', user_id: OWNER_ID, workflow_id: WORKFLOW_ID, status: 'running' },
      { id: 'r2', user_id: OWNER_ID, workflow_id: WORKFLOW_ID, status: 'running' },
      { id: 'r3', user_id: OWNER_ID, workflow_id: WORKFLOW_ID, status: 'running' },
    ];

    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/webhook`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
      { params: { id: WORKFLOW_ID } },
    );

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('WORKFLOW_CONCURRENCY_LIMIT');
    expect(runWorkflowExecutionMock).not.toHaveBeenCalled();
  });
});

// ─── Webhook: frozen deployment version is what actually executes ──────────

describe('POST /api/workflows/[id]/webhook — resolves the frozen deployed version, not live draft JSON', () => {
  it('identifies active_deployment_version_id and passes it (not live workflow_json) through to dispatch — the worker re-resolves the actual frozen snapshot itself (see tests/security-worker-tamper-resistance.test.ts)', async () => {
    tables.workflows[0].active_deployment_version_id = 'dv-1';
    tables.workflows[0].workflow_json = { nodes: [{ type: 'EDITED-AFTER-DEPLOY' }], connections: {} };
    tables.deployment_versions = [{ id: 'dv-1', workflow_data: { nodes: [{ type: 'FROZEN-AT-DEPLOY' }], connections: {} } }];

    const { POST } = await import('../app/api/workflows/[id]/webhook/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/webhook`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
      { params: { id: WORKFLOW_ID } },
    );

    expect(res.status).toBe(202);
    expect(runWorkflowExecutionMock).not.toHaveBeenCalled(); // async dispatch — never runs inline
    expect(enqueueRuntimeJobMock).toHaveBeenCalledTimes(1);
    const enqueuedPayload = enqueueRuntimeJobMock.mock.calls[0][0].payload;
    expect((enqueuedPayload.args as Record<string, unknown>).deploymentVersionId).toBe('dv-1');
    // The job payload never carries the workflow JSON itself.
    expect(JSON.stringify(enqueuedPayload)).not.toContain('FROZEN-AT-DEPLOY');
    expect(JSON.stringify(enqueuedPayload)).not.toContain('EDITED-AFTER-DEPLOY');
  });
});

// ─── Cron dispatch-schedules: bearer auth ───────────────────────────────────

describe('GET /api/cron/dispatch-schedules — CRON_SECRET auth', () => {
  const ORIGINAL_SECRET = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
    pollDueSchedulesMock.mockClear();
  });

  it('rejects with 401 when no Authorization header is present', async () => {
    const { GET } = await import('../app/api/cron/dispatch-schedules/route');
    const res = await GET(makeReq('http://localhost/api/cron/dispatch-schedules'));
    expect(res.status).toBe(401);
    expect(pollDueSchedulesMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the bearer token is wrong', async () => {
    const { GET } = await import('../app/api/cron/dispatch-schedules/route');
    const res = await GET(makeReq('http://localhost/api/cron/dispatch-schedules', {
      headers: { authorization: 'Bearer wrong-secret' },
    }));
    expect(res.status).toBe(401);
    expect(pollDueSchedulesMock).not.toHaveBeenCalled();
  });

  it('accepts and dispatches when the bearer token matches CRON_SECRET', async () => {
    const { GET } = await import('../app/api/cron/dispatch-schedules/route');
    const res = await GET(makeReq('http://localhost/api/cron/dispatch-schedules', {
      headers: { authorization: 'Bearer test-cron-secret' },
    }));
    expect(res.status).toBe(200);
    expect(pollDueSchedulesMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toHaveProperty('fired');

    process.env.CRON_SECRET = ORIGINAL_SECRET;
  });

  it('returns 500 (not a silent no-op) when CRON_SECRET is not configured at all', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('../app/api/cron/dispatch-schedules/route');
    const res = await GET(makeReq('http://localhost/api/cron/dispatch-schedules', {
      headers: { authorization: 'Bearer anything' },
    }));
    expect(res.status).toBe(500);
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  });
});

// ─── Lifecycle route: cross-tenant IDOR ─────────────────────────────────────

describe('POST /api/workflows/[id]/lifecycle — cross-tenant access (IDOR)', () => {
  beforeEach(async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockReset();
  });

  it("returns 404 and leaves the target workflow's status untouched when a different user attempts to pause it", async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);

    const { POST } = await import('../app/api/workflows/[id]/lifecycle/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'pause' }) }),
      { params: { id: WORKFLOW_ID } },
    );

    expect(res.status).toBe(404);
    expect(tables.workflows[0].status).toBe('active'); // unchanged
  });

  it("returns 404 when a different user attempts to activate someone else's workflow", async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);

    tables.workflows[0].status = 'draft';
    const { POST } = await import('../app/api/workflows/[id]/lifecycle/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'activate' }) }),
      { params: { id: WORKFLOW_ID } },
    );

    expect(res.status).toBe(404);
    expect(tables.workflows[0].status).toBe('draft'); // never transitioned to validating/active
  });

  // Phase 9.1.5: /api/workflows/[id]/lifecycle became the single canonical
  // activation path, gated by the account's plan (canDeployWorkflow) — this
  // proves the gate fires for the *actual owner* on a free-tier account
  // (no seeded subscription row -> defaults to the free plan, deploy
  // disabled) with the correct PRO_REQUIRED/403 shape, and — the point of
  // placing it right after the IDOR test above — that this entitlement
  // check never fires ahead of (and so never masks) the ownership check.
  it("returns 403 PRO_REQUIRED — not 404 — when the actual owner activates on a plan without deploy enabled", async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    tables.workflows[0].status = 'draft';
    const { POST } = await import('../app/api/workflows/[id]/lifecycle/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'activate' }) }),
      { params: { id: WORKFLOW_ID } },
    );
    const payload = await res.json() as { success: boolean; error?: string; redirect?: string };

    expect(res.status).toBe(403);
    expect(payload.error).toBe('PRO_REQUIRED');
    expect(payload.redirect).toBe('/pricing');
    expect(tables.workflows[0].status).toBe('draft'); // never transitioned to validating/active
  });

  it('returns 401 when there is no authenticated user at all', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);

    const { POST } = await import('../app/api/workflows/[id]/lifecycle/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'pause' }) }),
      { params: { id: WORKFLOW_ID } },
    );
    expect(res.status).toBe(401);
  });

  it('rejects an unrecognized action with 400 before touching the database', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    const { POST } = await import('../app/api/workflows/[id]/lifecycle/route');
    const res = await POST(
      makeReq(`http://localhost/api/workflows/${WORKFLOW_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'delete_everything' }) }),
      { params: { id: WORKFLOW_ID } },
    );
    expect(res.status).toBe(400);
    expect(tables.workflows[0].status).toBe('active');
  });
});
