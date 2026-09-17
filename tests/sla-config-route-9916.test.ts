/**
 * Phase 9.9.16 -- Part H: PATCH /api/workflows/[id]/sla-config.
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

describe('PATCH /api/workflows/[id]/sla-config', () => {
  it('rejects slaMinutes below the floor', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/sla-config/route');
    const res = await PATCH(req({ nodeId: 'sla1', expectedUpdatedAt: 't1', slaMinutes: 0 }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(400);
    expect(patchWorkflowNodeMock).not.toHaveBeenCalled();
  });

  it('rejects slaMinutes above the ceiling (likely a unit mistake, e.g. minutes typed as hours)', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/sla-config/route');
    const res = await PATCH(req({ nodeId: 'sla1', expectedUpdatedAt: 't1', slaMinutes: 999999 }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(400);
    expect(patchWorkflowNodeMock).not.toHaveBeenCalled();
  });

  it('rejects a negative escalationLevel', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/sla-config/route');
    const res = await PATCH(req({ nodeId: 'sla1', expectedUpdatedAt: 't1', escalationLevel: -1 }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(400);
    expect(patchWorkflowNodeMock).not.toHaveBeenCalled();
  });

  it('accepts a valid slaMinutes and passes it through', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/sla-config/route');
    const res = await PATCH(req({ nodeId: 'sla1', expectedUpdatedAt: 't1', slaMinutes: 15 }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(200);
    expect(patchWorkflowNodeMock).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'sla1', expectedUpdatedAt: 't1' }));
  });

  it("mutate() rejects a node that isn't an SLA/acknowledgment node", async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/sla-config/route');
    await PATCH(req({ nodeId: 'x', expectedUpdatedAt: 't1', slaMinutes: 15 }), { params: { id: 'wf-1' } });
    const call = patchWorkflowNodeMock.mock.calls[0][0];
    const result = call.mutate({ id: 'x', type: 'n8n-nodes-base.slack', parameters: {} }, []);
    expect(result.ok).toBe(false);
  });

  it('mutate() accepts magicflux-nodes.waitForAcknowledgment and merges slaMinutes', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/sla-config/route');
    await PATCH(req({ nodeId: 'sla1', expectedUpdatedAt: 't1', slaMinutes: 30 }), { params: { id: 'wf-1' } });
    const call = patchWorkflowNodeMock.mock.calls[0][0];
    const result = call.mutate({ id: 'sla1', type: 'magicflux-nodes.waitForAcknowledgment', parameters: { outputField: 'acknowledgment_status' } }, []);
    expect(result.ok).toBe(true);
    expect(result.node.parameters.slaMinutes).toBe(30);
    expect(result.node.parameters.outputField).toBe('acknowledgment_status');
  });
});
