import { createServiceClient } from '@/lib/supabase-server';

/**
 * Runtime usage metering — an append-only ledger (runtime_usage_events) of
 * every billable/observable fact the production runtime produces:
 * execution lifecycle transitions, node executions, HTTP provider calls, and
 * AI token consumption.
 *
 * Audit finding (Phase 8 report, confirmed still true at the start of
 * Phase 8.1): runtime_cost_records / cost-engine.ts exist from an earlier
 * phase but are never called from anywhere in the runtime — dead code, not
 * a stable system, so left alone rather than "fixed" (per "do not rewrite
 * stable systems" — inert code has no behavior to preserve). This module is
 * the actual wiring the audit found missing, built as a new, simpler ledger
 * rather than resurrecting the old one, since nothing depends on its shape.
 *
 * Every call site MUST supply a stable idempotencyKey unique to the fact
 * being recorded (e.g. `${executionId}:${eventType}` for an execution-level
 * fact, `${executionId}:${nodeId}:${attempt}:${eventType}` for a node-level
 * fact). recordUsageEvent() is safe to call from a retry, a resumed
 * execution, or an at-least-once queue redelivery — the DB unique
 * constraint on idempotency_key silently absorbs duplicates (23505),
 * matching the same insert-and-catch-23505 pattern already used by
 * lib/runtime/webhook-security.ts's nonce/replay check.
 */

export type UsageEventType =
  | 'execution_started'
  | 'execution_completed'
  | 'execution_failed'
  | 'node_executed'
  | 'http_request'
  | 'ai_tokens';

export type RecordUsageEventParams = {
  userId: string;
  workflowId: string;
  executionId: string;
  nodeId?: string;
  eventType: UsageEventType;
  quantity?: number;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
};

/** Records one usage fact. Never throws for a duplicate (idempotent); throws only on a genuine DB failure. */
export async function recordUsageEvent(params: RecordUsageEventParams): Promise<void> {
  const db = createServiceClient();
  const { error } = await db.from('runtime_usage_events').insert({
    user_id: params.userId,
    workflow_id: params.workflowId,
    execution_id: params.executionId,
    node_id: params.nodeId ?? null,
    event_type: params.eventType,
    quantity: params.quantity ?? 1,
    metadata: params.metadata ?? {},
    idempotency_key: params.idempotencyKey,
  });

  if (error && error.code !== '23505') {
    throw new Error(`Failed to record usage event (${params.eventType}): ${error.message}`);
  }
}

/** Fire-and-forget variant for hot paths (node execution) where a metering failure must never break the run. */
export function recordUsageEventSafe(params: RecordUsageEventParams): void {
  void recordUsageEvent(params).catch(() => undefined);
}

export type MonthlyUsageSummary = Record<UsageEventType, number>;

const EMPTY_SUMMARY: MonthlyUsageSummary = {
  execution_started: 0,
  execution_completed: 0,
  execution_failed: 0,
  node_executed: 0,
  http_request: 0,
  ai_tokens: 0,
};

/** Sums quantity per event_type for a user within the given month (defaults to the current calendar month). */
export async function getMonthlyUsageSummary(userId: string, month: Date = new Date()): Promise<MonthlyUsageSummary> {
  const db = createServiceClient();
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1).toISOString();
  const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString();

  const { data } = await db
    .from('runtime_usage_events')
    .select('event_type, quantity')
    .eq('user_id', userId)
    .gte('created_at', monthStart)
    .lt('created_at', monthEnd);

  const summary: MonthlyUsageSummary = { ...EMPTY_SUMMARY };
  for (const row of (data ?? []) as Array<{ event_type: UsageEventType; quantity: number }>) {
    summary[row.event_type] = (summary[row.event_type] ?? 0) + Number(row.quantity ?? 0);
  }
  return summary;
}

/** AI token usage specifically (the sum of the `ai_tokens` event_type), for quota enforcement. */
export async function getMonthlyAiTokenUsage(userId: string, month: Date = new Date()): Promise<number> {
  const summary = await getMonthlyUsageSummary(userId, month);
  return summary.ai_tokens;
}
