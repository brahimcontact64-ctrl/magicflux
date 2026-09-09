/**
 * Phase 9.6 Section 4 — getBetaFunnelMetrics() must derive every number
 * from existing canonical tables (no vanity metrics, nothing invented),
 * degrade gracefully when product_feedback doesn't exist yet (the
 * proposed migration hasn't been applied), and never touch anything
 * beyond aggregate counts (no secrets, no workflow payloads).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let feedbackTableExists: boolean;
let listUsersPages: Array<{ users: Array<{ id: string }> }>;

function countableTable(rows: Row[]) {
  const filters: Array<[string, unknown]> = [];
  const api = {
    select: () => api,
    eq(col: string, val: unknown) { filters.push([col, val]); return api; },
    gte: () => api,
    not: () => api,
    async limit() {
      const matched = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
      return { data: matched, error: null, count: matched.length };
    },
    then(resolve: (v: { data: Row[]; error: null; count: number }) => unknown) {
      const matched = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
      return Promise.resolve(resolve({ data: matched, error: null, count: matched.length })).then(() => undefined);
    },
  };
  return api;
}

function makeFakeDb() {
  return {
    auth: {
      admin: {
        async listUsers({ page }: { page: number; perPage: number }) {
          const pageData = listUsersPages[page - 1] ?? { users: [] };
          return { data: pageData, error: null };
        },
      },
    },
    from(table: string) {
      if (table === 'product_feedback' && !feedbackTableExists) {
        return {
          select: () => ({
            async limit() { return { data: null, error: { code: '42P01', message: 'relation "product_feedback" does not exist' } }; },
          }),
        };
      }
      return countableTable(tables[table] ?? []);
    },
  };
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeDb()),
}));

beforeEach(() => {
  vi.clearAllMocks();
  feedbackTableExists = true;
  listUsersPages = [{ users: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] }];
  tables = {
    user_profiles: [
      { id: 'u1', onboarding_complete: true },
      { id: 'u2', onboarding_complete: true },
      { id: 'u3', onboarding_complete: false },
    ],
    workflows: [{ id: 'w1' }, { id: 'w2' }],
    agent_action_events: [
      { id: 'e1', action_name: 'generate_workflow_json', status: 'success', user_id: 'u1', created_at: new Date().toISOString() },
      { id: 'e2', action_name: 'generate_workflow_json', status: 'error', user_id: 'u2', created_at: new Date().toISOString() },
      { id: 'e3', action_name: 'activate_workflow', status: 'success', user_id: 'u1', created_at: new Date().toISOString() },
    ],
    workflow_executions_v2: [
      { id: 'x1', mode: 'test', status: 'success' },
      { id: 'x2', mode: 'live', status: 'success' },
      { id: 'x3', mode: 'live', status: 'failed' },
    ],
    deployment_versions: [{ id: 'dv1' }],
    product_feedback: [{ rating: 5 }, { rating: 3 }, { rating: null }],
  };
});

describe('getBetaFunnelMetrics', () => {
  it('derives every funnel number from the expected existing table/filter, not an invented value', async () => {
    const { getBetaFunnelMetrics } = await import('../lib/analytics/beta-metrics');
    const metrics = await getBetaFunnelMetrics();

    expect(metrics.signups).toBe(3);
    expect(metrics.onboardingCompleted).toBe(2);
    expect(metrics.workflowsCreated).toBe(2);
    expect(metrics.aiGenerations).toBe(1); // only the successful generate_workflow_json row
    expect(metrics.validationsOrTests).toBe(1); // only mode:'test'
    expect(metrics.activations).toBe(1);
    expect(metrics.executionsTotal).toBe(3);
    expect(metrics.executionsSuccessful).toBe(2);
    expect(metrics.executionsFailed).toBe(1);
  });

  it('feedback stats reflect real rows and exclude null ratings from the average', async () => {
    const { getBetaFunnelMetrics } = await import('../lib/analytics/beta-metrics');
    const metrics = await getBetaFunnelMetrics();

    expect(metrics.feedbackCount).toBe(3);
    expect(metrics.feedbackAvgRating).toBe(4); // (5 + 3) / 2, null excluded
    expect(metrics.feedbackTableMissing).toBe(false);
  });

  it('degrades gracefully (0/null, not a thrown error) when product_feedback does not exist yet', async () => {
    feedbackTableExists = false;
    const { getBetaFunnelMetrics } = await import('../lib/analytics/beta-metrics');
    const metrics = await getBetaFunnelMetrics();

    expect(metrics.feedbackCount).toBe(0);
    expect(metrics.feedbackAvgRating).toBeNull();
    expect(metrics.feedbackTableMissing).toBe(true);
    // the rest of the funnel is unaffected by the missing feedback table
    expect(metrics.workflowsCreated).toBe(2);
  });

  it('never returns anything beyond counts/averages -- no row-level payloads leak through', async () => {
    const { getBetaFunnelMetrics } = await import('../lib/analytics/beta-metrics');
    const metrics = await getBetaFunnelMetrics();
    const values = Object.values(metrics);
    for (const v of values) {
      expect(typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || v === null).toBe(true);
    }
  });
});
