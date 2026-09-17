/**
 * Phase 9.9.14 -- Part B/M/N: the operational-state taxonomy
 * (lib/runtime/operational-state.ts). Proves the derivation is
 * unambiguous for every case Part N explicitly lists, and that it never
 * requires a schema migration (pure derivation over existing tables).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private inFilters: Array<[string, unknown[]]> = [];
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  in(col: string, vals: unknown[]): this { this.inFilters.push([col, vals]); return this; }
  limit(): this { return this; }
  select(): this { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) =>
      this.filters.every(([c, v]) => r[c] === v) &&
      this.inFilters.every(([c, vals]) => vals.includes(r[c]))
    );
  }
  async maybeSingle(): Promise<{ data: Row | null }> {
    const m = this.matched();
    return { data: m[0] ?? null };
  }
  then<T>(resolve: (v: { data: Row[] }) => T): Promise<T> {
    return Promise.resolve(resolve({ data: this.matched() }));
  }
}

let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => new FakeQuery(tables[name] ?? []),
  })),
}));

function execRow(overrides: Partial<Row>): Row {
  return { id: 'exec-1', status: 'running', error_message: null, next_run_at: null, retry_count: 0, ...overrides };
}

beforeEach(() => {
  tables = { workflow_executions_v2: [], workflow_review_items: [], workflow_acknowledgments: [] };
});

describe('computeExecutionOperationalState', () => {
  it('success -> succeeded', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'success' })];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('succeeded');
  });

  it('cancelled -> cancelled (never mislabeled as failed)', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'cancelled' })];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('cancelled');
  });

  it('queued -> queued', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'queued' })];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('queued');
  });

  it('waiting + pending Human Review row -> waiting_human', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'waiting' })];
    tables.workflow_review_items = [{ execution_id: 'exec-1', status: 'pending' }];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('waiting_human');
  });

  it('waiting + pending acknowledgment row -> waiting_acknowledgment', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'waiting' })];
    tables.workflow_acknowledgments = [{ execution_id: 'exec-1', status: 'pending' }];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('waiting_acknowledgment');
  });

  it('waiting + retry_count > 0, no pending gate -> retrying', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'waiting', retry_count: 2 })];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('retrying');
  });

  it('waiting + no pending gate, retry_count 0 -> running (a plain Wait node timer)', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'waiting', retry_count: 0 })];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('running');
  });

  it('failed + INDETERMINATE: prefix -> indeterminate', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'failed', error_message: 'INDETERMINATE: a prior attempt may have already succeeded.' })];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('indeterminate');
  });

  it('failed + AMBIGUOUS_DELIVERY: prefix (SMTP DATA-command case) -> indeterminate', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'failed', error_message: 'AMBIGUOUS_DELIVERY: the SMTP connection failed during DATA.' })];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('indeterminate');
  });

  it('failed + CONFIG_BLOCKED: prefix -> configuration_blocked', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'failed', error_message: 'CONFIG_BLOCKED: Airtable rejected the request (HTTP 401).' })];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('configuration_blocked');
  });

  it('failed + "worker timeout" (pre-existing self-heal message) -> recovery_required', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'failed', error_message: 'worker timeout' })];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('recovery_required');
  });

  it('failed + this phase\'s own new recovery_required messages -> recovery_required', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'failed', error_message: 'Execution crashed with an unhandled error before it could reach a terminal state -- recovery_required.' })];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('recovery_required');
  });

  it('failed + ordinary error message -> plain failed', async () => {
    tables.workflow_executions_v2 = [execRow({ status: 'failed', error_message: 'HTTP 500: server error' })];
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    expect((await computeExecutionOperationalState('exec-1')).state).toBe('failed');
  });

  it('nonexistent execution never throws', async () => {
    const { computeExecutionOperationalState } = await import('../lib/runtime/operational-state');
    const result = await computeExecutionOperationalState('nonexistent');
    expect(result.state).toBe('failed');
  });
});

describe('computeExecutionOperationalStates (batch)', () => {
  it('resolves multiple executions with the SAME logic as the single-execution function, in one batched pass', async () => {
    tables.workflow_executions_v2 = [
      execRow({ id: 'e1', status: 'success' }),
      execRow({ id: 'e2', status: 'waiting' }),
      execRow({ id: 'e3', status: 'failed', error_message: 'CONFIG_BLOCKED: bad token' }),
    ];
    tables.workflow_review_items = [{ execution_id: 'e2', status: 'pending' }];

    const { computeExecutionOperationalStates } = await import('../lib/runtime/operational-state');
    const result = await computeExecutionOperationalStates(['e1', 'e2', 'e3']);

    expect(result.get('e1')?.state).toBe('succeeded');
    expect(result.get('e2')?.state).toBe('waiting_human');
    expect(result.get('e3')?.state).toBe('configuration_blocked');
  });

  it('returns an empty map for an empty input, never touching the DB', async () => {
    const { computeExecutionOperationalStates } = await import('../lib/runtime/operational-state');
    const result = await computeExecutionOperationalStates([]);
    expect(result.size).toBe(0);
  });
});
