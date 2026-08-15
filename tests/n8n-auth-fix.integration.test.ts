/**
 * Integration tests — C-01 / C-02 security fix verification
 *
 * Proves that app/api/n8n/route.ts now:
 *   - Requires authentication on every GET and POST action
 *   - Does NOT call listWorkflows() (global n8n list) on action=list
 *   - Enforces ownership before status / executions / activate / deactivate
 *   - Returns 404 (not 403) for foreign workflow IDs to avoid enumeration
 *
 * All tests invoke the real handler functions with mocked I/O dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('server-only', () => ({}));

// getUserFromRequest is the single auth gate now used by both handlers.
// We control its return value per-test.
vi.mock('@/lib/supabase-server', () => ({
  getUserFromRequest: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/ai-engine/n8n-deployer', () => ({
  getN8nConfig: vi.fn(() => ({ apiUrl: 'http://n8n.internal', apiKey: 'key' })),
  listWorkflows:      vi.fn().mockResolvedValue([]),
  getWorkflowStatus:  vi.fn().mockResolvedValue({ id: 'n8n-wf-aaa', active: true }),
  listExecutions:     vi.fn().mockResolvedValue([]),
  createWorkflow:     vi.fn().mockResolvedValue({ status: 'draft', workflowId: 'new-wf' }),
  activateWorkflow:   vi.fn().mockResolvedValue(undefined),
  deactivateWorkflow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/integrations', () => ({
  injectCredentialsIntoWorkflow: vi.fn((wf: unknown) => wf),
  requiredProvidersFromWorkflow:  vi.fn(() => []),
}));

vi.mock('@/lib/security/encryption', () => ({
  decryptIntegrationCredentials: vi.fn((d: unknown) => d),
}));

// ── Imports (after mocks are registered) ─────────────────────────────────────

import { GET, POST } from '@/app/api/n8n/route';
import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { listWorkflows, activateWorkflow, deactivateWorkflow, getWorkflowStatus, listExecutions } from '@/lib/ai-engine/n8n-deployer';

// ── Helpers ───────────────────────────────────────────────────────────────────

const USER_A = { id: 'user-a-uuid', email: 'a@example.com' };
const USER_B = { id: 'user-b-uuid', email: 'b@example.com' };

// n8n workflow ID that belongs to USER_A in our DB
const WORKFLOW_OF_A = 'n8n-wf-aaa';
// n8n workflow ID that belongs to USER_B in our DB
const WORKFLOW_OF_B = 'n8n-wf-bbb';

function makeGet(url: string): NextRequest {
  return new NextRequest(new URL(url));
}

function makePost(body: unknown): NextRequest {
  return new NextRequest(new URL('http://localhost/api/n8n'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// DB mock: simulates workflows table for verifyN8nWorkflowOwnership.
// Returns a row only when (userId, n8nWorkflowId) matches the fixture above.
function makeDbMock(_requestingUserId: string): unknown {
  const ownerOf: Record<string, string> = {
    [WORKFLOW_OF_A]: USER_A.id,
    [WORKFLOW_OF_B]: USER_B.id,
  };

  return {
    from: vi.fn((table: string) => {
      if (table === 'workflows') {
        const chain: Record<string, unknown> = {};
        let filters: Record<string, string> = {};
        chain['select']      = vi.fn(() => chain);
        chain['eq']          = vi.fn((col: string, val: string) => { filters[col] = val; return chain; });
        chain['not']         = vi.fn(() => chain);
        chain['order']       = vi.fn(() => chain);
        chain['limit']       = vi.fn(() => chain);
        chain['maybeSingle'] = vi.fn(() => {
          // ownership check: eq('n8n_workflow_id', X).eq('user_id', Y)
          const n8nId = filters['n8n_workflow_id'];
          const uid   = filters['user_id'];
          if (n8nId && uid) {
            const ownerUid = ownerOf[n8nId];
            return Promise.resolve({ data: ownerUid === uid ? { id: 'row-id' } : null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        });
        // Thenable for listing (SELECT without maybeSingle)
        chain['then'] = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({
            data: [{ id: 'w1', name: 'My Workflow', n8n_workflow_id: WORKFLOW_OF_A }],
            error: null,
          }).then(resolve);
        return chain;
      }
      // user_integrations or other tables — return empty
      const generic: Record<string, unknown> = {};
      generic['select'] = vi.fn(() => generic);
      generic['eq']     = vi.fn(() => generic);
      generic['then']   = (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve);
      return generic;
    }),
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// UNAUTHENTICATED ACCESS — every action must return 401
// =============================================================================

describe('Unauthenticated requests', () => {
  beforeEach(() => {
    vi.mocked(getUserFromRequest).mockResolvedValue(null);
  });

  it('GET action=list → 401', async () => {
    const res = await GET(makeGet('http://localhost/api/n8n?action=list'));
    expect(res.status).toBe(401);
  });

  it('GET action=status → 401', async () => {
    const res = await GET(makeGet(`http://localhost/api/n8n?action=status&workflowId=${WORKFLOW_OF_A}`));
    expect(res.status).toBe(401);
  });

  it('GET action=executions → 401', async () => {
    const res = await GET(makeGet(`http://localhost/api/n8n?action=executions&workflowId=${WORKFLOW_OF_A}`));
    expect(res.status).toBe(401);
  });

  it('GET no action → 401', async () => {
    const res = await GET(makeGet('http://localhost/api/n8n'));
    expect(res.status).toBe(401);
  });

  it('POST create → 401', async () => {
    const res = await POST(makePost({ action: 'create', workflow: { name: 'x', nodes: [], connections: {} } }));
    expect(res.status).toBe(401);
  });

  it('POST activate → 401', async () => {
    const res = await POST(makePost({ action: 'activate', workflowId: WORKFLOW_OF_A }));
    expect(res.status).toBe(401);
  });

  it('POST deactivate → 401', async () => {
    const res = await POST(makePost({ action: 'deactivate', workflowId: WORKFLOW_OF_A }));
    expect(res.status).toBe(401);
  });

  it('listWorkflows() is never called for unauthenticated requests', async () => {
    await GET(makeGet('http://localhost/api/n8n?action=list'));
    expect(listWorkflows).not.toHaveBeenCalled();
  });
});

// =============================================================================
// C-01 — action=list must NOT expose global n8n workflows
// =============================================================================

describe('C-01 — action=list scoped to authenticated user', () => {
  beforeEach(() => {
    vi.mocked(getUserFromRequest).mockResolvedValue(USER_A);
    vi.mocked(createServiceClient).mockReturnValue(makeDbMock(USER_A.id) as unknown as ReturnType<typeof createServiceClient>);
  });

  it('listWorkflows() is never called — global enumeration blocked', async () => {
    await GET(makeGet('http://localhost/api/n8n?action=list'));
    expect(listWorkflows).not.toHaveBeenCalled();
  });

  it('returns 200 with the user\'s own workflows from the DB', async () => {
    const res = await GET(makeGet('http://localhost/api/n8n?action=list'));
    expect(res.status).toBe(200);
    const body = await res.json() as { configured: boolean; workflows: unknown[] };
    expect(body.configured).toBe(true);
    // Returns the user's own workflows (from DB mock), not a global list
    expect(Array.isArray(body.workflows)).toBe(true);
  });
});

// =============================================================================
// C-01 — GET status and executions: ownership enforced
// =============================================================================

describe('C-01 — GET status/executions cross-tenant isolation', () => {
  it('User A can get status of their own workflow', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(USER_A);
    vi.mocked(createServiceClient).mockReturnValue(makeDbMock(USER_A.id) as unknown as ReturnType<typeof createServiceClient>);

    const res = await GET(makeGet(`http://localhost/api/n8n?action=status&workflowId=${WORKFLOW_OF_A}`));
    expect(res.status).toBe(200);
    expect(getWorkflowStatus).toHaveBeenCalledWith(expect.anything(), WORKFLOW_OF_A);
  });

  it('User B cannot get status of User A\'s workflow → 404', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(USER_B);
    vi.mocked(createServiceClient).mockReturnValue(makeDbMock(USER_B.id) as unknown as ReturnType<typeof createServiceClient>);

    const res = await GET(makeGet(`http://localhost/api/n8n?action=status&workflowId=${WORKFLOW_OF_A}`));
    expect(res.status).toBe(404);
    // n8n was never contacted
    expect(getWorkflowStatus).not.toHaveBeenCalled();
  });

  it('User A cannot get executions of User B\'s workflow → 404', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(USER_A);
    vi.mocked(createServiceClient).mockReturnValue(makeDbMock(USER_A.id) as unknown as ReturnType<typeof createServiceClient>);

    const res = await GET(makeGet(`http://localhost/api/n8n?action=executions&workflowId=${WORKFLOW_OF_B}`));
    expect(res.status).toBe(404);
    expect(listExecutions).not.toHaveBeenCalled();
  });

  it('User B can get executions of their own workflow', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(USER_B);
    vi.mocked(createServiceClient).mockReturnValue(makeDbMock(USER_B.id) as unknown as ReturnType<typeof createServiceClient>);

    const res = await GET(makeGet(`http://localhost/api/n8n?action=executions&workflowId=${WORKFLOW_OF_B}`));
    expect(res.status).toBe(200);
    expect(listExecutions).toHaveBeenCalledWith(expect.anything(), WORKFLOW_OF_B, expect.any(Number));
  });
});

// =============================================================================
// C-02 — POST activate: ownership enforced, no auth bypass
// =============================================================================

describe('C-02 — POST activate cross-tenant protection', () => {
  it('User A can activate their own workflow', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(USER_A);
    vi.mocked(createServiceClient).mockReturnValue(makeDbMock(USER_A.id) as unknown as ReturnType<typeof createServiceClient>);

    const res = await POST(makePost({ action: 'activate', workflowId: WORKFLOW_OF_A }));
    expect(res.status).toBe(200);
    expect(activateWorkflow).toHaveBeenCalledWith(expect.anything(), WORKFLOW_OF_A);
  });

  it('User B cannot activate User A\'s workflow → 404 (ownership blocked)', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(USER_B);
    vi.mocked(createServiceClient).mockReturnValue(makeDbMock(USER_B.id) as unknown as ReturnType<typeof createServiceClient>);

    const res = await POST(makePost({ action: 'activate', workflowId: WORKFLOW_OF_A }));
    expect(res.status).toBe(404);
    // n8n was never contacted
    expect(activateWorkflow).not.toHaveBeenCalled();
  });

  it('activate with no workflowId → 400', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(USER_A);
    vi.mocked(createServiceClient).mockReturnValue(makeDbMock(USER_A.id) as unknown as ReturnType<typeof createServiceClient>);

    const res = await POST(makePost({ action: 'activate' }));
    expect(res.status).toBe(400);
    expect(activateWorkflow).not.toHaveBeenCalled();
  });
});

// =============================================================================
// C-02 — POST deactivate: ownership enforced
// =============================================================================

describe('C-02 — POST deactivate cross-tenant protection', () => {
  it('User B can deactivate their own workflow', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(USER_B);
    vi.mocked(createServiceClient).mockReturnValue(makeDbMock(USER_B.id) as unknown as ReturnType<typeof createServiceClient>);

    const res = await POST(makePost({ action: 'deactivate', workflowId: WORKFLOW_OF_B }));
    expect(res.status).toBe(200);
    expect(deactivateWorkflow).toHaveBeenCalledWith(expect.anything(), WORKFLOW_OF_B);
  });

  it('User A cannot deactivate User B\'s workflow → 404', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(USER_A);
    vi.mocked(createServiceClient).mockReturnValue(makeDbMock(USER_A.id) as unknown as ReturnType<typeof createServiceClient>);

    const res = await POST(makePost({ action: 'deactivate', workflowId: WORKFLOW_OF_B }));
    expect(res.status).toBe(404);
    expect(deactivateWorkflow).not.toHaveBeenCalled();
  });

  it('deactivate with no workflowId → 400', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(USER_B);
    vi.mocked(createServiceClient).mockReturnValue(makeDbMock(USER_B.id) as unknown as ReturnType<typeof createServiceClient>);

    const res = await POST(makePost({ action: 'deactivate' }));
    expect(res.status).toBe(400);
    expect(deactivateWorkflow).not.toHaveBeenCalled();
  });
});

// =============================================================================
// POST create — auth moved to top level
// =============================================================================

describe('POST create — auth now at handler entry', () => {
  it('unauthenticated create → 401 (not 400 from body validation)', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(null);

    const res = await POST(makePost({ action: 'create', workflow: { name: 'x', nodes: [], connections: {} } }));
    // Must be 401, not 400 — auth checked before body validation
    expect(res.status).toBe(401);
  });
});
