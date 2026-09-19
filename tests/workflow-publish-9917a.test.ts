/**
 * Phase 9.9.17A -- publishNewVersion() (lib/workflow/lifecycle.ts): the
 * no-downtime "Publish changes" path for a workflow that is ALREADY
 * active. Reuses the exact same FakeDb harness style as
 * tests/workflow-lifecycle.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let connectedAirtableToken: string | null = null;
vi.mock('@/lib/user-integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/user-integrations')>();
  return { ...actual, getConnectedAirtableToken: vi.fn(async () => connectedAirtableToken) };
});

const airtableFetchMock = vi.fn();
vi.stubGlobal('fetch', airtableFetchMock);

const USER_A = '00000000-0000-4000-8000-0000000000f1';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  order(col: string, opts?: { ascending?: boolean }): this { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number): this { this.limitN = n; return this; }
  private matched(): Row[] {
    let result = this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.orderCol) {
      const col = this.orderCol;
      result = [...result].sort((a, b) => {
        const av = a[col] as number; const bv = b[col] as number;
        return this.orderAsc ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
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
  constructor(private rows: Row[], private tableName: string) {}
  select(): FakeQuery { return new FakeQuery(this.rows); }
  insert(row: Row): FakeQuery & { single: () => Promise<{ data: Row; error: null }> } {
    // Simulate the real UNIQUE(workflow_id, version) constraint on
    // deployment_versions -- a concurrent publisher racing to insert the
    // SAME version number must fail loudly, never silently succeed twice.
    if (this.tableName === 'deployment_versions') {
      const collision = this.rows.some((r) => r.workflow_id === row.workflow_id && r.version === row.version);
      if (collision) throw new Error('duplicate key value violates unique constraint "deployment_versions_workflow_id_version_key"');
    }
    const withId = { id: row.id ?? `fake-${this.rows.length}-${Math.random().toString(36).slice(2)}`, ...row };
    this.rows.push(withId);
    const q = new FakeQuery([withId]);
    return Object.assign(q, { single: async () => ({ data: withId, error: null }) });
  }
  update(patch: Row): FakeQuery {
    const q = new FakeQuery(this.rows);
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
    return new FakeTableHandle(this.tables.get(name)!, name);
  }
}

const fakeDb = new FakeDb();
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn(() => fakeDb) }));

function validWorkflow(marker = 'v1') {
  return {
    name: 'Valid workflow',
    nodes: [
      { id: 't1', name: 'Trigger', type: 'n8n-nodes-base.webhook', parameters: { path: '/x' } },
      { id: 'n1', name: 'Do', type: 'n8n-nodes-base.set', parameters: { marker } },
    ],
    connections: { Trigger: { main: [[{ node: 'Do' }]] } },
  };
}

const T1 = '2026-01-01T00:00:00.000Z';

function seedActiveWorkflow(id: string, workflowJson: unknown, opts?: { updatedAt?: string; activeVersionId?: string }) {
  const versionId = opts?.activeVersionId ?? 'dv-1';
  fakeDb.tables.set('workflows', [
    { id, user_id: USER_A, workflow_json: workflowJson, status: 'active', active_deployment_version_id: versionId, updated_at: opts?.updatedAt ?? T1 },
  ]);
  fakeDb.tables.set('deployment_versions', [
    { id: versionId, workflow_id: id, user_id: USER_A, version: 1, status: 'active', workflow_data: validWorkflow('v1'), deployed_at: T1 },
  ]);
}

beforeEach(() => {
  fakeDb.tables.clear();
  connectedAirtableToken = null;
  airtableFetchMock.mockReset();
});

describe('publishNewVersion', () => {
  it('Part K.2 -- active v1 + a genuinely changed, valid draft: v2 becomes active, v1 superseded', async () => {
    seedActiveWorkflow('wf-1', validWorkflow('v2-content'));
    const { publishNewVersion } = await import('../lib/workflow/lifecycle');
    const result = await publishNewVersion(USER_A, 'wf-1', T1);

    expect(result.success).toBe(true);
    if (!result.success || result.alreadyUpToDate) throw new Error('expected a real new version');
    expect(result.version).toBe(2);

    const versions = fakeDb.tables.get('deployment_versions') ?? [];
    expect(versions).toHaveLength(2);
    expect(versions.find((v) => v.version === 1)?.status).toBe('superseded');
    expect(versions.find((v) => v.version === 2)?.status).toBe('active');

    const workflow = (fakeDb.tables.get('workflows') ?? [])[0];
    expect(workflow.active_deployment_version_id).toBe(result.deploymentVersionId);
  });

  it('Part K.1/B -- active v1 + an invalid draft: publish rejected, v1 completely untouched, zero new versions, zero status writes', async () => {
    seedActiveWorkflow('wf-1', { name: 'Broken', nodes: [], connections: {} });
    const { publishNewVersion } = await import('../lib/workflow/lifecycle');
    const result = await publishNewVersion(USER_A, 'wf-1', T1);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('validation_failed');

    const workflow = (fakeDb.tables.get('workflows') ?? [])[0];
    expect(workflow.status).toBe('active'); // never touched, never 'validating', never 'error'
    expect(workflow.active_deployment_version_id).toBe('dv-1'); // still v1
    expect(workflow.updated_at).toBe(T1); // untouched
    expect(fakeDb.tables.get('deployment_versions') ?? []).toHaveLength(1); // no new version created
  });

  it('Part K.10 -- an unchanged draft never creates an unnecessary new version', async () => {
    seedActiveWorkflow('wf-1', validWorkflow('v1')); // identical to what dv-1 already has
    const { publishNewVersion } = await import('../lib/workflow/lifecycle');
    const result = await publishNewVersion(USER_A, 'wf-1', T1);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.alreadyUpToDate).toBe(true);
    expect(result.version).toBe(1);
    expect(fakeDb.tables.get('deployment_versions') ?? []).toHaveLength(1);
  });

  it('Part F/K.9 -- a stale expectedUpdatedAt (draft changed since the caller last read it) is rejected before any validation or write', async () => {
    seedActiveWorkflow('wf-1', validWorkflow('v2-content'), { updatedAt: '2026-01-02T00:00:00.000Z' });
    const { publishNewVersion } = await import('../lib/workflow/lifecycle');
    const result = await publishNewVersion(USER_A, 'wf-1', T1); // T1 is now stale

    expect(result.success).toBe(false);
    if (result.success || result.reason !== 'stale_draft') throw new Error('expected a stale_draft rejection');
    expect(result.latestUpdatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(fakeDb.tables.get('deployment_versions') ?? []).toHaveLength(1); // no new version created
  });

  it('Part E/K.8 -- a second Publish using the same starting revision, after the first already completed, is rejected as a conflict (never a silent second cutover)', async () => {
    seedActiveWorkflow('wf-1', validWorkflow('v2-content'));
    const { publishNewVersion } = await import('../lib/workflow/lifecycle');

    const first = await publishNewVersion(USER_A, 'wf-1', T1);
    expect(first.success).toBe(true);

    // A second publisher that started from the SAME original revision (T1)
    // -- exactly what two browser tabs both loading the workflow before
    // either publishes would send.
    const second = await publishNewVersion(USER_A, 'wf-1', T1);
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.reason).toBe('stale_draft');

    // Exactly one active deployment after both attempts.
    const versions = fakeDb.tables.get('deployment_versions') ?? [];
    expect(versions.filter((v) => v.status === 'active')).toHaveLength(1);
  });

  it('Part E -- a version-number collision at the DB layer (the real UNIQUE(workflow_id, version) constraint, e.g. a genuinely concurrent publisher winning the race a moment earlier) is caught and reported as a clean conflict, never an unhandled exception', async () => {
    seedActiveWorkflow('wf-1', validWorkflow('v2-content'));
    const { DeploymentManager } = await import('../lib/deployment/deployment-manager');
    const spy = vi.spyOn(DeploymentManager.prototype, 'recordDeployment').mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "deployment_versions_workflow_id_version_key"'),
    );

    const { publishNewVersion } = await import('../lib/workflow/lifecycle');
    const result = await publishNewVersion(USER_A, 'wf-1', T1);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('conflict');
    // The workflows row was never touched -- v1 remains active and pointed at.
    const workflow = (fakeDb.tables.get('workflows') ?? [])[0];
    expect(workflow.active_deployment_version_id).toBe('dv-1');
    spy.mockRestore();
  });

  it('Part D -- reuses the exact same guard suite: an SLA node reachable without a classification gate is rejected exactly like activateWorkflow() would reject it', async () => {
    const ungatedSla = {
      name: 'Ungated SLA',
      nodes: [
        { id: 't1', name: 'Trigger', type: 'n8n-nodes-base.webhook', parameters: { path: '/x' } },
        { id: 'ai1', name: 'Classify', type: 'magicflux-nodes.aiClassifier', parameters: { instruction: 'x', allowedLabels: ['Hot', 'Cold'], confidenceThreshold: 0.6, outputField: 'classification' } },
        { id: 'ack1', name: 'Ack', type: 'magicflux-nodes.createAcknowledgmentChallenge', parameters: { slaMinutes: 15 } },
      ],
      connections: { Trigger: { main: [[{ node: 'Classify' }]] }, Classify: { main: [[{ node: 'Ack' }]] } },
    };
    seedActiveWorkflow('wf-1', ungatedSla);
    const { publishNewVersion } = await import('../lib/workflow/lifecycle');
    const result = await publishNewVersion(USER_A, 'wf-1', T1);

    expect(result.success).toBe(false);
    if (result.success || result.reason !== 'validation_failed') throw new Error('expected a validation_failed rejection');
    expect(result.errors.some((e: string) => e.toLowerCase().includes('gate'))).toBe(true);
  });

  it('rejects publishing a workflow that is not currently executable (draft/disabled/error) -- that is what Activate is for', async () => {
    fakeDb.tables.set('workflows', [{ id: 'wf-1', user_id: USER_A, workflow_json: validWorkflow(), status: 'draft', active_deployment_version_id: null, updated_at: T1 }]);
    const { publishNewVersion } = await import('../lib/workflow/lifecycle');
    const result = await publishNewVersion(USER_A, 'wf-1', T1);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('not_executable');
  });

  it('Part C/K.3/K.4 -- an incoming webhook resolves v1 right up until cutover, and v2 immediately after, never a dip through a non-executable status', async () => {
    seedActiveWorkflow('wf-1', validWorkflow('v2-content'));

    // Exactly the same 3-step resolution app/api/workflows/[id]/webhook/
    // route.ts performs on every single incoming request: read the
    // workflow row fresh, then -- if an active_deployment_version_id is
    // set -- resolve the FROZEN snapshot, never the live draft column.
    async function resolveWhatAWebhookWouldExecute() {
      const wfRow = (fakeDb.tables.get('workflows') ?? [])[0] as Row;
      const versions = fakeDb.tables.get('deployment_versions') ?? [];
      const pinned = versions.find((v) => v.id === wfRow.active_deployment_version_id);
      return { status: wfRow.status, marker: (pinned?.workflow_data as { nodes: Array<{ parameters: { marker?: string } }> })?.nodes[1]?.parameters?.marker };
    }

    const before = await resolveWhatAWebhookWouldExecute();
    expect(before.status).toBe('active'); // executable throughout -- publishNewVersion never writes 'validating'
    expect(before.marker).toBe('v1');

    const { publishNewVersion } = await import('../lib/workflow/lifecycle');
    const published = await publishNewVersion(USER_A, 'wf-1', T1);
    expect(published.success).toBe(true);

    const after = await resolveWhatAWebhookWouldExecute();
    expect(after.status).toBe('active');
    expect(after.marker).toBe('v2-content');
  });

  it('cross-tenant: a different user publishing to another account\'s workflow id gets "not_executable" (not found), never touches it', async () => {
    seedActiveWorkflow('wf-1', validWorkflow('v2-content'));
    const USER_B = '00000000-0000-4000-8000-0000000000f2';
    const { publishNewVersion } = await import('../lib/workflow/lifecycle');
    const result = await publishNewVersion(USER_B, 'wf-1', T1);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('not_executable');
    expect(fakeDb.tables.get('deployment_versions') ?? []).toHaveLength(1);
  });
});
