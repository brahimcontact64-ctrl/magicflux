/**
 * Regression coverage for RuntimeStateStore.persistNodeState()
 * (runtime/runtime-state.ts).
 *
 * Root-cause bug: persistNodeState() upserts into runtime_node_states with
 * onConflict: 'execution_id,node_id,user_id', but production had no unique
 * constraint matching that target until migration
 * 20260612000001_repair_runtime_node_states_duplicates.sql +
 * 20260523000001_runtime_multitenant_hardening.sql. Every upsert failed with
 * Postgres 42P10, silently, because the Supabase client's .error was never
 * checked. Fixed by checking .error on both the runtime_node_states upsert
 * and the workflow_execution_steps insert, logging explicitly, and throwing
 * RuntimeNodeStatePersistenceError instead of returning normally.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

class FakeNodeStatesTable {
  constructor(private rows: Row[], private forcedError: { message: string; code: string } | null) {}

  upsert(row: Row, opts?: { onConflict?: string }) {
    if (this.forcedError) {
      return { then: (resolve: (v: { error: { message: string; code: string } }) => unknown) => Promise.resolve(resolve({ error: this.forcedError! })) };
    }
    const conflictCols = (opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const idx = conflictCols.length
      ? this.rows.findIndex((r) => conflictCols.every((c) => r[c] === row[c]))
      : -1;
    if (idx >= 0) {
      this.rows[idx] = { ...this.rows[idx], ...row };
    } else {
      this.rows.push({ id: `node-state-${this.rows.length}`, ...row });
    }
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
}

class FakeStepsTable {
  constructor(private rows: Row[], private forcedError: { message: string; code: string } | null) {}

  insert(row: Row) {
    if (this.forcedError) {
      return { then: (resolve: (v: { error: { message: string; code: string } }) => unknown) => Promise.resolve(resolve({ error: this.forcedError! })) };
    }
    this.rows.push({ id: `step-${this.rows.length}`, ...row });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
}

let nodeStateRows: Row[];
let stepRows: Row[];
let forcedNodeStateError: { message: string; code: string } | null;
let forcedStepError: { message: string; code: string } | null;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => {
      if (name === 'runtime_node_states') return new FakeNodeStatesTable(nodeStateRows, forcedNodeStateError);
      if (name === 'workflow_execution_steps') return new FakeStepsTable(stepRows, forcedStepError);
      throw new Error(`unexpected table ${name}`);
    },
  })),
}));

vi.mock('@/lib/runtime/events', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/runtime/usage-metering', () => ({ recordUsageEvent: vi.fn(async () => undefined) }));

const loggerErrorSpy = vi.fn();
vi.mock('@/lib/runtime/logger', () => ({
  logger: { error: (...args: unknown[]) => loggerErrorSpy(...args), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const baseInput = {
  executionId: 'exec-1',
  workflowId: 'wf-1',
  userId: 'user-1',
  nodeId: 'n1',
  nodeName: 'Webhook Trigger',
  nodeType: 'n8n-nodes-base.webhook',
  attempt: 1,
};

beforeEach(() => {
  nodeStateRows = [];
  stepRows = [];
  forcedNodeStateError = null;
  forcedStepError = null;
  loggerErrorSpy.mockClear();
});

describe('persistNodeState', () => {
  it('first insert succeeds: creates one runtime_node_states row and one workflow_execution_steps row', async () => {
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();

    await store.persistNodeState({ ...baseInput, status: 'queued', logs: ['queued'] });

    expect(nodeStateRows).toHaveLength(1);
    expect(nodeStateRows[0].status).toBe('queued');
    expect(stepRows).toHaveLength(1);
  });

  it('second status transition updates the same row (not a second row)', async () => {
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();

    await store.persistNodeState({ ...baseInput, status: 'queued', logs: ['queued'] });
    await store.persistNodeState({ ...baseInput, status: 'running', logs: ['running'] });
    await store.persistNodeState({ ...baseInput, status: 'success', logs: ['success'], outputData: { ok: true } });

    expect(nodeStateRows).toHaveLength(1);
    expect(nodeStateRows[0].status).toBe('success');
    // workflow_execution_steps is append-only: every call adds a new row.
    expect(stepRows).toHaveLength(3);
  });

  it('a retry attempt updates the same authoritative row (not a new one)', async () => {
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();

    await store.persistNodeState({ ...baseInput, status: 'queued', attempt: 1, logs: ['queued'] });
    await store.persistNodeState({ ...baseInput, status: 'retrying', attempt: 1, logs: ['retrying'] });
    await store.persistNodeState({ ...baseInput, status: 'running', attempt: 2, logs: ['retry running'] });

    expect(nodeStateRows).toHaveLength(1);
    expect(nodeStateRows[0].attempt).toBe(2);
    expect(nodeStateRows[0].status).toBe('running');
  });

  it('does not silently swallow a runtime_node_states persistence error (e.g. 42P10)', async () => {
    forcedNodeStateError = { message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification', code: '42P10' };
    const { RuntimeStateStore, RuntimeNodeStatePersistenceError } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();

    await expect(store.persistNodeState({ ...baseInput, status: 'queued', logs: ['queued'] }))
      .rejects.toBeInstanceOf(RuntimeNodeStatePersistenceError);

    // Must not have silently proceeded to insert into workflow_execution_steps either.
    expect(stepRows).toHaveLength(0);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'runtime_node_states.persist_failed',
      expect.objectContaining({ execution_id: 'exec-1', node_id: 'n1', code: '42P10' }),
    );
  });

  it('does not silently swallow a workflow_execution_steps persistence error', async () => {
    forcedStepError = { message: 'insert failed', code: '23505' };
    const { RuntimeStateStore, RuntimeNodeStatePersistenceError } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();

    await expect(store.persistNodeState({ ...baseInput, status: 'queued', logs: ['queued'] }))
      .rejects.toBeInstanceOf(RuntimeNodeStatePersistenceError);

    // The node-state upsert itself succeeded before the step insert failed.
    expect(nodeStateRows).toHaveLength(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'workflow_execution_steps.persist_failed',
      expect.objectContaining({ execution_id: 'exec-1', node_id: 'n1', code: '23505' }),
    );
  });
});
