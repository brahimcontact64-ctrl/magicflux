/**
 * Phase 9.9.11A -- Part 10: durable side-effect ledger, wired into the
 * REAL NodeRunner (runtime/node-runner.ts), not just the ledger helpers in
 * isolation (see tests/side-effect-ledger.test.ts for those).
 *
 * dispatchNode() (the actual provider call) is mocked so each test can
 * deterministically simulate: a real success, a definite provider
 * rejection, a network-ambiguous (indeterminate) outcome, and -- critically
 * -- a process CRASH by simply never completing a second NodeRunner.run()
 * invocation's claim the way the first one would have. RuntimeStateStore's
 * own persistence is stubbed (already proven correct elsewhere); only
 * lib/runtime/side-effect-ledger.ts's real table logic is exercised here,
 * via a faithful in-memory model of workflow_side_effects' actual CAS
 * behavior (insert-and-catch-23505, matching the applied migration).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../lib/workflow-runtime/types';
import { NodeRunner } from '../runtime/node-runner';
import { RuntimeStateStore } from '../runtime/runtime-state';
import { claimSideEffect } from '../lib/runtime/side-effect-ledger';

type Row = Record<string, unknown>;

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

class FakeSideEffectsTable {
  constructor(private rows: Row[]) {}
  insert(row: Row) {
    const conflict = this.rows.some((r) => r.execution_id === row.execution_id && r.node_id === row.node_id && r.effect_key === row.effect_key);
    if (conflict) {
      return { then: (resolve: (v: { error: { code: string; message: string } | null }) => unknown) => Promise.resolve(resolve({ error: { code: '23505', message: 'duplicate key' } })) };
    }
    this.rows.push({ id: `ledger-${this.rows.length + 1}`, updated_at: nowIso(), ...row });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
  select() {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const api = {
      eq(col: string, val: unknown) { filters.push([col, val]); return api; },
      async maybeSingle() {
        const match = rows.find((r) => filters.every(([c, v]) => r[c] === v));
        return { data: match ? { ...match } : null, error: null };
      },
    };
    return api;
  }
  update(patch: Row) {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const api = {
      eq(col: string, val: unknown) { filters.push([col, val]); return api; },
      select() { return api; },
      async maybeSingle() {
        const idx = rows.findIndex((r) => filters.every(([c, v]) => r[c] === v));
        if (idx < 0) return { data: null, error: null };
        Object.assign(rows[idx], patch);
        return { data: { ...rows[idx] }, error: null };
      },
      then(resolve: (v: { error: null }) => unknown) {
        for (const row of rows) {
          if (filters.every(([c, v]) => row[c] === v)) Object.assign(row, patch);
        }
        return Promise.resolve(resolve({ error: null }));
      },
    };
    return api;
  }
}

let ledgerRows: Row[];

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => {
      if (name === 'workflow_side_effects') return new FakeSideEffectsTable(ledgerRows);
      // Every other table this test path might touch (none should be, since
      // RuntimeStateStore's own methods are stubbed on the prototype below)
      // gets a harmless permissive stub rather than throwing.
      const chain: Record<string, unknown> = {};
      const resolved = Promise.resolve({ data: null, error: null });
      for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'in', 'limit', 'order']) chain[m] = vi.fn(() => chain);
      chain.then = resolved.then.bind(resolved);
      chain.maybeSingle = vi.fn(() => resolved);
      return { from: vi.fn(() => chain) };
    },
  })),
}));

vi.mock('@/lib/runtime/events', () => ({ emitRuntimeEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/runtime/usage-metering', () => ({ recordUsageEventSafe: vi.fn() }));

const dispatchNodeMock = vi.fn();
vi.mock('@/lib/workflow-runtime/node-handlers', () => ({
  dispatchNode: (...args: unknown[]) => dispatchNodeMock(...args),
}));

function baseContext(overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return { mode: 'live', integrations: [], sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] }, ...overrides };
}

function airtableNode(overrides: Record<string, unknown> = {}): EngineNode {
  return { id: 'node-airtable-1', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', parameters: { baseId: 'app1', tableId: 'tbl1', operation: 'create', fields: {}, ...overrides } };
}
function gmailNode(): EngineNode {
  return { id: 'node-gmail-1', name: 'Send Gmail', type: 'n8n-nodes-base.gmail', parameters: { to: 'x@example.com', subject: 'Hi', message: 'Hi' } };
}
function slackNode(): EngineNode {
  return { id: 'node-slack-1', name: 'Slack Notification', type: 'n8n-nodes-base.slack', parameters: { channel: '#leads', text: 'Hi' } };
}
function ifNode(): EngineNode {
  return { id: 'node-if-1', name: 'If Hot', type: 'n8n-nodes-base.if', parameters: {} };
}

function successResult(outputData: unknown): NodeHandlerResult {
  return { status: 'success', outputData, logs: ['ok'] };
}
function definiteFailure(): NodeHandlerResult {
  return { status: 'failed', outputData: null, logs: ['rejected'], error: 'Airtable returned 422' };
}
function indeterminateFailure(): NodeHandlerResult {
  return { status: 'failed', outputData: null, logs: ['ambiguous'], error: 'INDETERMINATE: may have already succeeded remotely', nonRetryable: true };
}

function baseInput(node: EngineNode, overrides: Record<string, unknown> = {}) {
  return {
    executionId: 'exec-1',
    workflowId: 'wf-1',
    userId: 'user-1',
    node,
    inputData: { name: 'Acme' },
    maxRetries: 2,
    mode: 'live' as const,
    handlerContext: baseContext(),
    correlationId: 'corr-1',
    ...overrides,
  };
}

beforeEach(() => {
  ledgerRows = [];
  dispatchNodeMock.mockReset();
  vi.spyOn(RuntimeStateStore.prototype, 'getExecutionControl').mockResolvedValue({ cancelRequested: false, pauseRequested: false, resumeRequested: false } as never);
  vi.spyOn(RuntimeStateStore.prototype, 'persistNodeState').mockResolvedValue(undefined as never);
});

function makeRunner(): NodeRunner {
  return new NodeRunner(new RuntimeStateStore());
}

let runner: NodeRunner;

describe('NodeRunner + side-effect ledger -- Airtable path', () => {
  it('claims, calls the provider exactly once, records succeeded', async () => {
    dispatchNodeMock.mockResolvedValueOnce(successResult({ airtable_id: 'recABC' }));
    runner = makeRunner();
    const result = await runner.run(baseInput(airtableNode()));

    expect(result.status).toBe('success');
    expect(dispatchNodeMock).toHaveBeenCalledTimes(1);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].status).toBe('succeeded');
    expect(ledgerRows[0].provider_ref).toEqual({ airtable_id: 'recABC' });
  });

  it('a completed effect encountered again (duplicate execution retry) is suppressed -- provider never called a second time', async () => {
    dispatchNodeMock.mockResolvedValueOnce(successResult({ airtable_id: 'recABC' }));
    runner = makeRunner();
    await runner.run(baseInput(airtableNode()));

    const second = await runner.run(baseInput(airtableNode()));
    expect(second.status).toBe('skipped');
    expect((second.outputData as Record<string, unknown>).duplicate_suppressed).toBe(true);
    expect((second.outputData as Record<string, unknown>).airtable_id).toBe('recABC');
    expect(dispatchNodeMock).toHaveBeenCalledTimes(1); // never called again
  });

  it('a definite provider rejection is recorded as "failed" (safe to retry later)', async () => {
    dispatchNodeMock.mockResolvedValue(definiteFailure());
    runner = makeRunner();
    const result = await runner.run(baseInput(airtableNode(), { maxRetries: 0 }));

    expect(result.status).toBe('failed');
    expect(ledgerRows[0].status).toBe('failed');
  });

  it('safe pre-provider failure and retry: a "failed" ledger row can be reclaimed and the provider retried', async () => {
    dispatchNodeMock.mockResolvedValueOnce(definiteFailure());
    runner = makeRunner();
    await runner.run(baseInput(airtableNode(), { maxRetries: 0 }));
    expect(ledgerRows[0].status).toBe('failed');

    dispatchNodeMock.mockResolvedValueOnce(successResult({ airtable_id: 'recRETRY' }));
    const second = await runner.run(baseInput(airtableNode(), { maxRetries: 0 }));
    expect(second.status).toBe('success');
    expect(ledgerRows[0].status).toBe('succeeded');
    expect(dispatchNodeMock).toHaveBeenCalledTimes(2);
  });

  it('provider timeout before known result / response lost after possible acceptance: recorded indeterminate, never retried', async () => {
    dispatchNodeMock.mockResolvedValueOnce(indeterminateFailure());
    runner = makeRunner();
    const result = await runner.run(baseInput(airtableNode(), { maxRetries: 3 }));

    expect(result.status).toBe('failed');
    expect(dispatchNodeMock).toHaveBeenCalledTimes(1); // nonRetryable -- no in-process retry either
    expect(ledgerRows[0].status).toBe('indeterminate');

    // retry/recovery after indeterminate -- a fresh invocation must NOT call the provider again.
    const retryAttempt = await runner.run(baseInput(airtableNode()));
    expect(retryAttempt.status).toBe('failed');
    expect(retryAttempt.error).toMatch(/INDETERMINATE/);
    expect(dispatchNodeMock).toHaveBeenCalledTimes(1); // still exactly once, ever
  });

  it('crash immediately before provider call: claimed row stays in_progress, provider never invoked in that attempt -- a later attempt sees it as unclaimed (fresh) and refuses to guess', async () => {
    // Simulate the crash by claiming manually (as run() would) and never recording an outcome.
    
    await claimSideEffect({ userId: 'user-1', workflowId: 'wf-1', executionId: 'exec-1', nodeId: 'node-airtable-1', effectType: 'airtable_create' });

    runner = makeRunner();
    const result = await runner.run(baseInput(airtableNode()));

    expect(dispatchNodeMock).not.toHaveBeenCalled(); // never called -- the ledger already shows an unresolved in_progress claim
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/concurrent attempt|INDETERMINATE/);
  });

  it('crash immediately after provider call but before ledger success persistence: a stale in_progress row is treated as indeterminate on the next attempt, never assumed succeeded or failed', async () => {
    
    await claimSideEffect({ userId: 'user-1', workflowId: 'wf-1', executionId: 'exec-1', nodeId: 'node-airtable-1', effectType: 'airtable_create' });
    // Simulate staleness: back-date the claimed row's updated_at past the lease window.
    ledgerRows[0].updated_at = nowIso(-10 * 60_000);

    runner = makeRunner();
    const result = await runner.run(baseInput(airtableNode()));

    expect(dispatchNodeMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/INDETERMINATE/);
    expect(result.error).toMatch(/crashed mid-flight|cannot prove/);
  });

  it('crash after ledger success persistence: fully recovered as duplicate_suppressed on any later attempt', async () => {
    dispatchNodeMock.mockResolvedValueOnce(successResult({ airtable_id: 'recDONE' }));
    runner = makeRunner();
    await runner.run(baseInput(airtableNode()));

    // A "new process" retrying the exact same node in the exact same execution.
    const recovered = await runner.run(baseInput(airtableNode()));
    expect(recovered.status).toBe('skipped');
    expect((recovered.outputData as Record<string, unknown>).duplicate_suppressed).toBe(true);
    expect(dispatchNodeMock).toHaveBeenCalledTimes(1);
  });

  it('stale in_progress does not block a DIFFERENT node in the same execution', async () => {
    
    await claimSideEffect({ userId: 'user-1', workflowId: 'wf-1', executionId: 'exec-1', nodeId: 'node-airtable-1', effectType: 'airtable_create' });
    ledgerRows[0].updated_at = nowIso(-10 * 60_000);

    dispatchNodeMock.mockResolvedValueOnce(successResult({ ts: '123.456' }));
    runner = makeRunner();
    const result = await runner.run(baseInput(slackNode()));

    expect(result.status).toBe('success');
    expect(dispatchNodeMock).toHaveBeenCalledTimes(1);
  });
});

describe('NodeRunner + side-effect ledger -- Gmail path', () => {
  it('claims, sends, records succeeded with messageId', async () => {
    dispatchNodeMock.mockResolvedValueOnce(successResult({ messageId: 'msg-123' }));
    runner = makeRunner();
    const result = await runner.run(baseInput(gmailNode()));

    expect(result.status).toBe('success');
    expect(ledgerRows[0].status).toBe('succeeded');
    expect(ledgerRows[0].provider_ref).toEqual({ messageId: 'msg-123' });
  });

  it('a completed Gmail send encountered again is suppressed', async () => {
    dispatchNodeMock.mockResolvedValueOnce(successResult({ messageId: 'msg-123' }));
    runner = makeRunner();
    await runner.run(baseInput(gmailNode()));
    const again = await runner.run(baseInput(gmailNode()));

    expect(again.status).toBe('skipped');
    expect(dispatchNodeMock).toHaveBeenCalledTimes(1);
  });

  it('an indeterminate Gmail outcome (timeout) is never auto-retried', async () => {
    dispatchNodeMock.mockResolvedValueOnce(indeterminateFailure());
    runner = makeRunner();
    await runner.run(baseInput(gmailNode()));
    const retry = await runner.run(baseInput(gmailNode()));

    expect(retry.error).toMatch(/INDETERMINATE/);
    expect(dispatchNodeMock).toHaveBeenCalledTimes(1);
  });
});

describe('NodeRunner + side-effect ledger -- Slack path', () => {
  it('claims, posts, records succeeded with ts', async () => {
    dispatchNodeMock.mockResolvedValueOnce(successResult({ ts: '123.456', slack_delivered: true }));
    runner = makeRunner();
    const result = await runner.run(baseInput(slackNode()));

    expect(result.status).toBe('success');
    expect(ledgerRows[0].provider_ref).toEqual({ ts: '123.456' });
  });

  it('a completed Slack post encountered again is suppressed', async () => {
    dispatchNodeMock.mockResolvedValueOnce(successResult({ ts: '123.456' }));
    runner = makeRunner();
    await runner.run(baseInput(slackNode()));
    const again = await runner.run(baseInput(slackNode()));

    expect(again.status).toBe('skipped');
    expect(dispatchNodeMock).toHaveBeenCalledTimes(1);
  });
});

describe('NodeRunner -- non-side-effect node types are completely unaffected', () => {
  it('an IF node never touches the ledger at all', async () => {
    dispatchNodeMock.mockResolvedValueOnce({ status: 'success', outputData: { ok: true }, logs: [] });
    runner = makeRunner();
    const result = await runner.run(baseInput(ifNode()));

    expect(result.status).toBe('success');
    expect(ledgerRows).toHaveLength(0);
  });

  it('a read-only Airtable "list" operation is never ledger-gated (safe to repeat)', async () => {
    dispatchNodeMock.mockResolvedValue({ status: 'success', outputData: { airtable_records: [] }, logs: [] });
    runner = makeRunner();
    await runner.run(baseInput(airtableNode({ operation: 'list' })));
    await runner.run(baseInput(airtableNode({ operation: 'list' })));

    expect(ledgerRows).toHaveLength(0);
    expect(dispatchNodeMock).toHaveBeenCalledTimes(2); // always allowed to repeat
  });
});

describe('concurrency and isolation (Part 10)', () => {
  it('concurrent claims for the same effect: only one calls the provider', async () => {
    dispatchNodeMock.mockImplementation(async () => successResult({ airtable_id: 'recX' }));
    runner = makeRunner();
    const [a, b] = await Promise.all([
      runner.run(baseInput(airtableNode())),
      runner.run(baseInput(airtableNode())),
    ]);

    const succeeded = [a, b].filter((r) => r.status === 'success');
    const blocked = [a, b].filter((r) => r.status === 'failed');
    expect(succeeded).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(dispatchNodeMock).toHaveBeenCalledTimes(1);
  });

  it('different nodes in the same execution remain independent', async () => {
    dispatchNodeMock.mockResolvedValueOnce(successResult({ airtable_id: 'recA' }));
    dispatchNodeMock.mockResolvedValueOnce(successResult({ ts: '1.1' }));
    runner = makeRunner();
    const a = await runner.run(baseInput(airtableNode()));
    const b = await runner.run(baseInput(slackNode()));

    expect(a.status).toBe('success');
    expect(b.status).toBe('success');
    expect(ledgerRows).toHaveLength(2);
  });

  it('different executions remain completely independent', async () => {
    dispatchNodeMock.mockResolvedValueOnce(successResult({ airtable_id: 'recA' }));
    dispatchNodeMock.mockResolvedValueOnce(successResult({ airtable_id: 'recB' }));
    runner = makeRunner();
    const a = await runner.run(baseInput(airtableNode(), { executionId: 'exec-A' }));
    const b = await runner.run(baseInput(airtableNode(), { executionId: 'exec-B' }));

    expect(a.status).toBe('success');
    expect(b.status).toBe('success');
    expect(dispatchNodeMock).toHaveBeenCalledTimes(2);
  });

  it('cross-tenant collision attempt: the same node_id under a different user/workflow/execution never collides or is suppressed', async () => {
    dispatchNodeMock.mockResolvedValueOnce(successResult({ airtable_id: 'recA' }));
    dispatchNodeMock.mockResolvedValueOnce(successResult({ airtable_id: 'recB' }));
    runner = makeRunner();
    const a = await runner.run(baseInput(airtableNode(), { userId: 'user-A', workflowId: 'wf-A', executionId: 'exec-A' }));
    const b = await runner.run(baseInput(airtableNode(), { userId: 'user-B', workflowId: 'wf-B', executionId: 'exec-B' }));

    expect(a.status).toBe('success');
    expect(b.status).toBe('success'); // NOT suppressed as a duplicate of user A's effect
    expect(dispatchNodeMock).toHaveBeenCalledTimes(2);
  });
});
