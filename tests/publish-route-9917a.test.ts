/**
 * Phase 9.9.17A -- POST /api/workflows/[id]/publish route-level tests.
 * publishNewVersion()'s own behavior is unit-tested in
 * tests/workflow-publish-9917a.test.ts; this file proves the route's own
 * job: auth, ownership, entitlement, and translating each PublishResult
 * shape into the right HTTP status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase-server', () => ({ getUserFromRequest: vi.fn() }));

const loadWorkflowMock = vi.fn();
const publishNewVersionMock = vi.fn();
vi.mock('@/lib/workflow/lifecycle', () => ({
  loadWorkflow: (...args: unknown[]) => loadWorkflowMock(...args),
  publishNewVersion: (...args: unknown[]) => publishNewVersionMock(...args),
}));

const canDeployWorkflowMock = vi.fn();
vi.mock('@/lib/billing/plan-limits', () => ({ canDeployWorkflow: (...args: unknown[]) => canDeployWorkflowMock(...args) }));

function req(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost/x'), { method: 'POST', body: JSON.stringify(body) });
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { getUserFromRequest } = await import('@/lib/supabase-server');
  vi.mocked(getUserFromRequest).mockResolvedValue({ id: 'owner' } as never);
  loadWorkflowMock.mockResolvedValue({ id: 'wf-1', user_id: 'owner' });
  canDeployWorkflowMock.mockResolvedValue({ allowed: true });
});

describe('POST /api/workflows/[id]/publish', () => {
  it('requires authentication', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue(null as never);
    const { POST } = await import('../app/api/workflows/[id]/publish/route');
    const res = await POST(req({ expectedUpdatedAt: 't1' }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(401);
  });

  it('requires expectedUpdatedAt', async () => {
    const { POST } = await import('../app/api/workflows/[id]/publish/route');
    const res = await POST(req({}), { params: { id: 'wf-1' } });
    expect(res.status).toBe(400);
    expect(publishNewVersionMock).not.toHaveBeenCalled();
  });

  it('404s for a workflow this user does not own, never calls publishNewVersion', async () => {
    loadWorkflowMock.mockResolvedValue(null);
    const { POST } = await import('../app/api/workflows/[id]/publish/route');
    const res = await POST(req({ expectedUpdatedAt: 't1' }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(404);
    expect(publishNewVersionMock).not.toHaveBeenCalled();
  });

  it('403s when the account is not entitled to deploy', async () => {
    canDeployWorkflowMock.mockResolvedValue({ allowed: false, reason: 'Upgrade required' });
    const { POST } = await import('../app/api/workflows/[id]/publish/route');
    const res = await POST(req({ expectedUpdatedAt: 't1' }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(403);
    expect(publishNewVersionMock).not.toHaveBeenCalled();
  });

  it('200 on success, reports the new version', async () => {
    publishNewVersionMock.mockResolvedValue({ success: true, alreadyUpToDate: false, version: 2, deploymentVersionId: 'dv-2' });
    const { POST } = await import('../app/api/workflows/[id]/publish/route');
    const res = await POST(req({ expectedUpdatedAt: 't1' }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, alreadyUpToDate: false, version: 2, deploymentVersionId: 'dv-2' });
  });

  it('422 on validation_failed, surfaces the exact errors', async () => {
    publishNewVersionMock.mockResolvedValue({ success: false, reason: 'validation_failed', errors: ['bad thing'] });
    const { POST } = await import('../app/api/workflows/[id]/publish/route');
    const res = await POST(req({ expectedUpdatedAt: 't1' }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors).toEqual(['bad thing']);
  });

  it('409 on stale_draft, includes latestUpdatedAt', async () => {
    publishNewVersionMock.mockResolvedValue({ success: false, reason: 'stale_draft', latestUpdatedAt: 't2' });
    const { POST } = await import('../app/api/workflows/[id]/publish/route');
    const res = await POST(req({ expectedUpdatedAt: 't1' }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.latestUpdatedAt).toBe('t2');
  });

  it('409 on a version-collision conflict', async () => {
    publishNewVersionMock.mockResolvedValue({ success: false, reason: 'conflict', message: 'Another publish just completed.' });
    const { POST } = await import('../app/api/workflows/[id]/publish/route');
    const res = await POST(req({ expectedUpdatedAt: 't1' }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(409);
  });

  it('422 on not_executable', async () => {
    publishNewVersionMock.mockResolvedValue({ success: false, reason: 'not_executable', message: 'Use Activate instead.' });
    const { POST } = await import('../app/api/workflows/[id]/publish/route');
    const res = await POST(req({ expectedUpdatedAt: 't1' }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(422);
  });
});
