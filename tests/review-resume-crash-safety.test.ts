/**
 * Phase 9.9.2A — crash-window recovery for Human Review decision->resume.
 *
 * Covers the exact vulnerability the hardening review flagged: a decision
 * can be durably persisted (pending -> resume_pending) and then the
 * process/network can fail before resumeExecution() is ever called, or
 * while it's in flight. attemptReviewResume() / recoverStuckReviewResumes()
 * (lib/runtime/review-resume.ts) are what make that detectable and safely
 * retryable without duplicate side effects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  lte(col: string, val: unknown): this { this.filters.push([`__lte__${col}`, val]); return this; }
  select(): this { return this; }
  limit(): this { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every(([c, v]) => {
      if (c.startsWith('__lte__')) return String(r[c.slice(7)] ?? '') <= String(v);
      return r[c] === v;
    }));
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
    workflow_review_items: [
      {
        id: 'review-1',
        user_id: 'user-1',
        workflow_id: 'wf-1',
        execution_id: 'exec-1',
        node_id: 'node-1',
        // Phase 9.9.3.2 -- node_id ("node-1") and node_name ("Human
        // Review") are DELIBERATELY different values here, exactly like a
        // real generated node (id: "4", name: "Human Review"). The
        // duplicate-guard must compare against node_name (matching
        // workflow_executions_v2.current_node_id, which the engine always
        // populates with the node's name, never its id) -- a fixture where
        // they happened to be equal previously masked a real production
        // bug where the guard could never match and resumeExecution() was
        // never actually called.
        node_name: 'Human Review',
        deployment_version_id: null,
        status: 'resume_pending',
        decision_outcome: 'approve',
        allowed_outcomes: ['approve', 'reject'],
        mode: 'live',
        resume_attempts: 0,
        updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    ],
    workflow_executions_v2: [
      { id: 'exec-1', status: 'waiting', current_node_id: 'Human Review' },
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

function reviewItem(overrides: Partial<Row> = {}) {
  return {
    id: 'review-1',
    user_id: 'user-1',
    workflow_id: 'wf-1',
    execution_id: 'exec-1',
    node_id: 'node-1',
    node_name: 'Human Review',
    deployment_version_id: null,
    mode: 'live' as const,
    resume_attempts: 0,
    ...overrides,
  };
}

describe('attemptReviewResume — crash-window recovery', () => {
  it('decision persisted, resume throws: the row stays resume_pending with the error recorded, never silently lost', async () => {
    resumeExecutionMock.mockRejectedValueOnce(new Error('boom: worker crashed mid-resume'));
    const { attemptReviewResume } = await import('../lib/runtime/review-resume');

    const outcome = await attemptReviewResume(reviewItem());

    expect(outcome.resumed).toBe(false);
    expect(tables.workflow_review_items[0].status).toBe('resume_pending'); // NOT silently marked resumed
    expect(tables.workflow_review_items[0].last_resume_error).toMatch(/boom/);
    expect(tables.workflow_review_items[0].resume_attempts).toBe(1);
  });

  it('retry/recovery later resumes the same execution: a second attempt (execution still genuinely waiting here) succeeds', async () => {
    resumeExecutionMock.mockRejectedValueOnce(new Error('transient failure'));
    const { attemptReviewResume } = await import('../lib/runtime/review-resume');

    const first = await attemptReviewResume(reviewItem());
    expect(first.resumed).toBe(false);

    // Execution is still parked exactly at this node (the crash never
    // actually progressed it) -- the retry is expected to succeed.
    const second = await attemptReviewResume(reviewItem({ resume_attempts: 1 }));
    expect(second.resumed).toBe(true);
    expect(tables.workflow_review_items[0].status).toBe('resumed');
    expect(resumeExecutionMock).toHaveBeenCalledTimes(2);
  });

  it('no duplicate side effects after duplicate recovery: once the execution has moved past this node, a second attempt does NOT call resumeExecution again', async () => {
    const { attemptReviewResume } = await import('../lib/runtime/review-resume');

    const first = await attemptReviewResume(reviewItem());
    expect(first.resumed).toBe(true);
    expect(resumeExecutionMock).toHaveBeenCalledTimes(1);

    // Simulate the engine having genuinely progressed past the review node
    // as a result of that successful resume (exactly what
    // runtime/workflow-engine.ts does: current_node_id advances the
    // instant the next node starts, status becomes something other than
    // 'waiting'-at-this-node).
    tables.workflow_executions_v2[0].status = 'success';
    tables.workflow_executions_v2[0].current_node_id = 'Some Later Node';
    // Simulate the row falling back to resume_pending somehow (e.g. the
    // final bookkeeping update itself failed) -- recovery must still be safe.
    tables.workflow_review_items[0].status = 'resume_pending';

    const second = await attemptReviewResume(reviewItem());
    expect(second.resumed).toBe(true);
    expect(tables.workflow_review_items[0].status).toBe('resumed');
    // The critical assertion: resumeExecution was NOT invoked a second time.
    expect(resumeExecutionMock).toHaveBeenCalledTimes(1);
  });

  it('a workflow that cannot be resolved fails closed with a recorded error, not a thrown exception', async () => {
    tables.workflows = [];
    const { attemptReviewResume } = await import('../lib/runtime/review-resume');

    const outcome = await attemptReviewResume(reviewItem());
    expect(outcome.resumed).toBe(false);
    expect(tables.workflow_review_items[0].last_resume_error).toMatch(/not found/i);
    expect(resumeExecutionMock).not.toHaveBeenCalled();
  });

  it('Phase 9.9.3.2 regression: resumeExecution() is actually invoked even though node_id ("node-1") and node_name ("Human Review") are different values -- the real production shape', async () => {
    // Before the fix, `stillAtThisNode` compared current_node_id against
    // node_id -- since the engine always stores current_node_id as the
    // node's NAME, this comparison ("Human Review" === "node-1") was always
    // false, so a real decision through app/api/reviews/[id]/decide/route.ts
    // would silently mark the row "resumed" WITHOUT ever calling
    // resumeExecution(), leaving the actual workflow execution permanently
    // parked at Human Review. This is the single most important assertion
    // in this suite: a real decision must actually resume the execution.
    const { attemptReviewResume } = await import('../lib/runtime/review-resume');
    const outcome = await attemptReviewResume(reviewItem());

    expect(resumeExecutionMock).toHaveBeenCalledTimes(1);
    expect(outcome.resumed).toBe(true);
    expect(outcome).not.toHaveProperty('alreadyResumed', true);
  });
});

describe('recoverStuckReviewResumes — background sweep', () => {
  it('scans and recovers a stale resume_pending item', async () => {
    const { recoverStuckReviewResumes } = await import('../lib/runtime/review-resume');
    const result = await recoverStuckReviewResumes({ graceMs: 1000 });

    expect(result.scanned).toBe(1);
    expect(result.claimed).toBe(1);
    expect(result.recovered).toBe(1);
    expect(tables.workflow_review_items[0].status).toBe('resumed');
  });

  it('does not sweep a row still within the grace window (avoids racing an in-flight request)', async () => {
    tables.workflow_review_items[0].updated_at = new Date().toISOString(); // just updated
    const { recoverStuckReviewResumes } = await import('../lib/runtime/review-resume');
    const result = await recoverStuckReviewResumes({ graceMs: 10 * 60_000 });

    expect(result.scanned).toBe(0);
    expect(resumeExecutionMock).not.toHaveBeenCalled();
  });

  it('ignores rows that are already pending or resumed (only resume_pending is ever swept)', async () => {
    tables.workflow_review_items[0].status = 'pending';
    const { recoverStuckReviewResumes } = await import('../lib/runtime/review-resume');
    const result = await recoverStuckReviewResumes({ graceMs: 1000 });

    expect(result.scanned).toBe(0);
    expect(resumeExecutionMock).not.toHaveBeenCalled();
  });
});
