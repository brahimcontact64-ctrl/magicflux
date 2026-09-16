/**
 * Phase 9.9.12A -- Part I: magicflux-nodes.createAcknowledgmentChallenge
 * (lib/workflow-runtime/node-handlers/create-acknowledgment-challenge.ts)
 * and the two-node split mode it enables in
 * magicflux-nodes.waitForAcknowledgment.
 *
 * Proves the chicken-and-egg fix directly: a challenge created BEFORE
 * notification nodes run produces a real acknowledgment_url immediately
 * (never pausing), and a LATER waitForAcknowledgment node referencing that
 * same challenge id waits on the identical row rather than creating a
 * second, orphaned one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EngineNode, NodeHandlerContext } from '../lib/workflow-runtime/types';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => { if (this.filters.every(([c, v]) => r[c] === v)) idx.push(i); });
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
    mode: 'live', integrations: [], sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] },
    userId: 'user-1', workflowId: 'wf-1', executionId: 'exec-1', ...overrides,
  } as NodeHandlerContext;
}

function challengeNode(overrides: Record<string, unknown> = {}): EngineNode {
  return { id: 'node-challenge-1', name: 'Create Acknowledgment Challenge', type: 'magicflux-nodes.createAcknowledgmentChallenge', parameters: { slaMinutes: 15, ...overrides } };
}
function waitNodeReferencing(overrides: Record<string, unknown> = {}): EngineNode {
  return { id: 'node-wait-1', name: 'Await acknowledgment', type: 'magicflux-nodes.waitForAcknowledgment', parameters: { slaMinutes: 15, ...overrides } };
}

beforeEach(() => {
  fakeDb.tables.clear();
});

describe('createAcknowledgmentChallengeHandler', () => {
  it('requires slaMinutes', async () => {
    const { createAcknowledgmentChallengeHandler } = await import('../lib/workflow-runtime/node-handlers/create-acknowledgment-challenge');
    const result = await createAcknowledgmentChallengeHandler({ id: '1', name: 'x', type: 'magicflux-nodes.createAcknowledgmentChallenge', parameters: {} }, {}, baseContext());
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/slaMinutes/);
  });

  it('NEVER pauses -- always returns success immediately, creates the row, and outputs a real acknowledgment_url', async () => {
    const { createAcknowledgmentChallengeHandler } = await import('../lib/workflow-runtime/node-handlers/create-acknowledgment-challenge');
    const result = await createAcknowledgmentChallengeHandler(challengeNode(), { name: 'Acme' }, baseContext());

    expect(result.status).toBe('success'); // never 'waiting' -- this is the whole point (Part I)
    const out = result.outputData as Record<string, unknown>;
    expect(out.acknowledgment_url).toMatch(/\/api\/acknowledgments\/.+\/ack\?token=.+/);
    expect(out.acknowledgment_challenge_id).toBeTruthy();
    expect(out.name).toBe('Acme'); // upstream data preserved

    const rows = fakeDb.tables.get('workflow_acknowledgments')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].deadline_at).toBeTruthy(); // SLA clock started at creation, not later
  });

  it('respects a custom outputIdField', async () => {
    const { createAcknowledgmentChallengeHandler } = await import('../lib/workflow-runtime/node-handlers/create-acknowledgment-challenge');
    const result = await createAcknowledgmentChallengeHandler(challengeNode({ outputIdField: 'my_challenge_id' }), {}, baseContext());
    const out = result.outputData as Record<string, unknown>;
    expect(out.my_challenge_id).toBeTruthy();
    expect(out.acknowledgment_challenge_id).toBeUndefined();
  });

  it('test mode: simulated, no durable row, never pauses', async () => {
    const { createAcknowledgmentChallengeHandler } = await import('../lib/workflow-runtime/node-handlers/create-acknowledgment-challenge');
    const result = await createAcknowledgmentChallengeHandler(challengeNode(), {}, baseContext({ mode: 'test' }));
    expect(result.status).toBe('simulated_success');
    expect(fakeDb.tables.get('workflow_acknowledgments') ?? []).toHaveLength(0);
  });
});

describe('waitForAcknowledgmentHandler -- two-node split mode (Part I)', () => {
  it('waits on the SAME row a prior createAcknowledgmentChallenge created, never creating a second one', async () => {
    const { createAcknowledgmentChallengeHandler } = await import('../lib/workflow-runtime/node-handlers/create-acknowledgment-challenge');
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');

    const created = await createAcknowledgmentChallengeHandler(challengeNode(), { name: 'Acme' }, baseContext());
    const dataFlowingThrough = created.outputData as Record<string, unknown>; // simulates Gmail/Slack passing data through unchanged

    const waitResult = await waitForAcknowledgmentHandler(waitNodeReferencing(), dataFlowingThrough, baseContext());

    expect(waitResult.status).toBe('waiting');
    expect(fakeDb.tables.get('workflow_acknowledgments')).toHaveLength(1); // still exactly one row -- the wait node never created its own
    expect(fakeDb.tables.get('workflow_acknowledgments')![0].node_id).toBe('node-challenge-1'); // owned by the CREATE node's identity
  });

  it('the deadline is the one fixed at CREATION time, not extended by when the wait node happens to run', async () => {
    const { createAcknowledgmentChallengeHandler } = await import('../lib/workflow-runtime/node-handlers/create-acknowledgment-challenge');
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');

    const created = await createAcknowledgmentChallengeHandler(challengeNode({ slaMinutes: 15 }), {}, baseContext());
    const createdDeadline = fakeDb.tables.get('workflow_acknowledgments')![0].deadline_at;

    const waitResult = await waitForAcknowledgmentHandler(waitNodeReferencing(), created.outputData, baseContext());
    expect(waitResult.nextRunAt?.toISOString()).toBe(createdDeadline);
  });

  it('resolves correctly through the two-node path once acknowledged (external CAS)', async () => {
    const { createAcknowledgmentChallengeHandler } = await import('../lib/workflow-runtime/node-handlers/create-acknowledgment-challenge');
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');

    const created = await createAcknowledgmentChallengeHandler(challengeNode(), {}, baseContext());
    fakeDb.tables.get('workflow_acknowledgments')![0].status = 'acknowledged';

    const waitResult = await waitForAcknowledgmentHandler(waitNodeReferencing(), created.outputData, baseContext());
    expect(waitResult.status).toBe('success');
    expect((waitResult.outputData as Record<string, unknown>)._conditionBranch).toBe(0);
  });

  it('fails closed with a clear error if the referenced challenge id does not exist -- never silently creates an orphaned row', async () => {
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const result = await waitForAcknowledgmentHandler(waitNodeReferencing(), { acknowledgment_challenge_id: 'nonexistent-id' }, baseContext());

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no acknowledgment challenge found/i);
    expect(fakeDb.tables.get('workflow_acknowledgments') ?? []).toHaveLength(0);
  });

  it('a challenge id from a DIFFERENT execution/tenant is never usable -- scoped by execution_id AND user_id', async () => {
    const { createAcknowledgmentChallengeHandler } = await import('../lib/workflow-runtime/node-handlers/create-acknowledgment-challenge');
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');

    const created = await createAcknowledgmentChallengeHandler(challengeNode(), {}, baseContext({ userId: 'user-A', executionId: 'exec-A' }));
    const result = await waitForAcknowledgmentHandler(
      waitNodeReferencing(),
      created.outputData,
      baseContext({ userId: 'user-B', executionId: 'exec-B' }), // different tenant AND execution
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no acknowledgment challenge found/i);
  });

  it('when no challenge id is present in the data, falls back to the original self-contained behavior unchanged', async () => {
    const { waitForAcknowledgmentHandler } = await import('../lib/workflow-runtime/node-handlers/wait-for-acknowledgment');
    const result = await waitForAcknowledgmentHandler(waitNodeReferencing(), { name: 'Acme' }, baseContext());

    expect(result.status).toBe('waiting');
    expect(fakeDb.tables.get('workflow_acknowledgments')).toHaveLength(1);
    expect(fakeDb.tables.get('workflow_acknowledgments')![0].node_id).toBe('node-wait-1'); // owns its own row, as before
  });
});
