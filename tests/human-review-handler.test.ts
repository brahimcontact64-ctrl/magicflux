/**
 * Phase 9.9.2 — Durable Human Review / Approval Capability.
 *
 * humanReviewHandler (lib/workflow-runtime/node-handlers/human-review.ts) is
 * the second real, reusable human-in-the-loop capability: creates a durable
 * review record, pauses (status:'waiting', no nextRunAt -- never a timer
 * auto-resume), and on re-invocation after a decision exists, returns
 * success with _conditionBranch set to the decided outcome's index. All DB
 * access is mocked; no real Supabase calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NodeHandlerContext, EngineNode } from '../lib/workflow-runtime/types';

type Row = Record<string, unknown>;

function makeFakeReviewTable() {
  const rows: Row[] = [];
  return {
    rows,
    from(table: string) {
      if (table !== 'workflow_review_items') throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(col: string, val: unknown) { filters.push([col, val]); return builder; },
            async maybeSingle() {
              const match = rows.find((r) => filters.every(([c, v]) => r[c] === v));
              return { data: match ?? null, error: null };
            },
          };
          return builder;
        },
        insert(row: Row) {
          const exists = rows.some((r) => r.execution_id === row.execution_id && r.node_id === row.node_id);
          if (exists) {
            return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint' } });
          }
          rows.push({ id: `review-${rows.length + 1}`, status: 'pending', decision_outcome: null, ...row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

let fakeDb: ReturnType<typeof makeFakeReviewTable>;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => fakeDb,
}));

function baseContext(overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return {
    mode: 'live',
    integrations: [],
    sampleData: {},
    previews: { emails: [], slackMessages: [], airtableRecords: [] },
    userId: 'user-1',
    workflowId: 'wf-1',
    executionId: 'exec-1',
    deploymentVersionId: null,
    ...overrides,
  };
}

function reviewNode(overrides: Record<string, unknown> = {}): EngineNode {
  return {
    id: '2',
    name: 'Review Lead',
    type: 'magicflux-nodes.humanReview',
    parameters: { instruction: 'Review this low-confidence lead.', ...overrides },
  };
}

beforeEach(() => {
  fakeDb = makeFakeReviewTable();
});

describe('humanReviewHandler', () => {
  it('review node pauses execution and creates a durable review record on first run', async () => {
    const { humanReviewHandler } = await import('../lib/workflow-runtime/node-handlers/human-review');
    const result = await humanReviewHandler(reviewNode(), { leadId: 'lead-1' }, baseContext());

    expect(result.status).toBe('waiting');
    expect(result.nextRunAt).toBeUndefined(); // never a timer -- only an explicit decision resumes this
    expect(fakeDb.rows).toHaveLength(1);
    expect(fakeDb.rows[0].status).toBe('pending');
    expect(fakeDb.rows[0].user_id).toBe('user-1');
    expect(fakeDb.rows[0].execution_id).toBe('exec-1');
    expect(fakeDb.rows[0].node_id).toBe('2');
  });

  it('a second invocation while still pending does not create a duplicate row', async () => {
    const { humanReviewHandler } = await import('../lib/workflow-runtime/node-handlers/human-review');
    await humanReviewHandler(reviewNode(), {}, baseContext());
    const result = await humanReviewHandler(reviewNode(), {}, baseContext());

    expect(result.status).toBe('waiting');
    expect(fakeDb.rows).toHaveLength(1);
  });

  it('approve resumes the correct branch (index 0, the default allowedOutcomes order)', async () => {
    const { humanReviewHandler } = await import('../lib/workflow-runtime/node-handlers/human-review');
    await humanReviewHandler(reviewNode(), { leadId: 'lead-1' }, baseContext());
    fakeDb.rows[0].status = 'approved';
    fakeDb.rows[0].decision_outcome = 'approve';

    const result = await humanReviewHandler(reviewNode(), { leadId: 'lead-1' }, baseContext());
    expect(result.status).toBe('success');
    const output = result.outputData as Record<string, unknown>;
    expect(output._conditionBranch).toBe(0);
    expect(output.decision).toBe('approve');
    expect(output.leadId).toBe('lead-1'); // original input preserved
  });

  it('reject resumes the correct branch (index 1)', async () => {
    const { humanReviewHandler } = await import('../lib/workflow-runtime/node-handlers/human-review');
    await humanReviewHandler(reviewNode(), {}, baseContext());
    fakeDb.rows[0].status = 'rejected';
    fakeDb.rows[0].decision_outcome = 'reject';

    const result = await humanReviewHandler(reviewNode(), {}, baseContext());
    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>)._conditionBranch).toBe(1);
  });

  it('a custom outcome resolves to its declared index in allowedOutcomes', async () => {
    const { humanReviewHandler } = await import('../lib/workflow-runtime/node-handlers/human-review');
    const node = reviewNode({ allowedOutcomes: ['approve', 'reject', 'escalate'] });
    await humanReviewHandler(node, {}, baseContext());
    fakeDb.rows[0].status = 'decided';
    fakeDb.rows[0].decision_outcome = 'escalate';

    const result = await humanReviewHandler(node, {}, baseContext());
    expect((result.outputData as Record<string, unknown>)._conditionBranch).toBe(2);
  });

  it('original input data is preserved unchanged alongside the decision fields', async () => {
    const { humanReviewHandler } = await import('../lib/workflow-runtime/node-handlers/human-review');
    const input = { leadId: 'lead-9', name: 'Priya', budget: 1000 };
    await humanReviewHandler(reviewNode(), input, baseContext());
    fakeDb.rows[0].status = 'approved';
    fakeDb.rows[0].decision_outcome = 'approve';

    const result = await humanReviewHandler(reviewNode(), input, baseContext());
    const output = result.outputData as Record<string, unknown>;
    expect(output.leadId).toBe('lead-9');
    expect(output.name).toBe('Priya');
    expect(output.budget).toBe(1000);
  });

  it('secrets in the input data are redacted from the persisted review context', async () => {
    const { humanReviewHandler } = await import('../lib/workflow-runtime/node-handlers/human-review');
    await humanReviewHandler(reviewNode(), { name: 'Jordan', api_key: 'sk-super-secret', password: 'hunter2' }, baseContext());

    const stored = JSON.stringify(fakeDb.rows[0].review_context);
    expect(stored).not.toContain('sk-super-secret');
    expect(stored).not.toContain('hunter2');
    expect(stored).toContain('Jordan');
  });

  it('test mode never creates a real review record and auto-approves', async () => {
    const { humanReviewHandler } = await import('../lib/workflow-runtime/node-handlers/human-review');
    const result = await humanReviewHandler(reviewNode(), { x: 1 }, baseContext({ mode: 'test' }));

    expect(result.status).toBe('simulated_success');
    expect(fakeDb.rows).toHaveLength(0);
  });

  it('fails closed with no context (missing userId/workflowId/executionId) rather than silently proceeding', async () => {
    const { humanReviewHandler } = await import('../lib/workflow-runtime/node-handlers/human-review');
    const result = await humanReviewHandler(reviewNode(), {}, baseContext({ userId: null }));

    expect(result.status).toBe('failed');
    expect(fakeDb.rows).toHaveLength(0);
  });
});
