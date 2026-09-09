import { createServiceClient } from '@/lib/supabase-server';

/**
 * Phase 9.6 Section 4 — Funding/Beta analytics.
 *
 * Every metric here is derived from existing canonical tables/events —
 * nothing is duplicated into a new metrics table, and no vanity metric is
 * invented. Each field's exact definition (so a future funding claim
 * built from this dashboard is reproducible) is documented at its
 * computation site below, not just in a comment here:
 *
 *   signups                 — total rows returned by Supabase Auth's admin
 *                              user list (auth.users, the actual source of
 *                              truth for account creation), paginated.
 *   onboardingCompleted     — count of user_profiles rows with
 *                              onboarding_complete = true (the same column
 *                              /api/onboarding/status already reads).
 *   workflowsCreated        — count of all rows in `workflows` (every
 *                              workflow ever created, draft or not).
 *   aiGenerations           — count of `agent_action_events` rows where
 *                              action_name = 'generate_workflow_json' and
 *                              status = 'success' (the real canonical
 *                              generation tool every /builder chat
 *                              conversation calls — lib/agent/executor.ts).
 *   validationsOrTests      — count of `workflow_executions_v2` rows with
 *                              mode = 'test' (every Test-run, Safe Preview
 *                              or Live Test execution the runtime records).
 *   activations             — count of all rows in `deployment_versions`
 *                              (one row is frozen per real activation by
 *                              lib/workflow/lifecycle.ts's activateWorkflow(),
 *                              regardless of later pause/resume/rollback).
 *   executionsTotal         — count of all rows in `workflow_executions_v2`
 *                              (every execution mode: test, live, webhook,
 *                              schedule).
 *   executionsSuccessful    — the same table filtered to status = 'success'.
 *   executionsFailed        — the same table filtered to status = 'failed'.
 *   activeBetaUsers7d/30d   — distinct user_id values with at least one
 *                              `agent_action_events` row (any tool call —
 *                              generation, test, activation, etc.) in the
 *                              trailing N days. Chosen over a raw login
 *                              count because it reflects users who actually
 *                              DID something with the product, not just
 *                              authenticated.
 *   feedbackCount/avgRating — count and average `rating` (1-5, null
 *                              excluded) from `product_feedback` — see
 *                              Section 3's proposed migration. Zero/None
 *                              until that table exists and has rows.
 *
 * Every query is a COUNT/aggregate — no user secrets, workflow_json
 * payloads, prompts, or credential data are ever read or returned here.
 */
export type BetaFunnelMetrics = {
  signups: number;
  onboardingCompleted: number;
  workflowsCreated: number;
  aiGenerations: number;
  validationsOrTests: number;
  activations: number;
  executionsTotal: number;
  executionsSuccessful: number;
  executionsFailed: number;
  activeBetaUsers7d: number;
  activeBetaUsers30d: number;
  feedbackCount: number;
  feedbackAvgRating: number | null;
  /** True if product_feedback doesn't exist yet (migration not applied) -- feedback fields are 0/null, not an error. */
  feedbackTableMissing: boolean;
  computedAt: string;
};

async function countSignups(db: ReturnType<typeof createServiceClient>): Promise<number> {
  // Supabase's admin user-list endpoint is paginated (max perPage is
  // provider-limited); walk pages until one comes back short of a full
  // page. Fine for a Beta-scale user count; would need a different
  // approach (or a maintained counter) at real scale.
  let total = 0;
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error || !data) break;
    total += data.users.length;
    if (data.users.length < perPage) break;
    page += 1;
    if (page > 20) break; // 20,000-user safety ceiling for this simple loop
  }
  return total;
}

async function countRows(
  db: ReturnType<typeof createServiceClient>,
  table: string,
  filters: Array<[string, unknown]> = [],
): Promise<number> {
  let query = db.from(table).select('id', { count: 'exact', head: true });
  for (const [col, val] of filters) query = query.eq(col, val);
  const { count, error } = await query;
  if (error) {
    console.error(`[beta-metrics:countRows:${table}]`, error);
    return 0;
  }
  return count ?? 0;
}

async function countDistinctActiveUsers(db: ReturnType<typeof createServiceClient>, sinceDays: number): Promise<number> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('agent_action_events')
    .select('user_id')
    .gte('created_at', since)
    .not('user_id', 'is', null)
    .limit(50_000);

  if (error || !data) return 0;
  return new Set((data as Array<{ user_id: string }>).map((r) => r.user_id)).size;
}

async function getFeedbackStats(db: ReturnType<typeof createServiceClient>): Promise<{ count: number; avgRating: number | null; missing: boolean }> {
  const { data, error } = await db.from('product_feedback').select('rating').limit(50_000);
  if (error) {
    // 42P01 = undefined_table (Postgres) -- the proposed migration hasn't been applied yet.
    const missing = (error as { code?: string }).code === '42P01' || /does not exist/i.test(String((error as { message?: string }).message ?? ''));
    return { count: 0, avgRating: null, missing };
  }
  const rows = (data ?? []) as Array<{ rating: number | null }>;
  const rated = rows.filter((r) => typeof r.rating === 'number');
  const avg = rated.length > 0 ? rated.reduce((s, r) => s + (r.rating as number), 0) / rated.length : null;
  return { count: rows.length, avgRating: avg, missing: false };
}

export async function getBetaFunnelMetrics(): Promise<BetaFunnelMetrics> {
  const db = createServiceClient();

  const [
    signups,
    onboardingCompleted,
    workflowsCreated,
    aiGenerations,
    validationsOrTests,
    activations,
    executionsTotal,
    executionsSuccessful,
    executionsFailed,
    activeBetaUsers7d,
    activeBetaUsers30d,
    feedback,
  ] = await Promise.all([
    countSignups(db),
    countRows(db, 'user_profiles', [['onboarding_complete', true]]),
    countRows(db, 'workflows'),
    countRows(db, 'agent_action_events', [['action_name', 'generate_workflow_json'], ['status', 'success']]),
    countRows(db, 'workflow_executions_v2', [['mode', 'test']]),
    countRows(db, 'deployment_versions'),
    countRows(db, 'workflow_executions_v2'),
    countRows(db, 'workflow_executions_v2', [['status', 'success']]),
    countRows(db, 'workflow_executions_v2', [['status', 'failed']]),
    countDistinctActiveUsers(db, 7),
    countDistinctActiveUsers(db, 30),
    getFeedbackStats(db),
  ]);

  return {
    signups,
    onboardingCompleted,
    workflowsCreated,
    aiGenerations,
    validationsOrTests,
    activations,
    executionsTotal,
    executionsSuccessful,
    executionsFailed,
    activeBetaUsers7d,
    activeBetaUsers30d,
    feedbackCount: feedback.count,
    feedbackAvgRating: feedback.avgRating,
    feedbackTableMissing: feedback.missing,
    computedAt: new Date().toISOString(),
  };
}
