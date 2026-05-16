import { createServiceClient } from '@/lib/supabase-server';

export type AgentName = 'planner' | 'integration' | 'deploy' | 'monitoring' | 'recovery';

export function agentForTool(toolName: string): AgentName {
  if (['validate_credential', 'request_credential'].includes(toolName)) return 'integration';
  if (['deploy_workflow_to_n8n', 'activate_workflow', 'generate_workflow_json'].includes(toolName)) return 'deploy';
  if (['get_workflow_status', 'get_execution_logs', 'test_workflow'].includes(toolName)) return 'monitoring';
  return 'planner';
}

export async function recordAgentActionEvent(params: {
  userId: string | null;
  sessionId: string;
  eventType: string;
  actionName?: string;
  status?: 'info' | 'success' | 'warning' | 'error';
  detail?: string;
  workflowId?: string;
  workflowUrl?: string;
  durationMs?: number;
  retryCount?: number;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!params.userId) return;

  const db = createServiceClient();
  await db.from('agent_action_events').insert({
    user_id: params.userId,
    session_id: params.sessionId,
    agent_name: params.actionName ? agentForTool(params.actionName) : 'planner',
    event_type: params.eventType,
    action_name: params.actionName ?? null,
    status: params.status ?? 'info',
    detail: params.detail ?? null,
    workflow_id: params.workflowId ?? null,
    workflow_url: params.workflowUrl ?? null,
    duration_ms: params.durationMs ?? null,
    retry_count: params.retryCount ?? 0,
    error_code: params.errorCode ?? null,
    metadata: params.metadata ?? {},
    created_at: new Date().toISOString(),
  });
}

const MODEL_PRICING_PER_1K: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-4.1': { input: 0.01, output: 0.03 },
};

function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING_PER_1K[model] ?? MODEL_PRICING_PER_1K['gpt-4o'];
  const inputCost = (promptTokens / 1000) * pricing.input;
  const outputCost = (completionTokens / 1000) * pricing.output;
  return Number((inputCost + outputCost).toFixed(6));
}

export async function recordAiUsage(params: {
  userId: string | null;
  sessionId: string;
  workflowId?: string;
  provider: string;
  model: string;
  agentName: AgentName;
  promptTokens: number;
  completionTokens: number;
  metadata?: Record<string, unknown>;
}): Promise<{ estimatedCostUsd: number }> {
  const totalTokens = params.promptTokens + params.completionTokens;
  const estimatedCostUsd = estimateCostUsd(params.model, params.promptTokens, params.completionTokens);

  if (params.userId) {
    const db = createServiceClient();
    await db.from('agent_ai_usage').insert({
      user_id: params.userId,
      session_id: params.sessionId,
      workflow_id: params.workflowId ?? null,
      provider: params.provider,
      model: params.model,
      agent_name: params.agentName,
      prompt_tokens: params.promptTokens,
      completion_tokens: params.completionTokens,
      total_tokens: totalTokens,
      estimated_cost_usd: estimatedCostUsd,
      metadata: params.metadata ?? {},
      created_at: new Date().toISOString(),
    });
  }

  return { estimatedCostUsd };
}

export async function getObservabilitySummary(userId: string): Promise<Record<string, unknown>> {
  const db = createServiceClient();

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

  const [eventsRes, aiUsageRes, deployRes, runtimeEventsRes, queueRes] = await Promise.all([
    db
      .from('agent_action_events')
      .select('status, created_at', { count: 'exact' })
      .eq('user_id', userId)
      .gte('created_at', since24h)
      .limit(500),
    db
      .from('agent_ai_usage')
      .select('total_tokens, estimated_cost_usd, provider, model, created_at')
      .eq('user_id', userId)
      .gte('created_at', startOfMonth)
      .limit(2000),
    db
      .from('agent_deploy_transactions')
      .select('status, created_at')
      .eq('user_id', userId)
      .gte('created_at', since24h)
      .limit(500),
    db
      .from('runtime_events')
      .select('event_type, severity, created_at')
      .eq('user_id', userId)
      .gte('created_at', since24h)
      .limit(2000),
    db
      .from('runtime_queue_jobs')
      .select('status, queued_at, started_at, completed_at, created_at')
      .eq('user_id', userId)
      .gte('created_at', since24h)
      .limit(2000),
  ]);

  const events = eventsRes.data ?? [];
  const aiUsage = aiUsageRes.data ?? [];
  const deploys = deployRes.data ?? [];
  const runtimeEvents = runtimeEventsRes.data ?? [];
  const queueRows = queueRes.data ?? [];

  const failures24h = events.filter((e) => e.status === 'error').length;
  const retries24h = events.filter((e) => String(e.status) === 'warning').length;
  const totalTokens = aiUsage.reduce((sum, row) => sum + Number(row.total_tokens ?? 0), 0);
  const totalCostUsd = Number(aiUsage.reduce((sum, row) => sum + Number(row.estimated_cost_usd ?? 0), 0).toFixed(4));

  const providerUsage = aiUsage.reduce<Record<string, { tokens: number; costUsd: number }>>((acc, row) => {
    const key = String(row.provider ?? 'unknown');
    if (!acc[key]) acc[key] = { tokens: 0, costUsd: 0 };
    acc[key].tokens += Number(row.total_tokens ?? 0);
    acc[key].costUsd += Number(row.estimated_cost_usd ?? 0);
    return acc;
  }, {});

  const runtimeByType = runtimeEvents.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.event_type ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const queueByStatus = queueRows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.status ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const waitTimes = queueRows
    .filter((row) => row.queued_at && row.started_at)
    .map((row) => {
      const queued = new Date(String(row.queued_at)).getTime();
      const started = new Date(String(row.started_at)).getTime();
      return Math.max(0, started - queued);
    });

  const avgQueueWaitMs = waitTimes.length > 0
    ? Math.round(waitTimes.reduce((sum, v) => sum + v, 0) / waitTimes.length)
    : 0;

  return {
    executions24h: events.length,
    failures24h,
    retries24h,
    deployments24h: deploys.length,
    deploymentFailures24h: deploys.filter((d) => d.status === 'failed').length,
    totalTokensMonth: totalTokens,
    totalCostUsdMonth: totalCostUsd,
    providerUsage,
    runtimeEvents24h: runtimeEvents.length,
    runtimeEventTypes24h: runtimeByType,
    queueJobs24h: queueRows.length,
    queueStatus24h: queueByStatus,
    queueAvgWaitMs24h: avgQueueWaitMs,
  };
}

export async function getSessionTimeline(userId: string, sessionId: string): Promise<Array<Record<string, unknown>>> {
  const db = createServiceClient();
  const { data } = await db
    .from('agent_action_events')
    .select('event_type, action_name, status, detail, workflow_id, workflow_url, duration_ms, retry_count, error_code, metadata, created_at')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(500);
  return (data ?? []) as Array<Record<string, unknown>>;
}
