/**
 * Phase 9.9.16 -- Part M: GET /api/workflows/[id]/readiness. Read-only --
 * never mutates workflow status (unlike activateWorkflow, which claims
 * 'validating'). Proves auth/ownership gating and that it correctly
 * aggregates a passing vs. failing guard into the response shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase-server', () => ({ getUserFromRequest: vi.fn() }));

const loadWorkflowMock = vi.fn();
vi.mock('@/lib/workflow/lifecycle', () => ({ loadWorkflow: (...args: unknown[]) => loadWorkflowMock(...args) }));

const checkWorkflowReadinessMock = vi.fn();
vi.mock('@/lib/workflow/readiness', () => ({ checkWorkflowReadiness: (...args: unknown[]) => checkWorkflowReadinessMock(...args) }));

beforeEach(async () => {
  loadWorkflowMock.mockReset();
  checkWorkflowReadinessMock.mockReset();
  const { getUserFromRequest } = await import('@/lib/supabase-server');
  vi.mocked(getUserFromRequest).mockResolvedValue({ id: 'owner' } as never);
});

describe('GET /api/workflows/[id]/readiness', () => {
  it('requires authentication', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);
    const { GET } = await import('../app/api/workflows/[id]/readiness/route');
    const res = await GET(new NextRequest(new URL('http://localhost/x')), { params: { id: 'wf-1' } });
    expect(res.status).toBe(401);
  });

  it('returns 404 for a workflow this user does not own', async () => {
    loadWorkflowMock.mockResolvedValue(null);
    const { GET } = await import('../app/api/workflows/[id]/readiness/route');
    const res = await GET(new NextRequest(new URL('http://localhost/x')), { params: { id: 'wf-1' } });
    expect(res.status).toBe(404);
  });

  it('returns the readiness summary without mutating anything', async () => {
    loadWorkflowMock.mockResolvedValue({ id: 'wf-1', user_id: 'owner', workflow_json: { nodes: [] }, status: 'draft' });
    checkWorkflowReadinessMock.mockResolvedValue({ ready: false, checks: [{ key: 'airtable', label: 'Airtable', ok: false, messages: ['not configured'] }] });
    const { GET } = await import('../app/api/workflows/[id]/readiness/route');
    const res = await GET(new NextRequest(new URL('http://localhost/x')), { params: { id: 'wf-1' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.checks[0].label).toBe('Airtable');
  });
});
