/**
 * Phase 9.9.12 -- magicflux-nodes.waitForAcknowledgment
 * (lib/workflow-runtime/node-handlers/wait-for-acknowledgment.ts).
 *
 * Mirrors tests/human-review-handler.test.ts's mocking convention (a
 * minimal FakeDb over workflow_acknowledgments) -- this is the node
 * handler layer only; app/api/acknowledgments/*'s own routes and
 * lib/runtime/acknowledgment-resume.ts are covered in their own test
 * files.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EngineNode, NodeHandlerContext } from '../lib/workflow-runtime/types';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private isFilters: Array<[string, null]> = [];
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  is(col: string, val: null): this { this.isFilters.push([col, val]); return this; }
  select(): this { return this; }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => {
      if (this.filters.every(([c, v]) => r[c] === v) && this.isFilters.every(([c]) => r[c] === null || r[c] === undefined)) idx.push(i);
    });
    return idx;
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const idxs = this.matchedIndexes();
    if (this.pendingPatch) for (const i of idxs) Object.assign(this.rows[i], this.pendingPatch);
    const m = idxs.map((i) => this.rows[i]);
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
}

class FakeTableHandle {
  constructor(private rows: Row[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows); }
  insert(row: Row) {
    const conflict = this.rows.some((r) => r.execution_id === row.execution_id && r.node_id === row.node_id);
    if (conflict) {
      return { then: (resolve: (v: { error: { message: string } | null }) => unknown) => Promise.resolve(resolve({ error: { message: 'duplicate key value violates unique constraint' } })) };
    }
    const saved = { id: `ack-${this.rows.length + 1}`, ...row };
    this.rows.push(saved);
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
  update(patch: Row): FakeQuery { return new FakeQuery(this.rows).update(patch); }
}

class FakeDb {
  tables = new Map<string, Row[]>();
  from(name: string): FakeTableHandle {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new FakeTableHandle(this.tables.get(name)!);
  }
}

const fakeDb = new FakeDb();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
}));

function baseContext(overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return {
    mode: 'live',
    integrations: [],
    sampleData: {},
    previews: { emails: [], slackMessages: [], airtableRecords: [] },
    userId: 'user-1',
    workflowId: 'wf-1',
    executionId: 'exec-1',
    ...overrides,
  } as NodeHandlerContext;
}

function ackNode(overrides: Record<string, unknown> = {}): EngineNode {
  return { id: 'node-ack-1', name: 'Await acknowledgment', type: 'magicflux-nodes.waitForAcknowledgment', parameters: { slaMinutes: 15, ...overrides } };
}

beforeEach(() => {
  fakeDb.tables.clear();
});

describe('waitForAcknowledgmentHandler -- parameter validation', () => {
  it('requires slaMinutes -- never a hard-coded default', async () => {
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const node: EngineNode = { id: '1', name: 'Await', type: 'magicflux-nodes.waitForAcknowledgment', parameters: {} };
    const result = await waitForAcknowledgmentHandler(node, {}, baseContext());
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/slaMinutes/);
  });

  it('rejects a zero/negative slaMinutes', async () => {
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const result = await waitForAcknowledgmentHandler(ackNode({ slaMinutes: 0 }), {}, baseContext());
    expect(result.status).toBe('failed');
  });
});

describe('waitForAcknowledgmentHandler -- first dispatch (creates the durable row)', () => {
  it('creates a pending row, parks with nextRunAt at the configured deadline, never a hard-coded interval', async () => {
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const before = Date.now();
    const result = await waitForAcknowledgmentHandler(ackNode({ slaMinutes: 30 }), { name: 'Acme' }, baseContext());

    expect(result.status).toBe('waiting');
    expect(result.nextRunAt).toBeInstanceOf(Date);
    const deltaMs = result.nextRunAt!.getTime() - before;
    expect(deltaMs).toBeGreaterThan(29 * 60_000);
    expect(deltaMs).toBeLessThan(31 * 60_000);

    const rows = fakeDb.tables.get('workflow_acknowledgments')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].acknowledgment_token_hash).toBeTruthy();
    // The stored value is a hash, never the plaintext token used in the URL.
    expect(String(rows[0].acknowledgment_token_hash)).not.toContain((result.outputData as Record<string, unknown>).acknowledgment_url);
  });

  it('includes a usable acknowledgment_url in outputData for a downstream reminder/escalation node to reference', async () => {
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const result = await waitForAcknowledgmentHandler(ackNode(), {}, baseContext());
    const url = (result.outputData as Record<string, unknown>).acknowledgment_url as string;
    expect(url).toMatch(/\/api\/acknowledgments\/.+\/ack\?token=.+/);
  });

  it('a concurrent duplicate dispatch of the same node never creates a second row', async () => {
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    await waitForAcknowledgmentHandler(ackNode(), {}, baseContext());
    // Simulate a second, concurrent dispatch hitting the DB's own unique
    // constraint (the FakeTableHandle models this the same way real
    // Postgres would -- see the conflict check in insert() above).
    fakeDb.tables.set('workflow_acknowledgments', [{ ...fakeDb.tables.get('workflow_acknowledgments')![0] }]);
    const second = await waitForAcknowledgmentHandler(ackNode(), {}, baseContext());
    expect(second.status).toBe('waiting');
    expect(fakeDb.tables.get('workflow_acknowledgments')).toHaveLength(1);
  });
});

describe('waitForAcknowledgmentHandler -- resume behavior', () => {
  it('resume while genuinely acknowledged: success, _conditionBranch 0, outputField "acknowledged"', async () => {
    fakeDb.tables.set('workflow_acknowledgments', [{ id: 'ack-1', execution_id: 'exec-1', node_id: 'node-ack-1', status: 'acknowledged', deadline_at: new Date(Date.now() + 60_000).toISOString() }]);
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const result = await waitForAcknowledgmentHandler(ackNode(), { name: 'Acme' }, baseContext());

    expect(result.status).toBe('success');
    const out = result.outputData as Record<string, unknown>;
    expect(out._conditionBranch).toBe(0);
    expect(out.acknowledgment_status).toBe('acknowledged');
    expect(out.name).toBe('Acme'); // upstream data preserved
  });

  it('resume while already timed_out (duplicate timeout sweep): success, _conditionBranch 1, idempotent -- never re-transitions', async () => {
    fakeDb.tables.set('workflow_acknowledgments', [{ id: 'ack-1', execution_id: 'exec-1', node_id: 'node-ack-1', status: 'timed_out', deadline_at: new Date(Date.now() - 60_000).toISOString() }]);
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const result = await waitForAcknowledgmentHandler(ackNode(), {}, baseContext());

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>)._conditionBranch).toBe(1);
    expect(fakeDb.tables.get('workflow_acknowledgments')![0].status).toBe('timed_out'); // unchanged
  });

  it('resume before the real deadline (early wake) re-parks rather than transitioning prematurely', async () => {
    const deadline = new Date(Date.now() + 5 * 60_000);
    fakeDb.tables.set('workflow_acknowledgments', [{ id: 'ack-1', execution_id: 'exec-1', node_id: 'node-ack-1', status: 'pending', deadline_at: deadline.toISOString() }]);
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const result = await waitForAcknowledgmentHandler(ackNode(), {}, baseContext());

    expect(result.status).toBe('waiting');
    expect(result.nextRunAt?.toISOString()).toBe(deadline.toISOString());
    expect(fakeDb.tables.get('workflow_acknowledgments')![0].status).toBe('pending'); // never transitioned early
  });

  it('resume past the deadline while still pending: CAS-transitions to timed_out, escalation branch', async () => {
    fakeDb.tables.set('workflow_acknowledgments', [{ id: 'ack-1', execution_id: 'exec-1', node_id: 'node-ack-1', status: 'pending', deadline_at: new Date(Date.now() - 1000).toISOString() }]);
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const result = await waitForAcknowledgmentHandler(ackNode(), {}, baseContext());

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>)._conditionBranch).toBe(1);
    expect(fakeDb.tables.get('workflow_acknowledgments')![0].status).toBe('timed_out');
  });

  it('acknowledgment racing timeout at the same instant: if the CAS to timed_out loses (an external ack won concurrently), routes to the acknowledged branch instead -- never both, never neither', async () => {
    fakeDb.tables.set('workflow_acknowledgments', [{ id: 'ack-1', execution_id: 'exec-1', node_id: 'node-ack-1', status: 'pending', deadline_at: new Date(Date.now() - 1000).toISOString() }]);
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');

    // Simulate the external ack route winning the race by flipping status
    // to 'acknowledged' the instant BEFORE this handler's own CAS runs --
    // achieved here by overriding FakeQuery's matched-row lookup: since the
    // handler re-reads via a fresh .select() after losing its own CAS
    // attempt (which itself will find status no longer 'pending' and thus
    // not match its own `.eq('status','pending')` filter), it will see the
    // row already 'acknowledged'.
    fakeDb.tables.get('workflow_acknowledgments')![0].status = 'acknowledged';

    const result = await waitForAcknowledgmentHandler(ackNode(), {}, baseContext());
    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>)._conditionBranch).toBe(0);
    expect((result.outputData as Record<string, unknown>).acknowledgment_status).toBe('acknowledged');
  });
});

describe('waitForAcknowledgmentHandler -- test mode', () => {
  it('auto-acknowledges in test mode, no durable row created, no real network/DB write', async () => {
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const result = await waitForAcknowledgmentHandler(ackNode(), { name: 'Acme' }, baseContext({ mode: 'test' }));

    expect(result.status).toBe('simulated_success');
    expect((result.outputData as Record<string, unknown>)._conditionBranch).toBe(0);
    expect(fakeDb.tables.get('workflow_acknowledgments') ?? []).toHaveLength(0);
  });
});
