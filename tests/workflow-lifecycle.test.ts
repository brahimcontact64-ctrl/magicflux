/**
 * Phase 8 — Workflow lifecycle (lib/workflow/lifecycle.ts).
 *
 * Before this: workflows.status only ever held 'draft' or 'deployed', deploy
 * never froze a version anywhere execution actually reads from, and nothing
 * validated a workflow before letting it receive live traffic. This proves
 * activation freezes a real deployment_versions snapshot, only ever succeeds
 * for a structurally-valid workflow with valid schedule cron expressions,
 * and that pause/resume/deactivate/archive transitions behave as specified.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000f1';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  constructor(private rows: Row[], private op: 'select' | 'delete' = 'select') {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(_cols?: string): this { return this; }
  order(col: string, opts?: { ascending?: boolean }): this { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number): this { this.limitN = n; return this; }
  single(): this { return this; }
  private matched(): Row[] {
    let result = this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.orderCol) {
      const col = this.orderCol;
      result = [...result].sort((a, b) => {
        const av = a[col] as number; const bv = b[col] as number;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.limitN !== null) result = result.slice(0, this.limitN);
    return result.map((r) => ({ ...r }));
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    return { data: m[0] ?? null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve(resolve({ data: this.matched(), error: null }));
  }
}

class FakeTableHandle {
  constructor(private rows: Row[]) {}
  select(): FakeQuery { return new FakeQuery(this.rows, 'select'); }
  delete(): FakeQuery { return new FakeQuery(this.rows, 'delete'); }
  insert(row: Row): FakeQuery & { single: () => Promise<{ data: Row; error: null }> } {
    const withId = { id: row.id ?? `fake-${this.rows.length}-${Math.random().toString(36).slice(2)}`, ...row };
    this.rows.push(withId);
    const q = new FakeQuery([withId], 'select');
    return Object.assign(q, { single: async () => ({ data: withId, error: null }) });
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
    const matchTargets = () => {
      const filters = (q as unknown as { filters: Array<[string, unknown]> }).filters;
      return rows.filter((r) => filters.every(([c, v]) => r[c] === v));
    };
    q.maybeSingle = async () => {
      const targets = matchTargets();
      if (targets.length === 0) return { data: null, error: null };
      Object.assign(targets[0], patch);
      return { data: { ...targets[0] }, error: null };
    };
    q.then = <T,>(resolve: (v: { data: Row[]; error: null }) => T) => {
      const targets = matchTargets();
      for (const t of targets) Object.assign(t, patch);
      return Promise.resolve(resolve({ data: targets.map((t) => ({ ...t })), error: null }));
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

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
}));

function validWorkflow() {
  return {
    name: 'Valid workflow',
    nodes: [
      { id: 't1', name: 'Trigger', type: 'n8n-nodes-base.webhook', parameters: { path: '/x' } },
      // Phase 9.5.1A: was 'n8n-nodes-base.code' -- a generic placeholder
      // action node chosen only because it used to be considered capable.
      // Code/function nodes are now correctly blocked (node-capabilities.ts),
      // so this fixture -- which exists to prove a *supported* workflow
      // activates cleanly, not to test code-node rejection specifically --
      // uses 'set' instead, a genuinely supported deterministic type.
      { id: 'n1', name: 'Do', type: 'n8n-nodes-base.set', parameters: {} },
    ],
    connections: { Trigger: { main: [[{ node: 'Do' }]] } },
  };
}

function seedWorkflow(id: string, workflowJson: unknown, status = 'draft'): void {
  fakeDb.tables.set('workflows', [
    { id, user_id: USER_A, workflow_json: workflowJson, status, active_deployment_version_id: null },
  ]);
}

beforeEach(() => { fakeDb.tables.clear(); });

describe('activateWorkflow', () => {
  it('freezes a deployment_versions row with status=active and points the workflow at it', async () => {
    seedWorkflow('wf-1', validWorkflow());
    const { activateWorkflow } = await import('../lib/workflow/lifecycle');
    const result = await activateWorkflow(USER_A, 'wf-1');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.version).toBe(1);

    const versions = fakeDb.tables.get('deployment_versions') ?? [];
    expect(versions).toHaveLength(1);
    expect(versions[0].status).toBe('active');
    expect(versions[0].workflow_data).toEqual(validWorkflow());

    const workflow = (fakeDb.tables.get('workflows') ?? [])[0] as Row;
    expect(workflow.status).toBe('active');
    expect(workflow.active_deployment_version_id).toBe(result.deploymentVersionId);
    expect(workflow.activated_at).toBeTruthy();
  });

  it('rejects a structurally invalid workflow and marks status=error with the reason, without freezing a version', async () => {
    seedWorkflow('wf-1', { name: 'Broken', nodes: [], connections: {} }); // EMPTY_WORKFLOW
    const { activateWorkflow } = await import('../lib/workflow/lifecycle');
    const result = await activateWorkflow(USER_A, 'wf-1');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.length).toBeGreaterThan(0);

    const workflow = (fakeDb.tables.get('workflows') ?? [])[0] as Row;
    expect(workflow.status).toBe('error');
    expect(workflow.deployment_error).toBeTruthy();
    expect(fakeDb.tables.get('deployment_versions') ?? []).toHaveLength(0);
  });

  it('rejects an invalid cron expression on a schedule-trigger node, naming the node', async () => {
    const wf = {
      name: 'Has bad schedule',
      nodes: [
        { id: 't1', name: 'Every Day', type: 'n8n-nodes-base.scheduleTrigger', parameters: { cronExpression: 'not-a-cron', timezone: 'UTC' } },
        { id: 'n1', name: 'Do', type: 'n8n-nodes-base.code', parameters: {} },
      ],
      connections: { 'Every Day': { main: [[{ node: 'Do' }]] } },
    };
    seedWorkflow('wf-1', wf);
    const { activateWorkflow } = await import('../lib/workflow/lifecycle');
    const result = await activateWorkflow(USER_A, 'wf-1');

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.some((e) => e.includes('Every Day'))).toBe(true);
  });

  it('re-activation supersedes the previous active version and increments the version number', async () => {
    seedWorkflow('wf-1', validWorkflow());
    const { activateWorkflow } = await import('../lib/workflow/lifecycle');
    const first = await activateWorkflow(USER_A, 'wf-1');
    expect(first.success).toBe(true);

    const second = await activateWorkflow(USER_A, 'wf-1');
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(second.version).toBe(2);

    const versions = fakeDb.tables.get('deployment_versions') ?? [];
    const firstVersion = versions.find((v) => v.id === first.deploymentVersionId) as Row;
    expect(firstVersion.status).toBe('superseded');
  });

  it('registers a schedule row for a schedule-trigger node in the activated workflow', async () => {
    const wf = {
      name: 'Scheduled',
      nodes: [{ id: 't1', name: 'Daily', type: 'n8n-nodes-base.scheduleTrigger', parameters: { cronExpression: '0 9 * * *', timezone: 'UTC' } }],
      connections: {},
    };
    seedWorkflow('wf-1', wf);
    const { activateWorkflow } = await import('../lib/workflow/lifecycle');
    await activateWorkflow(USER_A, 'wf-1');

    const schedules = fakeDb.tables.get('workflow_schedules') ?? [];
    expect(schedules).toHaveLength(1);
    expect(schedules[0].enabled).toBe(true);
  });

  it('refuses to activate an archived workflow', async () => {
    seedWorkflow('wf-1', validWorkflow(), 'archived');
    const { activateWorkflow } = await import('../lib/workflow/lifecycle');
    const result = await activateWorkflow(USER_A, 'wf-1');
    expect(result.success).toBe(false);
  });

  it('returns an error (not a throw) for a nonexistent workflow', async () => {
    const { activateWorkflow } = await import('../lib/workflow/lifecycle');
    const result = await activateWorkflow(USER_A, 'does-not-exist');
    expect(result.success).toBe(false);
  });
});

describe('pause / resume / deactivate / archive', () => {
  it('pause stops future triggers by disabling schedules and setting status=paused', async () => {
    seedWorkflow('wf-1', validWorkflow(), 'active');
    fakeDb.tables.set('workflow_schedules', [{ id: 's1', workflow_id: 'wf-1', user_id: USER_A, enabled: true, cron_expression: '0 9 * * *', timezone: 'UTC' }]);

    const { pauseWorkflow } = await import('../lib/workflow/lifecycle');
    const result = await pauseWorkflow(USER_A, 'wf-1');

    expect(result.success).toBe(true);
    expect((fakeDb.tables.get('workflows') ?? [])[0].status).toBe('paused');
    expect((fakeDb.tables.get('workflow_schedules') ?? [])[0].enabled).toBe(false);
  });

  it('resume only succeeds from paused, and re-enables schedules', async () => {
    seedWorkflow('wf-1', validWorkflow(), 'paused');
    fakeDb.tables.set('workflow_schedules', [{ id: 's1', workflow_id: 'wf-1', user_id: USER_A, enabled: false, cron_expression: '0 9 * * *', timezone: 'UTC' }]);

    const { resumeWorkflow } = await import('../lib/workflow/lifecycle');
    const result = await resumeWorkflow(USER_A, 'wf-1');

    expect(result.success).toBe(true);
    expect((fakeDb.tables.get('workflows') ?? [])[0].status).toBe('active');
    expect((fakeDb.tables.get('workflow_schedules') ?? [])[0].enabled).toBe(true);
  });

  it('resume rejects a workflow that is not currently paused', async () => {
    seedWorkflow('wf-1', validWorkflow(), 'draft');
    const { resumeWorkflow } = await import('../lib/workflow/lifecycle');
    const result = await resumeWorkflow(USER_A, 'wf-1');
    expect(result.success).toBe(false);
  });

  it('deactivate sets status=disabled without touching a separately-tracked in-progress execution', async () => {
    seedWorkflow('wf-1', validWorkflow(), 'active');
    fakeDb.tables.set('workflow_executions_v2', [{ id: 'exec-1', workflow_id: 'wf-1', user_id: USER_A, status: 'running' }]);

    const { deactivateWorkflow } = await import('../lib/workflow/lifecycle');
    const result = await deactivateWorkflow(USER_A, 'wf-1');

    expect(result.success).toBe(true);
    expect((fakeDb.tables.get('workflows') ?? [])[0].status).toBe('disabled');
    // The in-progress execution row is untouched — deactivation must not corrupt it.
    expect((fakeDb.tables.get('workflow_executions_v2') ?? [])[0].status).toBe('running');
  });

  it('archive is a terminal state', async () => {
    seedWorkflow('wf-1', validWorkflow(), 'active');
    const { archiveWorkflow } = await import('../lib/workflow/lifecycle');
    const result = await archiveWorkflow(USER_A, 'wf-1');
    expect(result.success).toBe(true);
    expect((fakeDb.tables.get('workflows') ?? [])[0].status).toBe('archived');
  });
});

describe('isExecutableStatus', () => {
  it('active and deployed are executable', async () => {
    const { isExecutableStatus } = await import('../lib/workflow/lifecycle');
    expect(isExecutableStatus('active')).toBe(true);
    expect(isExecutableStatus('deployed')).toBe(true);
  });

  it('draft, paused, disabled, error, archived, validating are not', async () => {
    const { isExecutableStatus } = await import('../lib/workflow/lifecycle');
    for (const status of ['draft', 'paused', 'disabled', 'error', 'archived', 'validating']) {
      expect(isExecutableStatus(status)).toBe(false);
    }
  });
});
