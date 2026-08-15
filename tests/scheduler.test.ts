/**
 * Phase 8 — Scheduler/cron engine (lib/runtime/scheduler.ts).
 *
 * Genuinely new: confirmed by architecture audit that no cron/schedule
 * engine existed anywhere in the codebase before this — scheduleTriggerNode
 * was a UI-only node with nothing ever firing it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000e1';
const USER_B = '00000000-0000-4000-8000-0000000000e2';

// ─── Fake Supabase client (same generic shape used throughout Phase 7/7.5/8 tests) ───

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private limitN: number | null = null;
  constructor(private rows: Row[], private op: 'select' | 'delete' = 'select') {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  lte(col: string, val: unknown): this { this.filters.push([`__lte__${col}`, val]); return this; }
  select(_cols?: string): this { return this; }
  limit(n: number): this { this.limitN = n; return this; }
  private matches(row: Row): boolean {
    return this.filters.every(([col, val]) => {
      if (col.startsWith('__lte__')) {
        const realCol = col.slice('__lte__'.length);
        const rowVal = row[realCol];
        return rowVal != null && String(rowVal) <= String(val);
      }
      return row[col] === val;
    });
  }
  private matched(): Row[] {
    let result = this.rows.filter((r) => this.matches(r));
    if (this.limitN !== null) result = result.slice(0, this.limitN);
    // Snapshot copies, not live references — a real Postgres SELECT returns
    // values as of query time; it does not hand back a live view into the
    // table that later mutates out from under the caller. Returning live
    // references here previously let one simulated racer "see" another
    // racer's in-flight mutation through a value it had already read,
    // silently defeating the CAS race this mock exists to test.
    return result.map((r) => ({ ...r }));
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.op === 'delete') {
      for (let i = this.rows.length - 1; i >= 0; i--) if (this.matches(this.rows[i])) this.rows.splice(i, 1);
      return { data: null, error: null };
    }
    const m = this.matched();
    return { data: m[0] ?? null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    if (this.op === 'delete') {
      const kept = this.rows.filter((r) => !this.matches(r));
      this.rows.length = 0; this.rows.push(...kept);
      return Promise.resolve(resolve({ data: [], error: null }));
    }
    return Promise.resolve(resolve({ data: this.matched(), error: null }));
  }
}

class FakeTableHandle {
  constructor(private rows: Row[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows, 'select'); }
  delete(): FakeQuery { return new FakeQuery(this.rows, 'delete'); }
  insert(row: Row): FakeQuery {
    const withId = { id: row.id ?? `fake-${this.rows.length}-${Math.random().toString(36).slice(2)}`, ...row };
    this.rows.push(withId);
    return new FakeQuery([withId], 'select');
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }): { then: (resolve: (v: { error: null }) => unknown) => Promise<unknown> } {
    const incoming = Array.isArray(rows) ? rows : [rows];
    const conflictCols = (opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const row of incoming) {
      const idx = conflictCols.length ? this.rows.findIndex((r) => conflictCols.every((c) => r[c] === row[c])) : -1;
      if (idx >= 0) this.rows[idx] = { ...this.rows[idx], ...row };
      else this.rows.push({ id: row.id ?? `fake-${this.rows.length}`, ...row });
    }
    return { then: (resolve) => Promise.resolve(resolve({ error: null })) };
  }
  update(patch: Row): FakeQuery {
    const q = new FakeQuery(this.rows, 'select');
    const rows = this.rows;
    // Emulates a real Supabase .update(patch).eq(...).eq(...) call: applies
    // `patch` to every row matching the accumulated filters at the moment
    // the call actually resolves (.then() or .maybeSingle()), not when
    // .update() is first invoked — this is what makes the CAS claim in
    // pollDueSchedules ("update WHERE next_run_at = <value I read>") behave
    // correctly under a simulated race: a second racer's filter (the OLD
    // next_run_at) no longer matches the row once the first racer's update
    // has already applied.
    const matchTargets = (): Row[] => {
      const filters = (q as unknown as { filters: Array<[string, unknown]> }).filters;
      return rows.filter((r) => filters.every(([c, v]) => {
        if (c.startsWith('__lte__')) return String(r[c.slice(7)]) <= String(v);
        return r[c] === v;
      }));
    };
    q.maybeSingle = async () => {
      const targets = matchTargets();
      if (targets.length === 0) return { data: null, error: null };
      Object.assign(targets[0], patch);
      return { data: targets[0], error: null };
    };
    q.then = <T,>(resolve: (v: { data: Row[]; error: null }) => T) => {
      const targets = matchTargets();
      for (const target of targets) Object.assign(target, patch);
      return Promise.resolve(resolve({ data: targets, error: null }));
    };
    return q;
  }
}

class FakeDb {
  tables = new Map<string, Row[]>();
  from(name: string): FakeTableHandle {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new FakeTableHandle(this.tables.get(name)!);
  }
}

const fakeDb = new FakeDb();
const runWorkflowExecutionMock = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
}));

vi.mock('@/lib/workflow-runtime/engine', () => ({
  runWorkflowExecution: (...args: unknown[]) => runWorkflowExecutionMock(...args),
}));

beforeEach(() => {
  fakeDb.tables.clear();
  runWorkflowExecutionMock.mockReset();
  runWorkflowExecutionMock.mockResolvedValue({ executionId: 'exec-1', status: 'success' });
});

// ─── Cron validation ────────────────────────────────────────────────────────────

describe('validateCronExpression', () => {
  it('accepts a valid 5-field cron expression', async () => {
    const { validateCronExpression } = await import('../lib/runtime/scheduler');
    expect(validateCronExpression('0 9 * * 1-5').valid).toBe(true);
  });

  it('rejects an empty expression', async () => {
    const { validateCronExpression } = await import('../lib/runtime/scheduler');
    const result = validateCronExpression('');
    expect(result.valid).toBe(false);
  });

  it('rejects a malformed expression', async () => {
    const { validateCronExpression } = await import('../lib/runtime/scheduler');
    const result = validateCronExpression('not a cron expression at all');
    expect(result.valid).toBe(false);
  });

  it('rejects an out-of-range field', async () => {
    const { validateCronExpression } = await import('../lib/runtime/scheduler');
    const result = validateCronExpression('99 9 * * *'); // minute 99 is invalid
    expect(result.valid).toBe(false);
  });
});

// ─── Next-run computation (timezone-aware) ──────────────────────────────────────

describe('computeNextRunAt', () => {
  it('is deterministic for the same cron + timezone + fromDate', async () => {
    const { computeNextRunAt } = await import('../lib/runtime/scheduler');
    const from = new Date('2026-08-15T00:00:00Z');
    const a = computeNextRunAt('0 9 * * *', 'UTC', from);
    const b = computeNextRunAt('0 9 * * *', 'UTC', from);
    expect(a.toISOString()).toBe(b.toISOString());
  });

  it('resolves 9am UTC correctly', async () => {
    const { computeNextRunAt } = await import('../lib/runtime/scheduler');
    const next = computeNextRunAt('0 9 * * *', 'UTC', new Date('2026-08-15T00:00:00Z'));
    expect(next.getUTCHours()).toBe(9);
  });

  it('resolves 9am America/New_York to the correct UTC offset (timezone-aware, not just UTC)', async () => {
    const { computeNextRunAt } = await import('../lib/runtime/scheduler');
    // Mid-August is EDT (UTC-4), so 9am local = 13:00 UTC.
    const next = computeNextRunAt('0 9 * * *', 'America/New_York', new Date('2026-08-15T00:00:00Z'));
    expect(next.getUTCHours()).toBe(13);
  });

  it('always returns a time strictly after fromDate', async () => {
    const { computeNextRunAt } = await import('../lib/runtime/scheduler');
    const from = new Date('2026-08-15T09:00:00Z');
    const next = computeNextRunAt('0 9 * * *', 'UTC', from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });
});

// ─── Schedule extraction from workflow JSON ─────────────────────────────────────

describe('extractScheduleTriggers / validateScheduleTriggers', () => {
  it('extracts every schedule-trigger node from a workflow', async () => {
    const { extractScheduleTriggers } = await import('../lib/runtime/scheduler');
    const wf = {
      nodes: [
        { id: 'n1', name: 'Daily Report', type: 'n8n-nodes-base.scheduleTrigger', parameters: { cronExpression: '0 9 * * *', timezone: 'UTC' } },
        { id: 'n2', name: 'Do Thing', type: 'n8n-nodes-base.code', parameters: {} },
      ],
    };
    const specs = extractScheduleTriggers(wf);
    expect(specs).toHaveLength(1);
    expect(specs[0].nodeName).toBe('Daily Report');
    expect(specs[0].cronExpression).toBe('0 9 * * *');
  });

  it('returns no errors for a workflow with valid schedule triggers', async () => {
    const { validateScheduleTriggers } = await import('../lib/runtime/scheduler');
    const wf = { nodes: [{ id: 'n1', name: 'X', type: 'n8n-nodes-base.scheduleTrigger', parameters: { cronExpression: '0 9 * * *', timezone: 'UTC' } }] };
    expect(validateScheduleTriggers(wf)).toHaveLength(0);
  });

  it('blocks activation with an error naming the node when the cron is invalid', async () => {
    const { validateScheduleTriggers } = await import('../lib/runtime/scheduler');
    const wf = { nodes: [{ id: 'n1', name: 'Bad Schedule', type: 'n8n-nodes-base.scheduleTrigger', parameters: { cronExpression: 'garbage', timezone: 'UTC' } }] };
    const errors = validateScheduleTriggers(wf);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Bad Schedule');
  });

  it('returns no errors for a workflow with no schedule triggers at all', async () => {
    const { validateScheduleTriggers } = await import('../lib/runtime/scheduler');
    expect(validateScheduleTriggers({ nodes: [{ id: 'n1', name: 'x', type: 'n8n-nodes-base.webhook', parameters: {} }] })).toHaveLength(0);
  });
});

// ─── syncWorkflowSchedules ───────────────────────────────────────────────────────

describe('syncWorkflowSchedules', () => {
  it('creates a schedule row for a new schedule-trigger node', async () => {
    const { syncWorkflowSchedules } = await import('../lib/runtime/scheduler');
    const wf = { nodes: [{ id: 'n1', name: 'Daily', type: 'n8n-nodes-base.scheduleTrigger', parameters: { cronExpression: '0 9 * * *', timezone: 'UTC' } }] };
    await syncWorkflowSchedules({ userId: USER_A, workflowId: 'wf-1', workflowJson: wf });

    const rows = fakeDb.tables.get('workflow_schedules') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].node_name).toBe('Daily');
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].next_run_at).toBeTruthy();
  });

  it('removes the schedule row when the node is deleted from the workflow on re-activation', async () => {
    const { syncWorkflowSchedules } = await import('../lib/runtime/scheduler');
    const wfWithSchedule = { nodes: [{ id: 'n1', name: 'Daily', type: 'n8n-nodes-base.scheduleTrigger', parameters: { cronExpression: '0 9 * * *', timezone: 'UTC' } }] };
    await syncWorkflowSchedules({ userId: USER_A, workflowId: 'wf-1', workflowJson: wfWithSchedule });
    expect(fakeDb.tables.get('workflow_schedules')).toHaveLength(1);

    const wfWithoutSchedule = { nodes: [{ id: 'n2', name: 'Just Code', type: 'n8n-nodes-base.code', parameters: {} }] };
    await syncWorkflowSchedules({ userId: USER_A, workflowId: 'wf-1', workflowJson: wfWithoutSchedule });
    expect(fakeDb.tables.get('workflow_schedules')).toHaveLength(0);
  });
});

// ─── pollDueSchedules ────────────────────────────────────────────────────────────

describe('pollDueSchedules', () => {
  function seedSchedule(overrides: Partial<Row> = {}): void {
    fakeDb.tables.set('workflow_schedules', [
      {
        id: 'sched-1', workflow_id: 'wf-1', user_id: USER_A, node_id: 'n1', node_name: 'Daily',
        cron_expression: '0 9 * * *', timezone: 'UTC', enabled: true,
        next_run_at: '2026-08-15T09:00:00.000Z',
        ...overrides,
      },
    ]);
    fakeDb.tables.set('workflows', [
      { id: 'wf-1', user_id: USER_A, workflow_json: { nodes: [] }, status: 'active', active_deployment_version_id: null },
    ]);
  }

  it('fires exactly one execution for a single due schedule', async () => {
    seedSchedule();
    const { pollDueSchedules } = await import('../lib/runtime/scheduler');
    const result = await pollDueSchedules(new Date('2026-08-15T09:00:30.000Z'));

    expect(result.fired).toBe(1);
    expect(runWorkflowExecutionMock).toHaveBeenCalledTimes(1);
  });

  it("does not fire before next_run_at", async () => {
    seedSchedule({ next_run_at: '2026-08-15T09:00:00.000Z' });
    const { pollDueSchedules } = await import('../lib/runtime/scheduler');
    const result = await pollDueSchedules(new Date('2026-08-15T08:59:00.000Z'));

    expect(result.fired).toBe(0);
    expect(runWorkflowExecutionMock).not.toHaveBeenCalled();
  });

  it('skips a disabled schedule', async () => {
    seedSchedule({ enabled: false });
    const { pollDueSchedules } = await import('../lib/runtime/scheduler');
    const result = await pollDueSchedules(new Date('2026-08-15T09:00:30.000Z'));

    expect(result.fired).toBe(0);
    expect(runWorkflowExecutionMock).not.toHaveBeenCalled();
  });

  it('skips a schedule whose workflow is not active (paused/disabled/draft)', async () => {
    seedSchedule();
    fakeDb.tables.set('workflows', [
      { id: 'wf-1', user_id: USER_A, workflow_json: { nodes: [] }, status: 'paused', active_deployment_version_id: null },
    ]);
    const { pollDueSchedules } = await import('../lib/runtime/scheduler');
    const result = await pollDueSchedules(new Date('2026-08-15T09:00:30.000Z'));

    expect(result.fired).toBe(0);
    expect(runWorkflowExecutionMock).not.toHaveBeenCalled();
  });

  it('advances next_run_at strictly forward after firing (missed-run handling — does not backfill every missed interval)', async () => {
    seedSchedule({ next_run_at: '2026-08-10T09:00:00.000Z' }); // 5 days "missed"
    const { pollDueSchedules } = await import('../lib/runtime/scheduler');
    const now = new Date('2026-08-15T09:05:00.000Z');
    await pollDueSchedules(now);

    const row = (fakeDb.tables.get('workflow_schedules') ?? [])[0] as Row;
    expect(new Date(row.next_run_at as string).getTime()).toBeGreaterThan(now.getTime());
    // Exactly one execution fired for the whole 5-day backlog, not five.
    expect(runWorkflowExecutionMock).toHaveBeenCalledTimes(1);
  });

  it('resolves the frozen active deployment version instead of live workflow_json when one is pinned', async () => {
    seedSchedule();
    fakeDb.tables.set('workflows', [
      { id: 'wf-1', user_id: USER_A, workflow_json: { nodes: [{ name: 'live-draft-version' }] }, status: 'active', active_deployment_version_id: 'v1' },
    ]);
    fakeDb.tables.set('deployment_versions', [
      { id: 'v1', workflow_data: { nodes: [{ name: 'frozen-active-version' }] } },
    ]);

    const { pollDueSchedules } = await import('../lib/runtime/scheduler');
    await pollDueSchedules(new Date('2026-08-15T09:00:30.000Z'));

    const call = runWorkflowExecutionMock.mock.calls[0][0] as { workflowJson: { nodes: Array<{ name: string }> } };
    expect(call.workflowJson.nodes[0].name).toBe('frozen-active-version');
  });

  it('two concurrent pollers racing on the same due schedule: only one fires it (CAS claim prevents double-firing)', async () => {
    seedSchedule();
    const { pollDueSchedules } = await import('../lib/runtime/scheduler');
    const now = new Date('2026-08-15T09:00:30.000Z');

    // Simulate two scheduler processes polling at the "same" moment by
    // running two pollDueSchedules() calls against the shared fakeDb without
    // awaiting between them — both will read next_run_at before either
    // claims it, exactly like two real racing HTTP-triggered cron workers.
    const [resultA, resultB] = await Promise.all([pollDueSchedules(now), pollDueSchedules(now)]);

    const totalFired = resultA.fired + resultB.fired;
    expect(totalFired).toBe(1);
    expect(runWorkflowExecutionMock).toHaveBeenCalledTimes(1);
  });

  it('records the resulting execution id and any error on the schedule row', async () => {
    seedSchedule();
    runWorkflowExecutionMock.mockResolvedValue({ executionId: 'exec-42', status: 'failed', error: 'boom' });
    const { pollDueSchedules } = await import('../lib/runtime/scheduler');
    await pollDueSchedules(new Date('2026-08-15T09:00:30.000Z'));

    const row = (fakeDb.tables.get('workflow_schedules') ?? [])[0] as Row;
    expect(row.last_execution_id).toBe('exec-42');
    expect(row.last_error).toBe('boom');
  });
});

