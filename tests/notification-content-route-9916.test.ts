/**
 * Phase 9.9.16 -- Part F/G: PATCH /api/workflows/[id]/notification-content.
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

describe('PATCH /api/workflows/[id]/notification-content', () => {
  it('rejects a non-string value', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/notification-content/route');
    const res = await PATCH(req({ nodeId: 'n1', expectedUpdatedAt: 't1', field: 'subject', value: 123 }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(400);
    expect(patchWorkflowNodeMock).not.toHaveBeenCalled();
  });

  it('mutate() rejects "message" on an email node (wrong field for node type)', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/notification-content/route');
    await PATCH(req({ nodeId: 'e1', expectedUpdatedAt: 't1', field: 'message', value: 'hi' }), { params: { id: 'wf-1' } });
    const call = patchWorkflowNodeMock.mock.calls[0][0];
    const result = call.mutate({ id: 'e1', type: 'n8n-nodes-base.emailSend', parameters: {} }, []);
    expect(result.ok).toBe(false);
  });

  it('mutate() rejects "subject" on a Slack node', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/notification-content/route');
    await PATCH(req({ nodeId: 's1', expectedUpdatedAt: 't1', field: 'subject', value: 'hi' }), { params: { id: 'wf-1' } });
    const call = patchWorkflowNodeMock.mock.calls[0][0];
    const result = call.mutate({ id: 's1', type: 'n8n-nodes-base.slack', parameters: {} }, []);
    expect(result.ok).toBe(false);
  });

  it('mutate() accepts "body" on an email node and merges it into parameters', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/notification-content/route');
    await PATCH(req({ nodeId: 'e1', expectedUpdatedAt: 't1', field: 'body', value: 'Hello {{$json["name"]}}' }), { params: { id: 'wf-1' } });
    const call = patchWorkflowNodeMock.mock.calls[0][0];
    const result = call.mutate({ id: 'e1', type: 'n8n-nodes-base.emailSend', parameters: { subject: 'existing' } }, []);
    expect(result.ok).toBe(true);
    expect(result.node.parameters.body).toBe('Hello {{$json["name"]}}');
    expect(result.node.parameters.subject).toBe('existing'); // untouched field preserved
  });

  it('mutate() rejects a node that is neither email nor Slack', async () => {
    const { PATCH } = await import('../app/api/workflows/[id]/notification-content/route');
    await PATCH(req({ nodeId: 'a1', expectedUpdatedAt: 't1', field: 'message', value: 'x' }), { params: { id: 'wf-1' } });
    const call = patchWorkflowNodeMock.mock.calls[0][0];
    const result = call.mutate({ id: 'a1', type: 'n8n-nodes-base.airtable', parameters: {} }, []);
    expect(result.ok).toBe(false);
  });

  it('Part D: actual guard rejection (a denylisted field reference) is enforced by node-config-save.ts, not bypassed here -- proven via the real guard, not a mock', async () => {
    vi.resetModules();
    const row = { id: 'wf-1', user_id: 'owner', updated_at: 't1', workflow_json: { nodes: [{ id: 'e1', type: 'n8n-nodes-base.emailSend', parameters: { subject: 'x' } }] } };
    vi.doMock('@/lib/supabase-server', () => ({
      getUserFromRequest: vi.fn().mockResolvedValue({ id: 'owner' }),
      createServiceClient: vi.fn(() => ({
        from: () => ({
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
          update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }),
        }),
      })),
    }));
    vi.doUnmock('@/lib/workflow/node-config-save');
    const { PATCH } = await import('../app/api/workflows/[id]/notification-content/route');
    const res = await PATCH(req({ nodeId: 'e1', expectedUpdatedAt: 't1', field: 'body', value: 'Ref: {{$json["_qualificationDecisionId"]}}' }), { params: { id: 'wf-1' } });
    expect(res.status).toBe(400);
  });
});
