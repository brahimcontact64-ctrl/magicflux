/**
 * Phase 9.9.12 -- crash-window recovery for the SLA acknowledgment
 * decision->resume gap (lib/runtime/acknowledgment-resume.ts), mirroring
 * tests/review-resume-crash-safety.test.ts's exact architecture and
 * fixture shape for the equivalent Human Review vulnerability.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private nullFilters: string[] = [];
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  lte(col: string, val: unknown): this { this.filters.push([`__lte__${col}`, val]); return this; }
  in(col: string, vals: unknown[]): this { this.filters.push([`__in__${col}`, vals]); return this; }
  is(col: string, _val: null): this { this.nullFilters.push(col); return this; }
  select(): this { return this; }
  limit(): this { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) => {
      const okEq = this.filters.every(([c, v]) => {
        if (c.startsWith('__lte__')) return String(r[c.slice(7)] ?? '') <= String(v);
        if (c.startsWith('__in__')) return (v as unknown[]).includes(r[c.slice(6)]);
        return r[c] === v;
      });
      const okNull = this.nullFilters.every((c) => r[c] === null || r[c] === undefined);
      return okEq && okNull;
    });
  }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const m = this.matched();
    if (this.pendingPatch) for (const row of m) Object.assign(row, this.pendingPatch);
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    const m = this.matched();
    if (this.pendingPatch) for (const row of m) Object.assign(row, this.pendingPatch);
    return Promise.resolve(resolve({ data: m.map((r) => ({ ...r })), error: null }));
  }
}

function freshTables(): Record<string, Row[]> {
  return {
    workflow_acknowledgments: [
      {
        id: 'ack-1',
        user_id: 'user-1',
        workflow_id: 'wf-1',
        execution_id: 'exec-1',
        node_id: 'node-1',
        // Deliberately different from node_id, mirroring the real
        // production shape (see review-resume-crash-safety.test.ts's own
        // comment for why this specific mismatch matters).
        node_name: 'Await acknowledgment',
        deployment_version_id: null,
        status: 'acknowledged',
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        mode: 'live',
        resume_attempts: 0,
        resumed_at: null,
        updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    ],
    workflow_executions_v2: [
      { id: 'exec-1', status: 'waiting', current_node_id: 'Await acknowledgment' },
    ],
    workflows: [
      { id: 'wf-1', user_id: 'user-1', workflow_json: { nodes: [], connections: {} } },
    ],
    deployment_versions: [] as Row[],
  };
}

let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = [])),
  })),
}));

const resumeExecutionMock = vi.fn().mockResolvedValue({ status: 'success' });
vi.mock('@/runtime/execution-manager', () => ({
  ExecutionManager: class {
    resumeExecution(...args: unknown[]) { return resumeExecutionMock(...args); }
  },
}));

beforeEach(() => {
  tables = freshTables();
  resumeExecutionMock.mockClear();
  resumeExecutionMock.mockResolvedValue({ status: 'success' });
});

function ackItem(overrides: Partial<Row> = {}) {
  return {
    id: 'ack-1',
    user_id: 'user-1',
    workflow_id: 'wf-1',
    execution_id: 'exec-1',
    node_id: 'node-1',
    node_name: 'Await acknowledgment',
    deployment_version_id: null,
    mode: 'live' as const,
    resume_attempts: 0,
    ...overrides,
  };
}

describe('attemptAcknowledgmentResume — crash-window recovery', () => {
  it('resumes when the execution is genuinely still waiting at this exact node', async () => {
    const { attemptAcknowledgmentResume } = await import('../lib/runtime/acknowledgment-resume');
    const result = await attemptAcknowledgmentResume(ackItem());
    expect(result.resumed).toBe(true);
    expect(resumeExecutionMock).toHaveBeenCalledTimes(1);
    expect(tables.workflow_acknowledgments[0].resumed_at).toBeTruthy();
  });

  it('does NOT call resumeExecution again once the execution has already moved past this node -- only catches up bookkeeping', async () => {
    tables.workflow_executions_v2[0].status = 'success';
    tables.workflow_executions_v2[0].current_node_id = 'Save to Airtable';
    const { attemptAcknowledgmentResume } = await import('../lib/runtime/acknowledgment-resume');
    const result = await attemptAcknowledgmentResume(ackItem());

    expect(result.resumed).toBe(true);
    if (result.resumed) expect(result.alreadyResumed).toBe(true);
    expect(resumeExecutionMock).not.toHaveBeenCalled();
    expect(tables.workflow_acknowledgments[0].resumed_at).toBeTruthy();
  });

  it('a resumeExecution() throw is recorded (resume_attempts incremented, last_resume_error set), never silently lost', async () => {
    resumeExecutionMock.mockRejectedValueOnce(new Error('boom'));
    const { attemptAcknowledgmentResume } = await import('../lib/runtime/acknowledgment-resume');
    const result = await attemptAcknowledgmentResume(ackItem());

    expect(result.resumed).toBe(false);
    expect(tables.workflow_acknowledgments[0].resumed_at).toBeNull();
    expect(tables.workflow_acknowledgments[0].resume_attempts).toBe(1);
    expect(tables.workflow_acknowledgments[0].last_resume_error).toMatch(/boom/);
  });

  it('Phase 9.9.3.2-equivalent regression: resumeExecution() is actually invoked even though node_id and node_name differ -- the real production shape', async () => {
    const { attemptAcknowledgmentResume } = await import('../lib/runtime/acknowledgment-resume');
    await attemptAcknowledgmentResume(ackItem({ node_id: 'node-1', node_name: 'Await acknowledgment' }));
    expect(resumeExecutionMock).toHaveBeenCalledTimes(1);
  });
});

describe('recoverStuckAcknowledgmentResumes — background sweep', () => {
  it('scans and recovers a stuck acknowledged/timed_out item with resumed_at still NULL', async () => {
    const { recoverStuckAcknowledgmentResumes } = await import('../lib/runtime/acknowledgment-resume');
    const result = await recoverStuckAcknowledgmentResumes({ graceMs: 1000 });

    expect(result.scanned).toBe(1);
    expect(result.recovered).toBe(1);
    expect(resumeExecutionMock).toHaveBeenCalledTimes(1);
  });

  it('does not sweep a row still within the grace window (avoids racing an in-flight request)', async () => {
    tables.workflow_acknowledgments[0].updated_at = new Date().toISOString();
    const { recoverStuckAcknowledgmentResumes } = await import('../lib/runtime/acknowledgment-resume');
    const result = await recoverStuckAcknowledgmentResumes({ graceMs: 10 * 60_000 });

    expect(result.scanned).toBe(0);
    expect(resumeExecutionMock).not.toHaveBeenCalled();
  });

  it('ignores rows already resumed (resumed_at set) and rows still pending', async () => {
    tables.workflow_acknowledgments.push(
      { ...tables.workflow_acknowledgments[0], id: 'ack-2', node_id: 'node-2', resumed_at: new Date().toISOString() },
      { ...tables.workflow_acknowledgments[0], id: 'ack-3', node_id: 'node-3', status: 'pending', resumed_at: null },
    );
    const { recoverStuckAcknowledgmentResumes } = await import('../lib/runtime/acknowledgment-resume');
    const result = await recoverStuckAcknowledgmentResumes({ graceMs: 1000 });

    expect(result.scanned).toBe(1); // only ack-1
  });

  it('duplicate/overlapping sweeps never call resumeExecution twice for the same item (claim CAS)', async () => {
    const { recoverStuckAcknowledgmentResumes } = await import('../lib/runtime/acknowledgment-resume');
    await Promise.all([
      recoverStuckAcknowledgmentResumes({ graceMs: 1000 }),
      recoverStuckAcknowledgmentResumes({ graceMs: 1000 }),
    ]);
    expect(resumeExecutionMock).toHaveBeenCalledTimes(1);
  });
});
