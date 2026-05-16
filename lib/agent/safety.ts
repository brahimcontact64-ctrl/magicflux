import { createHash } from 'crypto';

import { createServiceClient } from '@/lib/supabase-server';
import { getToolExecutionPolicy } from '@/lib/runtime/tool-policy';

export type SafetyMode = 'safe' | 'staging' | 'production';

export type ExecutionPolicy = {
  mode: SafetyMode;
  sandboxEnabled: boolean;
  dryRunEnabled: boolean;
  requireApprovalHighRisk: boolean;
  maxToolCallsPerTurn: number;
  maxRoundsPerTurn: number;
  maxExternalActionsPerHour: number;
  maxDeploymentsPerHour: number;
  maxActivationPerHour: number;
  maxApiCallsPerMinute: number;
  duplicateWindowSeconds: number;
  maxRepeatSameAction: number;
  maxAiTokensPerDay: number;
  maxAiCostUsdPerDay: number;
};

export type GuardContext = {
  userId: string | null;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type GuardDecision = {
  allowed: boolean;
  mode: SafetyMode;
  reason?: string;
  blockCode?:
    | 'SAFE_MODE_BLOCK'
    | 'STAGING_SIDE_EFFECT_BLOCK'
    | 'APPROVAL_REQUIRED'
    | 'RATE_LIMITED'
    | 'DUPLICATE_PREVENTED'
    | 'LOOP_DETECTED'
    | 'QUOTA_EXCEEDED';
  requiresApproval?: boolean;
  approval?: {
    actionKey: string;
    actionType: string;
    reason: string;
    status: 'pending' | 'approved' | 'rejected' | 'expired';
  };
};

const DEFAULT_POLICY: ExecutionPolicy = {
  mode: 'safe',
  sandboxEnabled: true,
  dryRunEnabled: true,
  requireApprovalHighRisk: true,
  maxToolCallsPerTurn: 12,
  maxRoundsPerTurn: 8,
  maxExternalActionsPerHour: 120,
  maxDeploymentsPerHour: 20,
  maxActivationPerHour: 30,
  maxApiCallsPerMinute: 60,
  duplicateWindowSeconds: 120,
  maxRepeatSameAction: 3,
  maxAiTokensPerDay: 400000,
  maxAiCostUsdPerDay: 25,
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function buildActionKey(toolName: string, args: Record<string, unknown>): string {
  let keyArgs: Record<string, unknown> = args;

  // Deploy args can include large generated payloads that vary slightly between turns.
  // Approval should remain bound to the concrete deploy intent within the same session.
  if (toolName === 'deploy_workflow_to_n8n') {
    keyArgs = {
      workflow_id: args.workflow_id ?? null,
      mode: args.mode ?? null,
    };
  }

  if (toolName === 'activate_workflow') {
    keyArgs = {
      workflow_id: args.workflow_id ?? null,
      mode: args.mode ?? null,
    };
  }

  const raw = `${toolName}:${stableStringify(keyArgs)}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export function toolRequiresApproval(toolName: string, args: Record<string, unknown>): boolean {
  const toolPolicy = getToolExecutionPolicy(toolName);
  if (toolPolicy.requiresApproval) return true;
  if (toolName === 'deploy_workflow_to_n8n') {
    const name = String(args.workflow_name ?? '').toLowerCase();
    if (name.includes('cron') || name.includes('schedule')) return true;
  }
  return false;
}

export function isExternalSideEffectTool(toolName: string): boolean {
  const policy = getToolExecutionPolicy(toolName);
  return policy.riskLevel === 'medium' || policy.riskLevel === 'high';
}

export async function loadExecutionPolicy(userId: string | null, sessionId: string): Promise<ExecutionPolicy> {
  if (!userId) return DEFAULT_POLICY;

  const db = createServiceClient();
  const { data } = await db
    .from('agent_execution_policies')
    .select('*')
    .eq('user_id', userId)
    .or(`session_id.eq.${sessionId},session_id.is.null`)
    .order('session_id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return DEFAULT_POLICY;

  return {
    mode: (data.mode as SafetyMode) ?? DEFAULT_POLICY.mode,
    sandboxEnabled: Boolean(data.sandbox_enabled ?? DEFAULT_POLICY.sandboxEnabled),
    dryRunEnabled: Boolean(data.dry_run_enabled ?? DEFAULT_POLICY.dryRunEnabled),
    requireApprovalHighRisk: Boolean(data.require_approval_high_risk ?? DEFAULT_POLICY.requireApprovalHighRisk),
    maxToolCallsPerTurn: Number(data.max_tool_calls_per_turn ?? DEFAULT_POLICY.maxToolCallsPerTurn),
    maxRoundsPerTurn: Number(data.max_rounds_per_turn ?? DEFAULT_POLICY.maxRoundsPerTurn),
    maxExternalActionsPerHour: Number(data.max_external_actions_per_hour ?? DEFAULT_POLICY.maxExternalActionsPerHour),
    maxDeploymentsPerHour: Number(data.max_deployments_per_hour ?? DEFAULT_POLICY.maxDeploymentsPerHour),
    maxActivationPerHour: Number(data.max_activation_per_hour ?? DEFAULT_POLICY.maxActivationPerHour),
    maxApiCallsPerMinute: Number(data.max_api_calls_per_minute ?? DEFAULT_POLICY.maxApiCallsPerMinute),
    duplicateWindowSeconds: Number(data.duplicate_window_seconds ?? DEFAULT_POLICY.duplicateWindowSeconds),
    maxRepeatSameAction: Number(data.max_repeat_same_action ?? DEFAULT_POLICY.maxRepeatSameAction),
    maxAiTokensPerDay: Number(data.max_ai_tokens_per_day ?? DEFAULT_POLICY.maxAiTokensPerDay),
    maxAiCostUsdPerDay: Number(data.max_ai_cost_usd_per_day ?? DEFAULT_POLICY.maxAiCostUsdPerDay),
  };
}

async function countActionEvents(params: {
  userId: string;
  sessionId: string;
  toolName: string;
  seconds: number;
}): Promise<number> {
  const db = createServiceClient();
  const since = new Date(Date.now() - params.seconds * 1000).toISOString();
  const { count } = await db
    .from('agent_action_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', params.userId)
    .eq('session_id', params.sessionId)
    .eq('action_name', params.toolName)
    .gte('created_at', since);
  return count ?? 0;
}

async function getDailyAiUsageTotals(userId: string, sessionId: string): Promise<{ tokens: number; costUsd: number }> {
  const db = createServiceClient();
  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const { data } = await db
    .from('agent_ai_usage')
    .select('total_tokens, estimated_cost_usd')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .gte('created_at', since.toISOString())
    .limit(5000);

  const rows = data ?? [];
  return {
    tokens: rows.reduce((sum, row) => sum + Number(row.total_tokens ?? 0), 0),
    costUsd: rows.reduce((sum, row) => sum + Number(row.estimated_cost_usd ?? 0), 0),
  };
}

async function approvalStatus(params: {
  userId: string;
  sessionId: string;
  actionKey: string;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<NonNullable<GuardDecision['approval']>> {
  const db = createServiceClient();
  const { data: existing } = await db
    .from('agent_action_approvals')
    .select('*')
    .eq('user_id', params.userId)
    .eq('session_id', params.sessionId)
    .eq('action_key', params.actionKey)
    .limit(1)
    .maybeSingle();

  if (existing) {
    return {
      actionKey: params.actionKey,
      actionType: params.toolName,
      reason: String(existing.reason ?? 'Manual approval required'),
      status: existing.status,
    };
  }

  const reason = `Approval required for high-risk action: ${params.toolName}`;
  await db.from('agent_action_approvals').insert({
    user_id: params.userId,
    session_id: params.sessionId,
    action_key: params.actionKey,
    action_type: params.toolName,
    action_payload: params.args,
    reason,
    status: 'pending',
    expires_at: new Date(Date.now() + 1000 * 60 * 30).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  return {
    actionKey: params.actionKey,
    actionType: params.toolName,
    reason,
    status: 'pending',
  };
}

async function hasDuplicateLock(params: {
  userId: string;
  sessionId: string;
  lockKey: string;
}): Promise<boolean> {
  const db = createServiceClient();
  const now = new Date().toISOString();

  await db.from('agent_execution_locks').delete().lt('expires_at', now);

  const { data } = await db
    .from('agent_execution_locks')
    .select('lock_key')
    .eq('lock_key', params.lockKey)
    .eq('user_id', params.userId)
    .eq('session_id', params.sessionId)
    .gt('expires_at', now)
    .limit(1)
    .maybeSingle();

  return Boolean(data?.lock_key);
}

export async function createExecutionLock(params: {
  userId: string | null;
  sessionId: string;
  toolName: string;
  actionKey: string;
  workflowId?: string;
  ttlSeconds: number;
}): Promise<void> {
  if (!params.userId) return;
  const db = createServiceClient();
  await db.from('agent_execution_locks').upsert({
    lock_key: `${params.sessionId}:${params.actionKey}`,
    user_id: params.userId,
    session_id: params.sessionId,
    action_name: params.toolName,
    workflow_id: params.workflowId ?? null,
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + params.ttlSeconds * 1000).toISOString(),
  });
}

export async function evaluateToolSafety(ctx: GuardContext): Promise<GuardDecision> {
  const policy = await loadExecutionPolicy(ctx.userId, ctx.sessionId);
  const toolPolicy = getToolExecutionPolicy(ctx.toolName);

  if (!toolPolicy.allowedModes.includes(policy.mode)) {
    console.warn(`[safety] BLOCKED tool=${ctx.toolName} active_mode=${policy.mode} session=${ctx.sessionId} userId=${ctx.userId ?? 'anon'} allowed_modes=${JSON.stringify(toolPolicy.allowedModes)}`);
    return {
      allowed: false,
      mode: policy.mode,
      blockCode: policy.mode === 'safe' ? 'SAFE_MODE_BLOCK' : 'STAGING_SIDE_EFFECT_BLOCK',
      reason: `${ctx.toolName} is not allowed in ${policy.mode} mode.`,
    };
  }

  if (policy.mode === 'safe' && isExternalSideEffectTool(ctx.toolName)) {
    return {
      allowed: false,
      mode: policy.mode,
      blockCode: 'SAFE_MODE_BLOCK',
      reason: 'Safe mode allows planning only. External execution is blocked.',
    };
  }

  if (!ctx.userId) {
    return {
      allowed: !toolRequiresApproval(ctx.toolName, ctx.args),
      mode: policy.mode,
      ...(toolRequiresApproval(ctx.toolName, ctx.args)
        ? {
            blockCode: 'APPROVAL_REQUIRED' as const,
            reason: 'Sign in is required to approve high-risk actions.',
            requiresApproval: true,
          }
        : {}),
    };
  }

  const actionKey = buildActionKey(ctx.toolName, ctx.args);

  if (policy.requireApprovalHighRisk && toolRequiresApproval(ctx.toolName, ctx.args)) {
    const approval = await approvalStatus({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      actionKey,
      toolName: ctx.toolName,
      args: ctx.args,
    });
    if (approval.status !== 'approved') {
      return {
        allowed: false,
        mode: policy.mode,
        blockCode: 'APPROVAL_REQUIRED',
        reason: approval.reason,
        requiresApproval: true,
        approval,
      };
    }
  }

  const duplicateLockKey = `${ctx.sessionId}:${actionKey}`;
  const duplicate = await hasDuplicateLock({
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    lockKey: duplicateLockKey,
  });
  if (duplicate) {
    return {
      allowed: false,
      mode: policy.mode,
      blockCode: 'DUPLICATE_PREVENTED',
      reason: 'Duplicate action prevented by execution lock window.',
    };
  }

  const perMinuteCount = await countActionEvents({
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    toolName: ctx.toolName,
    seconds: 60,
  });
  if (perMinuteCount >= policy.maxApiCallsPerMinute) {
    return {
      allowed: false,
      mode: policy.mode,
      blockCode: 'RATE_LIMITED',
      reason: 'API call rate limit reached for this minute.',
    };
  }

  const perHourCount = await countActionEvents({
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    toolName: ctx.toolName,
    seconds: 3600,
  });
  if (perHourCount >= policy.maxExternalActionsPerHour) {
    return {
      allowed: false,
      mode: policy.mode,
      blockCode: 'RATE_LIMITED',
      reason: 'Hourly execution cap reached.',
    };
  }

  const recentSameActionCount = await countActionEvents({
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    toolName: ctx.toolName,
    seconds: 600,
  });
  if (recentSameActionCount >= policy.maxRepeatSameAction) {
    return {
      allowed: false,
      mode: policy.mode,
      blockCode: 'LOOP_DETECTED',
      reason: 'Potential infinite loop detected. Same action repeated too many times.',
    };
  }

  const usage = await getDailyAiUsageTotals(ctx.userId, ctx.sessionId);
  if (usage.tokens >= policy.maxAiTokensPerDay || usage.costUsd >= policy.maxAiCostUsdPerDay) {
    return {
      allowed: false,
      mode: policy.mode,
      blockCode: 'QUOTA_EXCEEDED',
      reason: 'Daily AI usage quota exceeded. Raise budget limits or retry tomorrow.',
    };
  }

  await createExecutionLock({
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    toolName: ctx.toolName,
    actionKey,
    workflowId: ctx.args.workflow_id ? String(ctx.args.workflow_id) : undefined,
    ttlSeconds: policy.duplicateWindowSeconds,
  });

  return {
    allowed: true,
    mode: policy.mode,
  };
}

export async function approveAction(params: {
  userId: string;
  sessionId: string;
  actionKey: string;
  approve: boolean;
}): Promise<boolean> {
  const db = createServiceClient();
  const status = params.approve ? 'approved' : 'rejected';
  const { error } = await db
    .from('agent_action_approvals')
    .update({
      status,
      approved_by: params.userId,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', params.userId)
    .eq('session_id', params.sessionId)
    .eq('action_key', params.actionKey)
    .eq('status', 'pending');
  return !error;
}
