/**
 * Phase 9.9.3.2 — Human Review decision-authority, engine-level proof.
 *
 * Drives the REAL WorkflowEngine + ExecutionManager (runWorkflowExecution /
 * resumeWorkflowExecution) against a mocked Supabase client, using the
 * PREFERRED direct-port topology (HUMAN DECISION AUTHORITY CONTRACT,
 * lib/agent/executor.ts): Human Review's own outcome ports feed the exact
 * same terminal action nodes the normal (unreviewed) classification chain
 * uses, with no re-check IF node in between.
 *
 * Also proves the companion runtime fix in runtime/execution-manager.ts:
 * resumeExecution() previously reconstructed a parked node's input from the
 * CALLER's empty {} placeholder rather than its own pre-pause checkpoint
 * snapshot, silently discarding every field (not just the AI classification)
 * on every human review resume.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '00000000-0000-4000-8000-0000000000f9';
const WORKFLOW_ID = 'wf-decision-authority-test';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private pendingPatch: Row | null = null;
  constructor(private rows: Row[], private op: 'select' | 'delete' = 'select') {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(_cols?: string): this { return this; }
  limit(n: number): this { this.limitN = n; return this; }
  order(col: string, opts?: { ascending?: boolean }): this { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  update(patch: Row): this { this.pendingPatch = patch; return this; }
  private matchedIndexes(): number[] {
    const idx: number[] = [];
    this.rows.forEach((r, i) => { if (this.filters.every(([c, v]) => r[c] === v)) idx.push(i); });
    return idx;
  }
  private matched(): Row[] {
    if (this.pendingPatch) for (const i of this.matchedIndexes()) Object.assign(this.rows[i], this.pendingPatch);
    let result = this.matchedIndexes().map((i) => this.rows[i]);
    if (this.orderCol) {
      const col = this.orderCol;
      result = [...result].sort((a, b) => {
        const av = a[col] as string | number; const bv = b[col] as string | number;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.limitN !== null) result = result.slice(0, this.limitN);
    return result;
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.op === 'delete') {
      for (let i = this.rows.length - 1; i >= 0; i--) if (this.filters.every(([c, v]) => this.rows[i][c] === v)) this.rows.splice(i, 1);
      return { data: null, error: null };
    }
    const m = this.matched();
    return { data: m[0] ?? null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    if (this.op === 'delete') {
      const removeIdx = new Set(this.matchedIndexes());
      const kept = this.rows.filter((_, i) => !removeIdx.has(i));
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
  // update() returns a query scoped to THIS table's own row array (not a
  // detached copy), so the patch -- applied lazily the moment the query is
  // actually consumed via either .then() (implicit await) or .maybeSingle()
  // (explicit, as runtime/runtime-state.ts's setExecutionState() chains
  // .update(...).select(...).maybeSingle()) -- lands on the real rows.
  update(patch: Row): FakeQuery {
    return new FakeQuery(this.rows, 'select').update(patch);
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
  getUserFromRequest: vi.fn(),
  getUserFromAccessToken: vi.fn(),
  getBearerToken: vi.fn(),
}));

function stepNames(status?: string): string[] {
  const steps = (fakeDb.tables.get('workflow_execution_steps') ?? []) as Array<{ node_name: string; status: string }>;
  return steps.filter((s) => !status || s.status === status).map((s) => s.node_name);
}

function stepInputData(nodeName: string): Record<string, unknown> | undefined {
  const steps = (fakeDb.tables.get('workflow_execution_steps') ?? []) as Array<{ node_name: string; status: string; input_data: unknown }>;
  const step = steps.find((s) => s.node_name === nodeName && s.status === 'success');
  return step?.input_data as Record<string, unknown> | undefined;
}

// PREFERRED topology: Human Review's own outcome ports feed the SAME
// terminal action nodes the normal (unreviewed) chain uses -- no re-check
// IF node re-reading "classification" after Human Review.
function preferredTopology(confidenceThreshold: number, allowedLabels: string[]): unknown {
  return {
    name: 'Lead routing (preferred human-decision-authority topology)',
    nodes: [
      { id: 'trigger', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
      {
        id: 'classifier', name: 'AI Classifier', type: 'magicflux-nodes.aiClassifier',
        parameters: { instruction: 'Classify the lead.', allowedLabels, outputField: 'classification', confidenceThreshold },
      },
      {
        id: 'needsReview', name: 'Needs Review?', type: 'n8n-nodes-base.if',
        parameters: { conditions: { boolean: [{ value1: '={{$json["needs_review"]}}', operation: 'equal', value2: true }] } },
      },
      { id: 'review', name: 'Human Review', type: 'magicflux-nodes.humanReview', parameters: { instruction: 'Confirm the lead classification.', allowedOutcomes: ['Hot', 'Warm', 'Cold'] } },
      { id: 'ifHot', name: 'If Hot', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Hot' }] } } },
      { id: 'ifWarm', name: 'If Warm', type: 'n8n-nodes-base.if', parameters: { conditions: { string: [{ value1: '={{$json["classification"]}}', operation: 'equal', value2: 'Warm' }] } } },
      { id: 'hotAction', name: 'Hot Action', type: 'n8n-nodes-base.set', parameters: { fields: { routed: 'Hot' } } },
      { id: 'warmAction', name: 'Warm Action', type: 'n8n-nodes-base.set', parameters: { fields: { routed: 'Warm' } } },
      { id: 'coldAction', name: 'Cold Action', type: 'n8n-nodes-base.set', parameters: { fields: { routed: 'Cold' } } },
    ],
    connections: {
      Trigger: { main: [[{ node: 'AI Classifier' }]] },
      'AI Classifier': { main: [[{ node: 'Needs Review?' }]] },
      'Needs Review?': { main: [[{ node: 'Human Review' }], [{ node: 'If Hot' }]] },
      // PREFERRED: direct ports, no re-check IF after Human Review.
      'Human Review': { main: [[{ node: 'Hot Action' }], [{ node: 'Warm Action' }], [{ node: 'Cold Action' }]] },
      // Normal (unreviewed) chain -- unchanged, legitimately reads the real classification.
      'If Hot': { main: [[{ node: 'Hot Action' }], [{ node: 'If Warm' }]] },
      'If Warm': { main: [[{ node: 'Warm Action' }], [{ node: 'Cold Action' }]] },
    },
  };
}

async function runToWaiting(confidenceThreshold: number, allowedLabels: string[], input: Record<string, unknown>) {
  const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
  return runWorkflowExecution({
    workflowJson: preferredTopology(confidenceThreshold, allowedLabels),
    inputData: input,
    userId: USER_ID,
    workflowId: WORKFLOW_ID,
    mode: 'live',
  });
}

async function decideAndResume(executionId: string, outcome: string, allowedLabels: string[]) {
  const reviewRows = fakeDb.tables.get('workflow_review_items') as Row[];
  reviewRows[0].status = 'resume_pending';
  reviewRows[0].decision_outcome = outcome;

  const { resumeWorkflowExecution } = await import('../lib/workflow-runtime/engine');
  return resumeWorkflowExecution({
    executionId,
    userId: USER_ID,
    workflowId: WORKFLOW_ID,
    workflowJson: preferredTopology(0.9, allowedLabels),
    mode: 'live',
    inputData: {},
  });
}

// aiClassifierHandler only self-simulates deterministically in mode:'test'
// (fixed confidence 0.75, classification = allowedLabels[0] -- see
// lib/workflow-runtime/node-handlers/ai-classifier.ts). humanReviewHandler
// also self-simulates in 'test' mode, but ONLY auto-approves with
// allowedOutcomes[0] and never parks -- which cannot exercise a real
// pause/decide/resume cycle. So this suite runs the classifier in 'test'
// mode conceptually by using 'live' mode throughout but stubbing the
// classifier's own OpenAI dependency indirectly is unnecessary: instead we
// directly seed the review item as already-decided, which is exactly what
// a real crash-safe resume (lib/runtime/review-resume.ts) does -- the
// engine re-invokes Human Review, sees an existing non-pending row, and
// returns success with the decided branch, in 'live' mode, without ever
// calling OpenAI (the classifier already ran and its result flowed through
// once as part of getting to 'waiting').
describe('Human decision authority -- critical disagreement scenarios (live mode, mocked classifier)', () => {
  beforeEach(() => {
    fakeDb.tables.clear();
    vi.resetModules();
  });

  async function withMockedClassifier(classification: string, confidence: number, test: () => Promise<void>) {
    vi.doMock('../lib/workflow-runtime/node-handlers/ai-classifier', () => ({
      aiClassifierHandler: async (node: { parameters?: Record<string, unknown> }, inputData: unknown) => {
        const params = node.parameters ?? {};
        const threshold = typeof params.confidenceThreshold === 'number' ? params.confidenceThreshold : 0.6;
        const data = (inputData && typeof inputData === 'object') ? inputData as Record<string, unknown> : {};
        return {
          status: 'success',
          outputData: { ...data, classification, confidence, reason: 'mocked', needs_review: confidence < threshold },
          logs: ['mocked classifier'],
        };
      },
    }));
    await test();
    vi.doUnmock('../lib/workflow-runtime/node-handlers/ai-classifier');
  }

  it('AI says Hot, human selects Warm -> Warm Action runs, Hot Action and Cold Action never run', async () => {
    await withMockedClassifier('Hot', 0.4, async () => {
      const started = await runToWaiting(0.6, ['Hot', 'Warm', 'Cold'], { leadName: 'Acme Co' });
      expect(started.status).toBe('waiting');

      const resumed = await decideAndResume(started.executionId, 'Warm', ['Hot', 'Warm', 'Cold']);
      expect(resumed.status).toBe('success');

      const successNames = stepNames('success');
      expect(successNames).toContain('Warm Action');
      expect(successNames).not.toContain('Hot Action');
      expect(successNames).not.toContain('Cold Action');
      // Neither re-check IF node is even reached for the reviewed path.
      expect(successNames).not.toContain('If Hot');
      expect(successNames).not.toContain('If Warm');
    });
  });

  it('AI says Cold, human selects Hot -> Hot Action runs, Warm Action and Cold Action never run', async () => {
    await withMockedClassifier('Cold', 0.3, async () => {
      const started = await runToWaiting(0.6, ['Hot', 'Warm', 'Cold'], { leadName: 'Acme Co' });
      const resumed = await decideAndResume(started.executionId, 'Hot', ['Hot', 'Warm', 'Cold']);
      expect(resumed.status).toBe('success');

      const successNames = stepNames('success');
      expect(successNames).toContain('Hot Action');
      expect(successNames).not.toContain('Warm Action');
      expect(successNames).not.toContain('Cold Action');
    });
  });

  it('AI says Warm, human selects Cold -> Cold Action runs, Hot Action and Warm Action never run', async () => {
    await withMockedClassifier('Warm', 0.5, async () => {
      const started = await runToWaiting(0.6, ['Hot', 'Warm', 'Cold'], { leadName: 'Acme Co' });
      const resumed = await decideAndResume(started.executionId, 'Cold', ['Hot', 'Warm', 'Cold']);
      expect(resumed.status).toBe('success');

      const successNames = stepNames('success');
      expect(successNames).toContain('Cold Action');
      expect(successNames).not.toContain('Hot Action');
      expect(successNames).not.toContain('Warm Action');
    });
  });

  it('resume data integrity: the resumed action node still receives the original pre-pause lead data, not an empty object', async () => {
    await withMockedClassifier('Hot', 0.4, async () => {
      const started = await runToWaiting(0.6, ['Hot', 'Warm', 'Cold'], { leadName: 'Priya Corp' });
      await decideAndResume(started.executionId, 'Warm', ['Hot', 'Warm', 'Cold']);

      const warmActionInput = stepInputData('Warm Action');
      expect(warmActionInput?.leadName).toBe('Priya Corp');
    });
  });

  it('duplicate review resume causes no duplicate side effects (Warm Action runs exactly once)', async () => {
    await withMockedClassifier('Hot', 0.4, async () => {
      const started = await runToWaiting(0.6, ['Hot', 'Warm', 'Cold'], { leadName: 'Acme Co' });

      const reviewRows = fakeDb.tables.get('workflow_review_items') as Row[];
      reviewRows[0].status = 'resume_pending';
      reviewRows[0].decision_outcome = 'Warm';

      // Go through the REAL production dedup entrypoint
      // (lib/runtime/review-resume.ts's attemptReviewResume(), "the single
      // place this actually happens" per its own docstring, called from
      // app/api/reviews/[id]/decide/route.ts) rather than calling
      // resumeWorkflowExecution() directly -- that is where the crash-safe
      // compare-and-swap duplicate-side-effect guard actually lives.
      const workflowsTable = fakeDb.tables.get('workflows') ?? fakeDb.tables.set('workflows', []).get('workflows')!;
      workflowsTable.push({ id: WORKFLOW_ID, user_id: USER_ID, workflow_json: preferredTopology(0.6, ['Hot', 'Warm', 'Cold']) });

      const { attemptReviewResume } = await import('../lib/runtime/review-resume');
      const item = {
        id: String(reviewRows[0].id),
        user_id: USER_ID,
        workflow_id: WORKFLOW_ID,
        execution_id: started.executionId,
        node_id: String(reviewRows[0].node_id),
        node_name: String(reviewRows[0].node_name ?? ''),
        deployment_version_id: null,
        mode: 'live' as const,
      };

      const first = await attemptReviewResume(item);
      expect(first.resumed).toBe(true);
      expect(first).not.toHaveProperty('alreadyResumed', true);

      // A duplicate/retried resume attempt against the same already-decided
      // item (e.g. a retried decide request, or the recovery cron racing a
      // manual retry) -- simulate the CAS having re-armed resume_pending,
      // exactly as a real duplicate request would find it.
      reviewRows[0].status = 'resume_pending';
      const second = await attemptReviewResume(item);
      expect(second.resumed).toBe(true);

      const warmRuns = stepNames('success').filter((n) => n === 'Warm Action');
      expect(warmRuns).toHaveLength(1);
    });
  });

  it('normal high-confidence path is unchanged: no review, "If Hot" chain still reads the real classification', async () => {
    await withMockedClassifier('Hot', 0.9, async () => {
      const result = await runToWaiting(0.6, ['Hot', 'Warm', 'Cold'], { leadName: 'Acme Co' });
      expect(result.status).toBe('success');

      const successNames = stepNames('success');
      expect(successNames).toContain('If Hot');
      expect(successNames).toContain('Hot Action');
      expect(successNames).not.toContain('Human Review');
      expect(successNames).not.toContain('Warm Action');
      expect(successNames).not.toContain('Cold Action');
    });
  });
});
