/**
 * Phase 9.9.16 -- Part C/D: PATCH /api/workflows/[id]/qualification-policy.
 * node-config-save.ts's own CAS/guard behavior is tested separately
 * (tests/node-config-save-9916.test.ts) -- this file mocks it and proves
 * this route's OWN job: rejecting a denylisted/malformed policy BEFORE
 * ever reaching the database, and building the right node mutation for a
 * valid one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = 'user-owner';
const WORKFLOW_ID = 'wf-1';

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
  patchWorkflowNodeMock.mockResolvedValue({ ok: true, node: {}, updatedAt: '2026-01-02T00:00:00.000Z' });
  const { getUserFromRequest } = await import('@/lib/supabase-server');
  vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);
});

describe('PATCH /api/workflows/[id]/qualification-policy', () => {
  it('requires nodeId and expectedUpdatedAt', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/qualification-policy/route');
    const res = await PATCH(req({}), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(400);
    expect(patchWorkflowNodeMock).not.toHaveBeenCalled();
  });

  it('rejects a denylisted field name in allowedInputFields before calling patchWorkflowNode', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/qualification-policy/route');
    const res = await PATCH(req({
      nodeId: 'ai1', expectedUpdatedAt: 't1',
      qualificationPolicy: { allowedInputFields: ['api_key'], fields: [{ field: 'api_key', kind: 'text' }] },
    }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(400);
    expect(patchWorkflowNodeMock).not.toHaveBeenCalled();
  });

  it('rejects a field rule whose name is not in allowedInputFields', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/qualification-policy/route');
    const res = await PATCH(req({
      nodeId: 'ai1', expectedUpdatedAt: 't1',
      qualificationPolicy: { allowedInputFields: ['budget'], fields: [{ field: 'other_field', kind: 'text' }] },
    }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(400);
    expect(patchWorkflowNodeMock).not.toHaveBeenCalled();
  });

  it('rejects an enum rule with neither positiveValues nor negativeValues', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/qualification-policy/route');
    const res = await PATCH(req({
      nodeId: 'ai1', expectedUpdatedAt: 't1',
      qualificationPolicy: { allowedInputFields: ['tier'], fields: [{ field: 'tier', kind: 'enum' }] },
    }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(400);
    expect(patchWorkflowNodeMock).not.toHaveBeenCalled();
  });

  it('rejects a confidenceThreshold outside [0, 1]', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/qualification-policy/route');
    const res = await PATCH(req({ nodeId: 'ai1', expectedUpdatedAt: 't1', confidenceThreshold: 1.5 }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(400);
    expect(patchWorkflowNodeMock).not.toHaveBeenCalled();
  });

  it('rejects an empty allowedLabels array', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/qualification-policy/route');
    const res = await PATCH(req({ nodeId: 'ai1', expectedUpdatedAt: 't1', allowedLabels: [] }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(400);
    expect(patchWorkflowNodeMock).not.toHaveBeenCalled();
  });

  it('a valid, well-formed policy is passed through to patchWorkflowNode', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/qualification-policy/route');
    const res = await PATCH(req({
      nodeId: 'ai1', expectedUpdatedAt: 't1', confidenceThreshold: 0.7, allowedLabels: ['Hot', 'Warm', 'Cold'],
      qualificationPolicy: { allowedInputFields: ['budget'], fields: [{ field: 'budget', kind: 'numeric', positiveMin: 10000 }] },
    }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(200);
    expect(patchWorkflowNodeMock).toHaveBeenCalledWith(expect.objectContaining({ userId: OWNER_ID, workflowId: WORKFLOW_ID, nodeId: 'ai1', expectedUpdatedAt: 't1' }));
  });

  it('qualificationPolicy: null clears an existing policy', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/qualification-policy/route');
    await PATCH(req({ nodeId: 'ai1', expectedUpdatedAt: 't1', qualificationPolicy: null }), { params: { id: WORKFLOW_ID } });
    const call = patchWorkflowNodeMock.mock.calls[0][0];
    const result = call.mutate({ id: 'ai1', type: 'magicflux-nodes.aiClassifier', parameters: { instruction: 'x', qualificationPolicy: { version: 1, allowedInputFields: [], fields: [{ field: 'a', kind: 'text' }] } } }, []);
    expect(result.ok).toBe(true);
    expect(result.node.parameters.qualificationPolicy).toBeUndefined();
  });

  it("the mutate() callback rejects a node that isn't an AI Classifier", async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/qualification-policy/route');
    await PATCH(req({ nodeId: 'slack1', expectedUpdatedAt: 't1', instruction: 'x' }), { params: { id: WORKFLOW_ID } });
    const call = patchWorkflowNodeMock.mock.calls[0][0];
    const result = call.mutate({ id: 'slack1', type: 'n8n-nodes-base.slack', parameters: {} }, []);
    expect(result.ok).toBe(false);
  });

  it('propagates a 409 conflict from patchWorkflowNode with latestUpdatedAt', async () => {
    patchWorkflowNodeMock.mockResolvedValue({ ok: false, status: 409, error: 'stale', latestUpdatedAt: 't2' });
    const { PATCH } = await import('../app/api/workflows/[id]/qualification-policy/route');
    const res = await PATCH(req({ nodeId: 'ai1', expectedUpdatedAt: 't1', instruction: 'x' }), { params: { id: WORKFLOW_ID } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.latestUpdatedAt).toBe('t2');
  });
});
