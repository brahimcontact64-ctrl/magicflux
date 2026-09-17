/**
 * Phase 9.9.16 -- Part E: PATCH /api/workflows/[id]/human-review-config.
 * The key safety property: outcomes can be renamed/appended but never
 * removed or reordered, since the runtime picks the downstream branch by
 * POSITION in this array (see the route's own doc comment).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/supabase-server', () => ({ getUserFromRequest: vi.fn() }));

const patchWorkflowNodeMock = vi.fn();
vi.mock('@/lib/workflow/node-config-save', () => ({
  patchWorkflowNode: (...args: unknown[]) => patchWorkflowNodeMock(...args),
  asConfigRecord: (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
}));

function req(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost/x'), { method: 'PATCH', body: JSON.stringify(body) });
}

beforeEach(async () => {
  patchWorkflowNodeMock.mockReset();
  patchWorkflowNodeMock.mockResolvedValue({ ok: true, node: {}, updatedAt: 't2' });
  const { getUserFromRequest } = await import('@/lib/supabase-server');
  vi.mocked(getUserFromRequest).mockResolvedValue({ id: 'owner' } as never);
});

describe('PATCH /api/workflows/[id]/human-review-config', () => {
  it('rejects duplicate outcome names', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/human-review-config/route');
    const res = await PATCH(req({ nodeId: 'hr1', expectedUpdatedAt: 't1', allowedOutcomes: ['Hot', 'Hot'] }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(400);
    expect(patchWorkflowNodeMock).not.toHaveBeenCalled();
  });

  it('rejects an empty outcome name', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/human-review-config/route');
    const res = await PATCH(req({ nodeId: 'hr1', expectedUpdatedAt: 't1', allowedOutcomes: ['Hot', '  '] }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(400);
    expect(patchWorkflowNodeMock).not.toHaveBeenCalled();
  });

  it("mutate() rejects removing an existing outcome (shrinking the array)", async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/human-review-config/route');
    await PATCH(req({ nodeId: 'hr1', expectedUpdatedAt: 't1', allowedOutcomes: ['Hot'] }), { params: { id: 'wf-1' } });
    const call = patchWorkflowNodeMock.mock.calls[0][0];
    const result = call.mutate({ id: 'hr1', type: 'magicflux-nodes.humanReview', parameters: { allowedOutcomes: ['Hot', 'Warm', 'Cold'] } }, []);
    expect(result.ok).toBe(false);
  });

  it('mutate() allows renaming in place (same length/order)', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/human-review-config/route');
    await PATCH(req({ nodeId: 'hr1', expectedUpdatedAt: 't1', allowedOutcomes: ['Hot-renamed', 'Warm', 'Cold'] }), { params: { id: 'wf-1' } });
    const call = patchWorkflowNodeMock.mock.calls[0][0];
    const result = call.mutate({ id: 'hr1', type: 'magicflux-nodes.humanReview', parameters: { allowedOutcomes: ['Hot', 'Warm', 'Cold'] } }, []);
    expect(result.ok).toBe(true);
  });

  it('mutate() allows appending a new outcome', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/human-review-config/route');
    await PATCH(req({ nodeId: 'hr1', expectedUpdatedAt: 't1', allowedOutcomes: ['Hot', 'Warm', 'Cold', 'Escalate'] }), { params: { id: 'wf-1' } });
    const call = patchWorkflowNodeMock.mock.calls[0][0];
    const result = call.mutate({ id: 'hr1', type: 'magicflux-nodes.humanReview', parameters: { allowedOutcomes: ['Hot', 'Warm', 'Cold'] } }, []);
    expect(result.ok).toBe(true);
  });

  it("mutate() rejects a node that isn't a Human Review node", async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/human-review-config/route');
    await PATCH(req({ nodeId: 'x', expectedUpdatedAt: 't1', instruction: 'y' }), { params: { id: 'wf-1' } });
    const call = patchWorkflowNodeMock.mock.calls[0][0];
    const result = call.mutate({ id: 'x', type: 'n8n-nodes-base.slack', parameters: {} }, []);
    expect(result.ok).toBe(false);
  });
});
