/**
 * Phase 9.9.16 -- lib/workflow/node-config-save.ts: the shared primitive
 * every new node-config editor (AI policy, Human Review, notification
 * content, SLA) saves through. Proves the two structural guarantees it
 * exists to provide:
 *   - Part L: a save conditioned on `updated_at` still matching what was
 *     last read -- a lost race returns 409 with the CURRENT updated_at,
 *     never a silent overwrite.
 *   - Part D: the same activation-time guards run over the WHOLE resulting
 *     node set before anything is persisted -- a mutate() that would leave
 *     the workflow in an invalid shape is rejected, never written.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const WORKFLOW_ID = 'wf-1';
const USER_ID = 'user-1';

type Row = { id: string; user_id: string; workflow_json: unknown; updated_at: string };

let table: Row[];

// A minimal fluent mock matching exactly the calls node-config-save.ts
// makes: .from('workflows').select(...).eq(...).eq(...).maybeSingle() for
// reads, and .from('workflows').update(...).eq(...).eq(...).eq(...)
// .select(...).maybeSingle() for the CAS write.
class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private patch: Record<string, unknown> | null = null;
  private isUpdate = false;
  constructor(private getTable: () => Row[]) {}
  select(): this { return this; }
  update(patch: Record<string, unknown>): this { this.isUpdate = true; this.patch = patch; return this; }
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  private matched(): Row[] {
    return this.getTable().filter((r) => this.filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v));
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = this.matched();
    if (!this.isUpdate) return { data: rows[0] ?? null, error: null };
    if (rows.length === 0) return { data: null, error: null };
    Object.assign(rows[0], this.patch);
    return { data: rows[0], error: null };
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ from: (_name: string) => new FakeQuery(() => table) })),
}));

beforeEach(() => {
  table = [{ id: WORKFLOW_ID, user_id: USER_ID, workflow_json: { nodes: [{ id: 'n1', type: 'n8n-nodes-base.slack', parameters: { message: 'hello' } }] }, updated_at: '2026-01-01T00:00:00.000Z' }];
});

describe('patchWorkflowNode', () => {
  it('returns 404 when the workflow does not exist / is not owned', async () => {
    const { patchWorkflowNode } = await import('../lib/workflow/node-config-save');
    const result = await patchWorkflowNode({ userId: 'nope', workflowId: WORKFLOW_ID, nodeId: 'n1', expectedUpdatedAt: '2026-01-01T00:00:00.000Z', mutate: (n) => ({ ok: true, node: n }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });

  it('returns 404 when the node id is not found in the workflow', async () => {
    const { patchWorkflowNode } = await import('../lib/workflow/node-config-save');
    const result = await patchWorkflowNode({ userId: USER_ID, workflowId: WORKFLOW_ID, nodeId: 'does-not-exist', expectedUpdatedAt: '2026-01-01T00:00:00.000Z', mutate: (n) => ({ ok: true, node: n }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });

  it('Part L: a stale expectedUpdatedAt is rejected with 409 and the CURRENT updated_at, never silently overwritten', async () => {
    const { patchWorkflowNode } = await import('../lib/workflow/node-config-save');
    // Someone else already saved -- the row's real updated_at has moved on.
    table[0].updated_at = '2026-01-02T00:00:00.000Z';
    const result = await patchWorkflowNode({
      userId: USER_ID, workflowId: WORKFLOW_ID, nodeId: 'n1',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z', // stale
      mutate: (n) => ({ ok: true, node: { ...n, parameters: { ...(n.parameters as object), message: 'clobber attempt' } } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.status !== 409) throw new Error('expected a 409 conflict');
    expect(result.latestUpdatedAt).toBe('2026-01-02T00:00:00.000Z');
    // The clobber attempt must NOT have been written.
    expect((table[0].workflow_json as { nodes: Array<{ parameters: { message: string } }> }).nodes[0].parameters.message).toBe('hello');
  });

  it('a matching expectedUpdatedAt succeeds and returns the new updated_at', async () => {
    const { patchWorkflowNode } = await import('../lib/workflow/node-config-save');
    const result = await patchWorkflowNode({
      userId: USER_ID, workflowId: WORKFLOW_ID, nodeId: 'n1',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      mutate: (n) => ({ ok: true, node: { ...n, parameters: { ...(n.parameters as object), message: 'updated' } } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.node.parameters as { message: string }).message).toBe('updated');
    expect(result.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it("mutate()'s own rejection is returned as a 400, never persisted", async () => {
    const { patchWorkflowNode } = await import('../lib/workflow/node-config-save');
    const result = await patchWorkflowNode({
      userId: USER_ID, workflowId: WORKFLOW_ID, nodeId: 'n1',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      mutate: () => ({ ok: false, error: 'not the right node type' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe('not the right node type');
  });

  it('Part D: a mutation that would leave the qualification policy structurally invalid is rejected by the SAME guard activation uses, never persisted', async () => {
    table[0].workflow_json = { nodes: [{ id: 'ai1', type: 'magicflux-nodes.aiClassifier', parameters: { instruction: 'x', allowedLabels: ['Hot'], confidenceThreshold: 0.6 } }] };
    const { patchWorkflowNode } = await import('../lib/workflow/node-config-save');
    const result = await patchWorkflowNode({
      userId: USER_ID, workflowId: WORKFLOW_ID, nodeId: 'ai1',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      // Structurally invalid: claims a policy but with zero fields.
      mutate: (n) => ({ ok: true, node: { ...n, parameters: { ...(n.parameters as object), qualificationPolicy: { version: 1, allowedInputFields: [], fields: [] } } } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/qualificationPolicy/);
    // Never persisted -- the node's parameters are unchanged.
    const nodes = (table[0].workflow_json as { nodes: Array<{ parameters: Record<string, unknown> }> }).nodes;
    expect(nodes[0].parameters.qualificationPolicy).toBeUndefined();
  });
});
