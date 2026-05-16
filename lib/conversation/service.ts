import { NextRequest } from 'next/server';

import {
  buildCanonicalPrompt,
  mergeSlots,
  type ConversationMessage,
  type ConversationSlots,
  type PlannerStatus,
} from '@/lib/conversation-agent';
import { runAgentLoop, type AgentProgressUpdate } from '@/lib/agent/loop';
import type { SafetyMode } from '@/lib/agent/safety';
import type { WorkflowGraphSummary } from '@/lib/agent/workflow-graph';
import {
  extractProvidersFromWorkflowGraph,
  filterProvidersToGraphAllowList,
} from '@/lib/agent/provider-allowlist';
import { constrainAutomationBrainToGraph } from '@/lib/automation';
import { sanitizeAutomationBrainForGraph } from '@/lib/automation/sanitize-automation-brain-for-graph';
import { runtimeQueueConfigured } from '@/lib/runtime/queue';
import { createServiceClient, getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';
import { decryptJson } from '@/lib/security/encryption';

type ConversationRow = {
  id: string;
  session_id: string;
  user_id: string | null;
  current_goal: string;
  detected_trigger: string | null;
  detected_action: string | null;
  detected_platform: string | null;
  slot_trigger: string | null;
  slot_action: string | null;
  slot_platform: string | null;
  slot_destination: string | null;
  slot_ai_provider: string | null;
  slot_schedule: string | null;
  required_integrations: string[] | null;
  collected_credentials: Record<string, unknown> | null;
  missing_fields: string[] | null;
  conversation_history: ConversationMessage[] | null;
  planner_status: PlannerStatus;
  confidence: number;
  canonical_prompt: string;
};

function toSlots(row: ConversationRow | null): ConversationSlots {
  return {
    trigger: row?.slot_trigger ?? null,
    action: row?.slot_action ?? null,
    platform: row?.slot_platform ?? null,
    destination: row?.slot_destination ?? null,
    ai_provider: row?.slot_ai_provider ?? null,
    schedule: row?.slot_schedule ?? null,
    automation_style: null,
    business_type: null,
  };
}

async function getUserId(req: NextRequest): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const user = await getUserFromAccessToken(token);
  return user?.id ?? null;
}

async function buildUserMemoryContext(userId: string | null): Promise<string | undefined> {
  if (!userId) return undefined;

  const db = createServiceClient();

  const [{ data: integrations }, { data: recentConversations }, { data: activeWorkflows }] = await Promise.all([
    db
      .from('user_integrations')
      .select('provider, status')
      .eq('user_id', userId)
      .eq('status', 'connected'),
    db
      .from('automation_conversations')
      .select('current_goal, conversation_history, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(3),
    db
      .from('workflows')
      .select('name, status, integrations')
      .eq('user_id', userId)
      .in('status', ['draft', 'active'])
      .order('created_at', { ascending: false })
      .limit(2),
  ]);

  const connectedProviders = (integrations ?? []).map((row: { provider: string }) => String(row.provider));

  const recentProjects = (recentConversations ?? [])
    .map((row: { current_goal: string | null; conversation_history: any[] }) => ({
      goal: row.current_goal,
      messageCount: row.conversation_history?.length ?? 0,
    }))
    .filter((project) => project.goal && project.messageCount > 1)
    .slice(0, 2);

  const activeProjects = (activeWorkflows ?? [])
    .map((row: { name: string; status: string; integrations: string[] }) => ({
      name: row.name,
      status: row.status,
      integrations: row.integrations,
    }));

  const lines: string[] = [];

  if (connectedProviders.length > 0) {
    lines.push(`You have these integrations connected: ${connectedProviders.join(', ')}`);
  }

  if (activeProjects.length > 0) {
    const projectNames = activeProjects.map(p => p.name).join(', ');
    lines.push(`Active projects: ${projectNames}`);
  }

  if (recentProjects.length > 0) {
    const projectGoals = recentProjects.map(p => p.goal).join(' | ');
    lines.push(`Recent conversations: ${projectGoals}`);
  }

  if (lines.length === 0) return undefined;

  return `USER CONTEXT:\n${lines.join('\n')}\n\nReference this context naturally in conversation, but don't list it out. Use it to build continuity and avoid repeating questions.`;

  return lines.length > 0 ? lines.join('\n') : undefined;
}

function resolveRequiredIntegrations(input: {
  workflowGraph?: WorkflowGraphSummary | null;
  requiredIntegrations: string[];
  credentialRequests: Array<{ provider: string }>;
}): string[] {
  const allowList = extractProvidersFromWorkflowGraph(input.workflowGraph);
  const provisionalProviders = [
    ...input.requiredIntegrations,
    ...input.credentialRequests.map((request) => request.provider),
  ];

  if (allowList.length > 0) {
    const filtered = filterProvidersToGraphAllowList(provisionalProviders, input.workflowGraph);
    return Array.from(new Set([...allowList, ...filtered]));
  }

  return Array.from(new Set(filterProvidersToGraphAllowList(provisionalProviders, input.workflowGraph)));
}

export type ConversationTurnPayload = {
  success: true;
  sessionId: string;
  assistant: {
    content: string;
    options?: string[];
  };
  agentEvents: Array<{
    type: string;
    label: string;
    detail?: string;
    workflowId?: string;
    workflowUrl?: string;
    agent?: 'planner' | 'integration' | 'deploy' | 'monitoring' | 'recovery';
  }>;
  credentialRequests: Array<{ provider: string; reason: string; instructions?: string }>;
  approvalRequests: Array<{ actionKey: string; actionType: string; reason: string; status: string }>;
  safety: {
    mode: 'safe' | 'staging' | 'production';
  };
  runtime: {
    configured: boolean;
    error: string | null;
  };
  integrationWizard: {
    autoLaunch: boolean;
    required: string[];
  };
  workflow: {
    id?: string;
    url?: string;
    active: boolean;
  } | null;
  workflowGraph: Record<string, unknown> | null;
  agentTasks: unknown[];
  automationBrain: {
    inferredIntent: string;
    capabilities: Array<{ key: string; reason: string; confidence: number }>;
    activatedSkillPacks: Array<{ name: string; description: string; capabilities: string[]; tools: string[]; matchScore: number }>;
    matchedPatterns: Array<{ name: string; category: string; score: number; estimatedCost: number; estimatedComplexity: string; risk: string }>;
    providerResolutions: Array<{ provider: string; capabilities: string[]; confidence: number }>;
    composition: {
      executionFrequency: string;
      expectedInputs: string[];
      expectedOutputs: string[];
      complexity: string;
      estimatedCostUsd: number;
      latencyEstimateMs: number;
      risks: string[];
      blocks: Array<{ id: string; category: string; name: string; capabilities: string[] }>;
    };
  } | null;
  state: {
    sessionId: string;
    currentGoal: string;
    detectedTrigger: string | null;
    detectedAction: string | null;
    detectedPlatform: string | null;
    requiredIntegrations: string[];
    collectedCredentials: Record<string, unknown>;
    missingFields: string[];
    conversationHistory: ConversationMessage[];
    plannerStatus: PlannerStatus;
    slots: ConversationSlots;
    confidence: number;
    readyToBuild: boolean;
    canonicalPrompt: string;
  };
  planner: {
    readyToBuild: boolean;
    canonicalPrompt: string | null;
  };
};

export type ConversationExecutionMode = 'safe_preview' | 'staging_deploy' | 'production_deploy';

function mapExecutionMode(mode: ConversationExecutionMode): {
  safetyMode: SafetyMode;
  sandboxEnabled: boolean;
  dryRunEnabled: boolean;
  requireApprovalHighRisk: boolean;
} {
  if (mode === 'production_deploy') {
    return {
      safetyMode: 'production',
      sandboxEnabled: false,
      dryRunEnabled: false,
      requireApprovalHighRisk: true,
    };
  }

  if (mode === 'staging_deploy') {
    return {
      safetyMode: 'staging',
      sandboxEnabled: false,
      dryRunEnabled: false,
      requireApprovalHighRisk: false,
    };
  }

  return {
    safetyMode: 'safe',
    sandboxEnabled: true,
    dryRunEnabled: true,
    requireApprovalHighRisk: true,
  };
}

async function applyExecutionMode(params: {
  db: ReturnType<typeof createServiceClient>;
  userId: string | null;
  sessionId: string;
  mode?: ConversationExecutionMode;
}): Promise<void> {
  if (!params.userId || !params.mode) return;

  const mapped = mapExecutionMode(params.mode);
  const payload = {
    user_id: params.userId,
    session_id: params.sessionId,
    mode: mapped.safetyMode,
    sandbox_enabled: mapped.sandboxEnabled,
    dry_run_enabled: mapped.dryRunEnabled,
    require_approval_high_risk: mapped.requireApprovalHighRisk,
    duplicate_window_seconds: 0,
    max_repeat_same_action: 25,
    max_rounds_per_turn: 12,
    max_tool_calls_per_turn: 20,
    updated_at: new Date().toISOString(),
  };

  const { error } = await params.db
    .from('agent_execution_policies')
    .upsert(payload, { onConflict: 'user_id,session_id' });

  if (error) {
    // Fall back to update-then-insert for schemas without the composite upsert index.
    const updated = await params.db
      .from('agent_execution_policies')
      .update(payload)
      .eq('user_id', params.userId)
      .eq('session_id', params.sessionId);

    if (updated.error) {
      await params.db.from('agent_execution_policies').insert({
        ...payload,
        created_at: new Date().toISOString(),
      });
    }
  }
}

export async function processConversationTurn(params: {
  req: NextRequest;
  message: string;
  sessionId?: string;
  mode?: ConversationExecutionMode;
  onProgress?: (update: AgentProgressUpdate) => void | Promise<void>;
}): Promise<ConversationTurnPayload> {
  const { req, message, sessionId: incomingSessionId, mode, onProgress } = params;
  const sessionId = incomingSessionId?.trim() || `conv-${Date.now()}`;

  const userId = await getUserId(req);
  const db = createServiceClient();
  await applyExecutionMode({ db, userId, sessionId, mode });
  console.log(`[conversation] session=${sessionId} userId=${userId ?? 'anon'} requested_mode=${mode ?? 'none'} => policy will be applied`);
  const memoryContext = await buildUserMemoryContext(userId);

  let query = db
    .from('automation_conversations')
    .select('*')
    .eq('session_id', sessionId)
    .limit(1);
  if (userId) query = query.eq('user_id', userId);

  const { data: existing, error: loadError } = await query.maybeSingle();
  if (loadError) {
    throw new Error(loadError.message);
  }

  const existingRow = (existing as ConversationRow | null) ?? null;
  const existingSlots = toSlots(existingRow);

  const history: ConversationMessage[] = [
    ...(existingRow?.conversation_history ?? []),
    { role: 'user' as const, content: message, timestamp: new Date().toISOString() },
  ];

  const agentResult = await runAgentLoop(history, existingSlots, {
    userId,
    sessionId,
    onProgress,
    memoryContext,
  });

  const mergedSlots = mergeSlots(existingSlots, agentResult.slots_update);
  const credentialState = decryptJson(existingRow?.collected_credentials ?? {});
  const plannerStatus: PlannerStatus = agentResult.planner_status;
  const canonicalPrompt =
    agentResult.canonical_prompt || buildCanonicalPrompt(mergedSlots, existingRow?.current_goal ?? message);

  const missingIntegrations = agentResult.credential_requests.map((r) => r.provider);
  const resolvedIntegrations = resolveRequiredIntegrations({
    workflowGraph: agentResult.workflow_graph,
    requiredIntegrations: agentResult.required_integrations,
    credentialRequests: agentResult.credential_requests,
  });

  const updatedHistory: ConversationMessage[] = [
    ...history,
    { role: 'assistant' as const, content: agentResult.assistant_message, timestamp: new Date().toISOString() },
  ];

  const upsertPayload = {
    session_id: sessionId,
    user_id: userId,
    current_goal: existingRow?.current_goal ?? message,
    detected_trigger: mergedSlots.trigger,
    detected_action: mergedSlots.action,
    detected_platform: mergedSlots.platform,
    slot_trigger: mergedSlots.trigger,
    slot_action: mergedSlots.action,
    slot_platform: mergedSlots.platform,
    slot_destination: mergedSlots.destination,
    slot_ai_provider: mergedSlots.ai_provider,
    slot_schedule: mergedSlots.schedule,
    required_integrations: resolvedIntegrations,
    collected_credentials: existingRow?.collected_credentials ?? {},
    missing_fields: agentResult.missing_fields,
    conversation_history: updatedHistory,
    planner_status: plannerStatus,
    confidence: agentResult.confidence,
    canonical_prompt: canonicalPrompt,
    updated_at: new Date().toISOString(),
  };

  const { data: saved, error } = await db
    .from('automation_conversations')
    .upsert(upsertPayload, { onConflict: 'session_id' })
    .select('*')
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (saved?.id) {
    await db.from('automation_conversation_messages').insert([
      { conversation_id: saved.id, role: 'user', content: message },
      { conversation_id: saved.id, role: 'assistant', content: agentResult.assistant_message },
    ]);
  }

  const readyToBuild = plannerStatus === 'ready_to_build' || agentResult.ready_to_build;
  const runtimeConfigured = runtimeQueueConfigured();

  if (agentResult.workflow_graph || agentResult.automation_brain) {
    const topPattern = agentResult.automation_brain?.matchedPatterns?.[0]?.name;
    try {
      await db.from('workflow_feedback').insert({
        user_id: userId,
        session_id: sessionId,
        workflow_id: agentResult.workflow_id ?? null,
        prompt: message,
        generated_workflow: agentResult.workflow_graph ?? {},
        generated_pattern: topPattern ?? null,
        success_rate: agentResult.workflow_complete ? 100 : null,
        runtime_performance: {
          confidence: agentResult.confidence,
          planner_status: plannerStatus,
        },
        user_edits: {},
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      // Keep conversation path non-blocking when feedback table is not yet migrated.
      console.warn('[conversation] workflow_feedback insert skipped:', error instanceof Error ? error.message : error);
    }
  }

  const graphConstrainedBrain = constrainAutomationBrainToGraph(
    agentResult.automation_brain,
    agentResult.workflow_graph
  );
  const sanitizedGraphConstrainedBrain = sanitizeAutomationBrainForGraph(
    graphConstrainedBrain,
    agentResult.workflow_graph
  );

  return {
    success: true,
    sessionId,
    assistant: {
      content: agentResult.assistant_message,
      options: agentResult.options,
    },
    agentEvents: agentResult.events,
    credentialRequests: agentResult.credential_requests,
    approvalRequests: agentResult.approval_requests,
    safety: {
      mode: agentResult.safety_mode,
    },
    runtime: {
      configured: runtimeConfigured,
      error: runtimeConfigured ? null : 'Runtime worker/Redis not configured',
    },
    integrationWizard: {
      autoLaunch: resolvedIntegrations.length > 0,
      required: resolvedIntegrations,
    },
    workflow: agentResult.workflow_complete
      ? {
          id: agentResult.workflow_id,
          url: agentResult.workflow_url,
          active: agentResult.workflow_complete,
        }
      : null,
    workflowGraph: (agentResult.workflow_graph ?? null) as Record<string, unknown> | null,
    agentTasks: agentResult.agent_tasks,
    automationBrain: sanitizedGraphConstrainedBrain
      ? {
          inferredIntent: sanitizedGraphConstrainedBrain.inferredIntent,
          capabilities: sanitizedGraphConstrainedBrain.capabilities,
          activatedSkillPacks: sanitizedGraphConstrainedBrain.activatedSkillPacks.map((pack) => ({
            name: pack.name,
            description: pack.description,
            capabilities: pack.capabilities,
            tools: pack.tools,
            matchScore: pack.matchScore,
          })),
          matchedPatterns: sanitizedGraphConstrainedBrain.matchedPatterns.map((pattern) => ({
            name: pattern.name,
            category: pattern.category,
            score: pattern.score,
            estimatedCost: pattern.estimatedCost,
            estimatedComplexity: pattern.estimatedComplexity,
            risk: pattern.risk,
          })),
          providerResolutions: sanitizedGraphConstrainedBrain.providerResolutions,
          composition: {
            executionFrequency: sanitizedGraphConstrainedBrain.composition.executionFrequency,
            expectedInputs: sanitizedGraphConstrainedBrain.composition.expectedInputs,
            expectedOutputs: sanitizedGraphConstrainedBrain.composition.expectedOutputs,
            complexity: sanitizedGraphConstrainedBrain.composition.complexity,
            estimatedCostUsd: sanitizedGraphConstrainedBrain.composition.estimatedCostUsd,
            latencyEstimateMs: sanitizedGraphConstrainedBrain.composition.latencyEstimateMs,
            risks: sanitizedGraphConstrainedBrain.composition.risks,
            blocks: sanitizedGraphConstrainedBrain.composition.blocks,
          },
        }
      : null,
    state: {
      sessionId,
      currentGoal: upsertPayload.current_goal,
      detectedTrigger: mergedSlots.trigger,
      detectedAction: mergedSlots.action,
      detectedPlatform: mergedSlots.platform,
      requiredIntegrations: resolvedIntegrations,
      collectedCredentials: credentialState,
      missingFields: agentResult.missing_fields,
      conversationHistory: updatedHistory,
      plannerStatus,
      slots: mergedSlots,
      confidence: agentResult.confidence,
      readyToBuild,
      canonicalPrompt,
    },
    planner: {
      readyToBuild,
      canonicalPrompt: readyToBuild ? canonicalPrompt : null,
    },
  };
}
