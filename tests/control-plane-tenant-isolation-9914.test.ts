/**
 * Phase 9.9.14 -- tenant-isolation fixes found during this phase's own
 * failure-recovery audit (not the phase's primary topic, but a real
 * cross-tenant data/mutation exposure surfaced while reading this code):
 *
 *   1. GET /api/runtime/control/executions/[executionId] had NO RBAC check
 *      at all and NO ownership check -- any authenticated user could read
 *      another tenant's full execution detail by guessing/knowing an id.
 *   2. GET /api/runtime/control/replay-visualizer had the same two gaps.
 *   3. POST /api/runtime/control/incidents (resolve/escalate/comment) let
 *      a non-admin operator holding manage_incidents mutate ANOTHER
 *      tenant's incident by guessing its UUID (no ownership scoping at all
 *      on the underlying resolveIncident/escalateIncident/appendIncidentEvent
 *      calls).
 *
 * Also covers the new recovery control plane (Part H/I):
 *   4. GET/POST /api/runtime/control/side-effects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/runtime/rbac', () => ({
  getUserPermissions: vi.fn(),
  requirePermission: vi.fn(),
}));

const OWNER_ID = '00000000-0000-4000-8000-0000000000a1';
const ATTACKER_ID = '00000000-0000-4000-8000-0000000000a2';
const EXEC_ID = 'exec-owner-1';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  order(): this { return this; }
  limit(): this { return this; }
  in(): this { return this; }
  private matched(): Row[] { return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)); }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    return { data: m[0] ?? null, error: null };
  }
  async single(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    return { data: m[0] ?? null, error: m[0] ? null : null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve(resolve({ data: this.matched(), error: null }));
  }
}

let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ from: (name: string) => new FakeQuery(tables[name] ?? []) })),
  getUserFromRequest: vi.fn(),
}));

vi.mock('@/lib/runtime/incident-manager', () => ({
  listActiveIncidents: vi.fn().mockResolvedValue([]),
  getIncidentById: vi.fn(),
  resolveIncident: vi.fn(),
  escalateIncident: vi.fn(),
  appendIncidentEvent: vi.fn(),
  recordOperatorAction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/runtime/event-store', () => ({ appendExecutionEvent: vi.fn().mockResolvedValue({ eventId: 'evt-1', sequenceNumber: 1 }) }));
vi.mock('@/lib/runtime/side-effect-ledger', () => ({ recordOperatorVerifiedOutcome: vi.fn() }));

beforeEach(() => {
  tables = {
    workflow_executions_v2: [{ id: EXEC_ID, workflow_id: 'wf-1', user_id: OWNER_ID, status: 'failed', started_at: null, completed_at: null, retry_count: 0, error_message: null, created_at: null }],
  };
  vi.clearAllMocks();
});

describe('GET /api/runtime/control/executions/[executionId] -- tenant isolation', () => {
  it('a non-owner, non-admin user gets 404, never the execution detail', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);
    const { getUserPermissions } = await import('@/lib/runtime/rbac');
    vi.mocked(getUserPermissions).mockResolvedValue(['view_runtime'] as never);

    const { GET } = await import('../app/api/runtime/control/executions/[executionId]/route');
    const req = new NextRequest(new URL(`http://localhost/api/runtime/control/executions/${EXEC_ID}`));
    const res = await GET(req, { params: { executionId: EXEC_ID } });
    expect(res.status).toBe(404);
  });

  it('a user with no view_runtime/admin_runtime permission at all is forbidden', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { getUserPermissions } = await import('@/lib/runtime/rbac');
    vi.mocked(getUserPermissions).mockResolvedValue([] as never);

    const { GET } = await import('../app/api/runtime/control/executions/[executionId]/route');
    const req = new NextRequest(new URL(`http://localhost/api/runtime/control/executions/${EXEC_ID}`));
    const res = await GET(req, { params: { executionId: EXEC_ID } });
    expect(res.status).toBe(403);
  });

  it('the owner themself can read their own execution detail', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { getUserPermissions } = await import('@/lib/runtime/rbac');
    vi.mocked(getUserPermissions).mockResolvedValue(['view_runtime'] as never);

    const { GET } = await import('../app/api/runtime/control/executions/[executionId]/route');
    const req = new NextRequest(new URL(`http://localhost/api/runtime/control/executions/${EXEC_ID}`));
    const res = await GET(req, { params: { executionId: EXEC_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.execution.id).toBe(EXEC_ID);
  });
});

describe('GET /api/runtime/control/replay-visualizer -- tenant isolation', () => {
  it('a non-owner, non-admin user gets 404, never the replay data', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);
    const { getUserPermissions } = await import('@/lib/runtime/rbac');
    vi.mocked(getUserPermissions).mockResolvedValue(['view_runtime'] as never);

    const { GET } = await import('../app/api/runtime/control/replay-visualizer/route');
    const req = new NextRequest(new URL(`http://localhost/api/runtime/control/replay-visualizer?execution_id=${EXEC_ID}`));
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it('requires view_runtime/admin_runtime -- previously had no permission check at all', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { getUserPermissions } = await import('@/lib/runtime/rbac');
    vi.mocked(getUserPermissions).mockResolvedValue([] as never);

    const { GET } = await import('../app/api/runtime/control/replay-visualizer/route');
    const req = new NextRequest(new URL(`http://localhost/api/runtime/control/replay-visualizer?execution_id=${EXEC_ID}`));
    const res = await GET(req);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/runtime/control/incidents -- ownership scoping for single-incident actions', () => {
  it('a non-admin operator cannot resolve an incident belonging to another tenant', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);
    const { getUserPermissions, requirePermission } = await import('@/lib/runtime/rbac');
    vi.mocked(getUserPermissions).mockResolvedValue(['manage_incidents'] as never);
    vi.mocked(requirePermission).mockResolvedValue(undefined as never);
    const { getIncidentById, resolveIncident } = await import('@/lib/runtime/incident-manager');
    vi.mocked(getIncidentById).mockResolvedValue(null as never); // scoped lookup finds nothing for this attacker

    const { POST } = await import('../app/api/runtime/control/incidents/route');
    const req = new NextRequest(new URL('http://localhost/api/runtime/control/incidents'), {
      method: 'POST',
      body: JSON.stringify({ action: 'resolve', incidentId: 'victim-incident' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    expect(resolveIncident).not.toHaveBeenCalled();
  });

  it('an admin can resolve any incident (ownership check skipped for admin)', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { getUserPermissions, requirePermission } = await import('@/lib/runtime/rbac');
    vi.mocked(getUserPermissions).mockResolvedValue(['manage_incidents', 'admin_runtime'] as never);
    vi.mocked(requirePermission).mockResolvedValue(undefined as never);
    const { resolveIncident } = await import('@/lib/runtime/incident-manager');
    vi.mocked(resolveIncident).mockResolvedValue(true as never);

    const { POST } = await import('../app/api/runtime/control/incidents/route');
    const req = new NextRequest(new URL('http://localhost/api/runtime/control/incidents'), {
      method: 'POST',
      body: JSON.stringify({ action: 'resolve', incidentId: 'any-incident' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});

describe('Recovery control plane: GET/POST /api/runtime/control/side-effects (Part H/I)', () => {
  it('GET requires view_runtime/admin', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { getUserPermissions } = await import('@/lib/runtime/rbac');
    vi.mocked(getUserPermissions).mockResolvedValue([] as never);

    const { GET } = await import('../app/api/runtime/control/side-effects/route');
    const req = new NextRequest(new URL('http://localhost/api/runtime/control/side-effects'));
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it('POST requires a non-empty note -- never a bare, unexplained verification', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { getUserPermissions, requirePermission } = await import('@/lib/runtime/rbac');
    vi.mocked(getUserPermissions).mockResolvedValue(['manage_executions'] as never);
    vi.mocked(requirePermission).mockResolvedValue(undefined as never);

    const { POST } = await import('../app/api/runtime/control/side-effects/route');
    const req = new NextRequest(new URL('http://localhost/api/runtime/control/side-effects'), {
      method: 'POST',
      body: JSON.stringify({ action: 'verify_succeeded', executionId: EXEC_ID, nodeId: 'node-1', note: '' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('POST rejects an execution the caller does not own', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: ATTACKER_ID } as never);
    const { getUserPermissions, requirePermission } = await import('@/lib/runtime/rbac');
    vi.mocked(getUserPermissions).mockResolvedValue(['manage_executions'] as never);
    vi.mocked(requirePermission).mockResolvedValue(undefined as never);

    const { POST } = await import('../app/api/runtime/control/side-effects/route');
    const req = new NextRequest(new URL('http://localhost/api/runtime/control/side-effects'), {
      method: 'POST',
      body: JSON.stringify({ action: 'verify_succeeded', executionId: EXEC_ID, nodeId: 'node-1', note: 'checked provider directly' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('POST succeeds for the owner and records the operator action + execution event', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { getUserPermissions, requirePermission } = await import('@/lib/runtime/rbac');
    vi.mocked(getUserPermissions).mockResolvedValue(['manage_executions'] as never);
    vi.mocked(requirePermission).mockResolvedValue(undefined as never);
    const { recordOperatorVerifiedOutcome } = await import('@/lib/runtime/side-effect-ledger');
    vi.mocked(recordOperatorVerifiedOutcome).mockResolvedValue({ ok: true, previousStatus: 'indeterminate' } as never);
    const { appendExecutionEvent } = await import('@/lib/runtime/event-store');
    const { recordOperatorAction } = await import('@/lib/runtime/incident-manager');

    const { POST } = await import('../app/api/runtime/control/side-effects/route');
    const req = new NextRequest(new URL('http://localhost/api/runtime/control/side-effects'), {
      method: 'POST',
      body: JSON.stringify({ action: 'verify_succeeded', executionId: EXEC_ID, nodeId: 'node-1', note: 'checked Airtable, record recABC exists once' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.newStatus).toBe('succeeded');
    expect(appendExecutionEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'side_effect_verified' }));
    expect(recordOperatorAction).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'verify_side_effect_succeeded' }));
  });

  it('POST surfaces a 409 when the underlying ledger row is not actually indeterminate (race/already resolved)', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
    const { getUserPermissions, requirePermission } = await import('@/lib/runtime/rbac');
    vi.mocked(getUserPermissions).mockResolvedValue(['manage_executions'] as never);
    vi.mocked(requirePermission).mockResolvedValue(undefined as never);
    const { recordOperatorVerifiedOutcome } = await import('@/lib/runtime/side-effect-ledger');
    vi.mocked(recordOperatorVerifiedOutcome).mockResolvedValue({ ok: false, reason: 'not indeterminate' } as never);

    const { POST } = await import('../app/api/runtime/control/side-effects/route');
    const req = new NextRequest(new URL('http://localhost/api/runtime/control/side-effects'), {
      method: 'POST',
      body: JSON.stringify({ action: 'verify_succeeded', executionId: EXEC_ID, nodeId: 'node-1', note: 'x' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
  });
});
