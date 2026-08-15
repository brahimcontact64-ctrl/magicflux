/**
 * Phase 8.1 — Usage metering ledger (lib/runtime/usage-metering.ts).
 *
 * Proves: idempotent recording (retry/redelivery-safe, no double counting),
 * per-user/workflow/execution/node scoping, and monthly aggregation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

class FakeUsageTable {
  constructor(private rows: Row[]) {}
  insert(row: Row) {
    const conflict = this.rows.some((r) => r.idempotency_key === row.idempotency_key);
    if (conflict) {
      return { then: (resolve: (v: { error: { code: string } }) => unknown) => Promise.resolve(resolve({ error: { code: '23505' } })) };
    }
    this.rows.push({ ...row, created_at: row.created_at ?? new Date().toISOString() });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
  select() {
    const rows = this.rows;
    const filters: Array<[string, unknown]> = [];
    const gteFilters: Array<[string, unknown]> = [];
    const ltFilters: Array<[string, unknown]> = [];
    const api = {
      eq(col: string, val: unknown) { filters.push([col, val]); return api; },
      gte(col: string, val: unknown) { gteFilters.push([col, val]); return api; },
      lt(col: string, val: unknown) { ltFilters.push([col, val]); return api; },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        const matched = rows.filter((r) =>
          filters.every(([c, v]) => r[c] === v) &&
          gteFilters.every(([c, v]) => String(r[c]) >= String(v)) &&
          ltFilters.every(([c, v]) => String(r[c]) < String(v)));
        return Promise.resolve(resolve({ data: matched.map((r) => ({ ...r })), error: null }));
      },
    };
    return api;
  }
}

let rows: Row[];

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => {
      if (name !== 'runtime_usage_events') throw new Error(`unexpected table ${name}`);
      return new FakeUsageTable(rows);
    },
  })),
}));

beforeEach(() => { rows = []; });

describe('recordUsageEvent', () => {
  it('records a usage event', async () => {
    const { recordUsageEvent } = await import('../lib/runtime/usage-metering');
    await recordUsageEvent({
      userId: 'user-1', workflowId: 'wf-1', executionId: 'exec-1', eventType: 'execution_started',
      idempotencyKey: 'exec-1:execution_started',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('execution_started');
  });

  it('is idempotent: recording the same idempotencyKey twice does not double-insert (retry-safe)', async () => {
    const { recordUsageEvent } = await import('../lib/runtime/usage-metering');
    const params = {
      userId: 'user-1', workflowId: 'wf-1', executionId: 'exec-1', eventType: 'node_executed' as const,
      idempotencyKey: 'exec-1:node-a:1:node_executed',
    };
    await recordUsageEvent(params);
    await expect(recordUsageEvent(params)).resolves.toBeUndefined(); // does not throw
    expect(rows).toHaveLength(1);
  });

  it('a resumed execution re-emitting the same node attempt does not double-count', async () => {
    const { recordUsageEvent } = await import('../lib/runtime/usage-metering');
    // Same executionId + nodeId + attempt, as would happen if a resume replays a step.
    const key = 'exec-1:node-a:1:node_executed';
    await recordUsageEvent({ userId: 'user-1', workflowId: 'wf-1', executionId: 'exec-1', nodeId: 'node-a', eventType: 'node_executed', idempotencyKey: key });
    await recordUsageEvent({ userId: 'user-1', workflowId: 'wf-1', executionId: 'exec-1', nodeId: 'node-a', eventType: 'node_executed', idempotencyKey: key });
    await recordUsageEvent({ userId: 'user-1', workflowId: 'wf-1', executionId: 'exec-1', nodeId: 'node-a', eventType: 'node_executed', idempotencyKey: key });
    expect(rows.filter((r) => r.idempotency_key === key)).toHaveLength(1);
  });

  it('scopes records by user, workflow, execution, and node', async () => {
    const { recordUsageEvent } = await import('../lib/runtime/usage-metering');
    await recordUsageEvent({
      userId: 'user-1', workflowId: 'wf-1', executionId: 'exec-1', nodeId: 'node-a', eventType: 'ai_tokens',
      quantity: 42, metadata: { prompt_tokens: 20, completion_tokens: 22 }, idempotencyKey: 'exec-1:node-a:1:ai_tokens',
    });
    expect(rows[0]).toMatchObject({ user_id: 'user-1', workflow_id: 'wf-1', execution_id: 'exec-1', node_id: 'node-a', quantity: 42 });
  });
});

describe('getMonthlyUsageSummary', () => {
  it('sums quantity per event_type for the given month, scoped to the user', async () => {
    const { recordUsageEvent, getMonthlyUsageSummary } = await import('../lib/runtime/usage-metering');
    const now = new Date();
    await recordUsageEvent({ userId: 'user-1', workflowId: 'wf-1', executionId: 'e1', eventType: 'execution_completed', quantity: 1200, idempotencyKey: 'k1' });
    await recordUsageEvent({ userId: 'user-1', workflowId: 'wf-1', executionId: 'e2', eventType: 'execution_completed', quantity: 800, idempotencyKey: 'k2' });
    await recordUsageEvent({ userId: 'user-1', workflowId: 'wf-1', executionId: 'e1', eventType: 'ai_tokens', quantity: 100, idempotencyKey: 'k3' });
    await recordUsageEvent({ userId: 'user-2', workflowId: 'wf-2', executionId: 'e3', eventType: 'execution_completed', quantity: 999, idempotencyKey: 'k4' });

    const summary = await getMonthlyUsageSummary('user-1', now);
    expect(summary.execution_completed).toBe(2000);
    expect(summary.ai_tokens).toBe(100);
    expect(summary.node_executed).toBe(0);
  });

  it('excludes events from a different month', async () => {
    const { recordUsageEvent, getMonthlyUsageSummary } = await import('../lib/runtime/usage-metering');
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString();
    rows.push({ user_id: 'user-1', workflow_id: 'wf-1', execution_id: 'e1', event_type: 'ai_tokens', quantity: 500, idempotency_key: 'old', created_at: lastMonth });

    const summary = await getMonthlyUsageSummary('user-1', now);
    expect(summary.ai_tokens).toBe(0);
  });

  it('getMonthlyAiTokenUsage returns just the ai_tokens sum', async () => {
    const { recordUsageEvent, getMonthlyAiTokenUsage } = await import('../lib/runtime/usage-metering');
    await recordUsageEvent({ userId: 'user-1', workflowId: 'wf-1', executionId: 'e1', eventType: 'ai_tokens', quantity: 150, idempotencyKey: 'k1' });
    await recordUsageEvent({ userId: 'user-1', workflowId: 'wf-1', executionId: 'e1', eventType: 'ai_tokens', quantity: 50, idempotencyKey: 'k2' });
    expect(await getMonthlyAiTokenUsage('user-1')).toBe(200);
  });
});
