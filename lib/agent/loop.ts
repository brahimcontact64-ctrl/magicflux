/**
 * MagicFlux Autonomous Agent — Agent Loop
 *
 * Runs the OpenAI tool-calling loop:
 * 1. Send conversation + tools to OpenAI
 * 2. AI decides which tool to call
 * 3. Execute tool against real infrastructure
 * 4. Feed result back to AI
 * 5. Repeat until AI returns a final text response (no more tool calls)
 */

import OpenAI from 'openai';

import { CONSULTANT_SYSTEM_PROMPT, type ConversationMessage, type ConversationSlots } from '@/lib/conversation-agent';
import { AGENT_TOOLS } from './tools';
import { executeTool, type AgentEvent } from './executor';
import { createTask, type AgentTask } from './multi-agent';
import { recordAgentActionEvent, recordAiUsage } from './observability';
import { evaluateToolSafety, loadExecutionPolicy, type SafetyMode } from './safety';
import type { WorkflowGraphSummary } from './workflow-graph';
import { createCorrelationId, emitRuntimeEvent } from '@/lib/runtime/events';
import { createTraceId, endSpan, finishTrace, startSpan, startTrace } from '@/lib/runtime/tracing';
import {
  analyzeAutomationPrompt,
  toAutomationBrainPromptContext,
  type AutomationBrainResult,
} from '@/lib/automation';

// New autonomous systems
import { persistentMemory } from '@/lib/memory/persistent-memory';
import { agentOrchestrator } from '@/lib/agent/multi-agent';
import { timelineManager } from '@/lib/timeline/timeline-manager';
import { backgroundTaskManager } from '@/lib/tasks/background-task-manager';
import { selfHealingManager } from '@/lib/recovery/self-healing-manager';
import { fileGenerationManager } from '@/lib/files/file-generation-manager';
import { liveGraphManager } from '@/lib/graph/live-graph-manager';
import { deploymentManager } from '@/lib/deployment/deployment-manager';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentTurnResult = {
  /** Final assistant message to display */
  assistant_message: string;
  /** Option chips for the user */
  options?: string[];
  /** Ordered list of execution events (tool calls that happened) */
  events: AgentEvent[];
  /** Updated slots extracted during this turn */
  slots_update: Partial<ConversationSlots>;
  /** Whether task is complete — workflow built and deployed */
  workflow_complete: boolean;
  /** If workflow was deployed, its ID */
  workflow_id?: string;
  workflow_url?: string;
  /** Integration/credential requests from the AI */
  credential_requests: Array<{ provider: string; reason: string; instructions?: string }>;
  /** For planner — set when ready to build */
  ready_to_build: boolean;
  canonical_prompt?: string;
  confidence: number;
  planner_status: 'collecting_requirements' | 'waiting_integrations' | 'ready_to_build' | 'blocked_low_confidence';
  missing_fields: string[];
  required_integrations: string[];
  approval_requests: Array<{ actionKey: string; actionType: string; reason: string; status: string }>;
  safety_mode: SafetyMode;
  workflow_graph?: WorkflowGraphSummary;
  agent_tasks: AgentTask[];
  automation_brain?: AutomationBrainResult;
};

export type AgentProgressUpdate = {
  type: 'phase' | 'tool' | 'event';
  message: string;
  event?: AgentEvent;
  toolName?: string;
  workflowGraph?: WorkflowGraphSummary;
};

// ---------------------------------------------------------------------------
// System prompt extension for the tool-calling agent
// ---------------------------------------------------------------------------

const AGENT_SYSTEM_PROMPT = CONSULTANT_SYSTEM_PROMPT + `

When executing tools:
- Start building immediately on clear automation requests
- Generate workflow nodes progressively
- Surface live progress through the UI
- Request credentials only when blocking execution
- Keep narration brief and action-oriented

Critical staging rule:
- On the first build turn, do NOT deploy or activate automatically.
- First produce: workflow preview, integrations needed, and deployment plan summary.
- Only call deployment/activation tools after explicit user confirmation (for example: "deploy", "approve and deploy", "proceed with deployment").`;
// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export async function runAgentLoop(
  history: ConversationMessage[],
  currentSlots: ConversationSlots,
  options?: {
    userId?: string | null;
    sessionId?: string;
    maxToolRounds?: number;
    onProgress?: (update: AgentProgressUpdate) => void | Promise<void>;
    memoryContext?: string;
  }
): Promise<AgentTurnResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const openai = new OpenAI({ apiKey });
  const sessionId = options?.sessionId ?? `session-${Date.now()}`;
  const userId = options?.userId ?? null;
  const correlationId = createCorrelationId(sessionId);
  const traceId = createTraceId();
  await startTrace({
    userId,
    sessionId,
    correlationId,
    rootAgent: 'planner',
    traceId,
  });
  const plannerSpanId = await startSpan({
    userId,
    traceId,
    name: 'planner_agent_loop',
    kind: 'agent',
    agentId: 'planner',
    sessionId,
  });
  const policy = await loadExecutionPolicy(userId, sessionId);
  console.log(`[agent-loop] session=${sessionId} active_mode=${policy.mode} sandboxEnabled=${policy.sandboxEnabled} requireApprovalHighRisk=${policy.requireApprovalHighRisk}`);
  const maxToolRounds = Math.min(options?.maxToolRounds ?? 6, policy.maxRoundsPerTurn);
  const onProgress = options?.onProgress;
  const latestUserMessage = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
  const allowDeploymentActions = hasExplicitDeployIntent(latestUserMessage);
  let automationBrain: AutomationBrainResult | undefined;

  try {
    automationBrain = await analyzeAutomationPrompt(latestUserMessage);
  } catch (error) {
    console.warn('[agent-loop] automation brain failed:', error);
  }

  await onProgress?.({
    type: 'phase',
    message: 'Analyzing your request...',
  });

  await emitRuntimeEvent({
    eventType: 'agent.started',
    userId,
    sessionId,
    agentId: 'planner',
    correlationId,
    traceId,
    spanId: plannerSpanId,
    payload: { maxToolRounds, safetyMode: policy.mode },
  });

  // Build resolved slots context
  const resolvedEntries = Object.entries(currentSlots).filter(([, v]) => v !== null && v !== '');
  const resolvedContext =
    resolvedEntries.length > 0
      ? '\n\nALREADY RESOLVED (DO NOT ASK AGAIN):\n' +
        resolvedEntries.map(([k, v]) => `  ${k}: ${v}`).join('\n')
      : '';

  const memoryContext = options?.memoryContext?.trim()
    ? `\n\nUSER MEMORY CONTEXT:\n${options.memoryContext.trim()}`
    : '';

  let workflowId: string | undefined;
  let workflowUrl: string | undefined;
  let workflowComplete = false;
  let workflowGraph: WorkflowGraphSummary | undefined;

  // Load persistent memory context
  let persistentContext = '';
  if (userId) {
    try {
      const memoryData = await persistentMemory.loadContextForSession(
        userId,
        sessionId,
        undefined, // projectId - could be derived from conversation
        workflowId
      );

      if (memoryData.projectMemories.length > 0 || memoryData.workflowMemories.length > 0) {
        persistentContext = '\n\nPERSISTENT MEMORY:\n';

        if (memoryData.projectMemories.length > 0) {
          persistentContext += 'Previous workflows and integrations:\n';
          memoryData.projectMemories.slice(0, 5).forEach(mem => {
            persistentContext += `  - ${mem.memoryType}: ${mem.key} (${mem.value})\n`;
          });
        }

        if (memoryData.workflowMemories.length > 0) {
          persistentContext += 'Current workflow context:\n';
          memoryData.workflowMemories.slice(0, 3).forEach(mem => {
            persistentContext += `  - ${mem.memoryType}: ${mem.key}\n`;
          });
        }
      }
    } catch (error) {
      console.warn('Failed to load persistent memory:', error);
    }
  }

  const automationBrainContext = automationBrain
    ? `\n\n${toAutomationBrainPromptContext(automationBrain)}\n\nUse this capability-first context to decide tools, providers, credentials, and workflow composition.`
    : '';

  const systemContent = AGENT_SYSTEM_PROMPT + resolvedContext + memoryContext + persistentContext + automationBrainContext;
  const shouldForceActionStart = shouldStartAutonomousBuild({
    userMessage: latestUserMessage,
    currentSlots,
  });

  // Convert conversation to OpenAI messages
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemContent },
    ...history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  const events: AgentEvent[] = [];
  const credentialRequests: Array<{ provider: string; reason: string; instructions?: string }> = [];
  const approvalRequests: Array<{ actionKey: string; actionType: string; reason: string; status: string }> = [];
  const agentTasks: AgentTask[] = [];

  // Tool calling loop
  for (let round = 0; round < maxToolRounds; round++) {
    await onProgress?.({
      type: 'phase',
      message: round === 0 ? 'Designing your workflow...' : 'Refining your automation plan...',
    });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools: AGENT_TOOLS,
      tool_choice: round === 0 && shouldForceActionStart ? 'required' : 'auto',
      temperature: 0.2,
      max_tokens: 1500,
    });

    await recordAiUsage({
      userId,
      sessionId,
      provider: 'openai',
      model: 'gpt-4o',
      agentName: 'planner',
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      metadata: { phase: 'loop_round', round },
    });

    const choice = response.choices[0];
    if (!choice) break;

    const msg = choice.message;

    // If no tool calls, this is the final response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const rawContent = msg.content ?? '';
      const { cleanContent, agentState } = extractAgentState(rawContent);

      const result = buildResult({
        message: cleanContent,
        events,
        credentialRequests,
        approvalRequests,
        workflowId,
        workflowUrl,
        workflowComplete,
        agentState,
        currentSlots,
        safetyMode: policy.mode,
        workflowGraph,
        agentTasks,
        automationBrain,
      });

      await emitRuntimeEvent({
        eventType: 'agent.completed',
        userId,
        sessionId,
        workflowId,
        agentId: 'planner',
        correlationId,
        traceId,
        spanId: plannerSpanId,
        payload: { workflowComplete, approvalsPending: approvalRequests.length },
      });

      await endSpan({ userId, spanId: plannerSpanId, status: 'success' });
      await finishTrace({ userId, traceId, status: 'completed' });

      await onProgress?.({
        type: 'phase',
        message: 'Finalizing your automation...',
      });

      return result;
    }

    // Add assistant message with tool calls to history
    messages.push(msg);

    // Execute all tool calls in this round
    for (const toolCall of msg.tool_calls) {
      const tc = toolCall as { id: string; function: { name: string; arguments: string } };
      const toolName = tc.function.name;
      let args: Record<string, unknown> = {};

      const toolMessageMap: Record<string, string> = {
        generate_workflow_json: 'Setting up the workflow structure...',
        explain_workflow_architecture: 'Putting together a quick overview...',
        request_credential: 'Need to connect this integration...',
        validate_credential: 'Checking the connection details...',
        deploy_workflow_to_n8n: 'Getting this deployed...',
        activate_workflow: 'Turning it on...',
        test_workflow: 'Running a quick test...',
        get_execution_logs: 'Checking how it\'s running...',
      };

      await onProgress?.({
        type: 'tool',
        message: toolMessageMap[toolName] ?? 'Working on your automation...',
        toolName,
      });

      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        // ignore parse errors — use empty args
      }

      const task = createTask(toolName, args);
      agentTasks.push(task);

      const safety = await evaluateToolSafety({
        userId,
        sessionId,
        toolName,
        args,
      });

      if ((toolName === 'deploy_workflow_to_n8n' || toolName === 'activate_workflow') && !allowDeploymentActions) {
        const deployPrompt = 'Deployment plan ready. Review workflow preview and integrations, then press Approve + Deploy.';
        events.push({
          type: 'thinking',
          label: 'Deployment plan prepared',
          detail: deployPrompt,
          agent: 'planner',
        });

        await recordAgentActionEvent({
          userId,
          sessionId,
          eventType: 'tool_blocked',
          actionName: toolName,
          status: 'info',
          detail: 'Deployment gated until explicit user deploy confirmation.',
          metadata: { reason: 'awaiting_user_deploy_confirmation' },
        });

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            blocked: true,
            reason: 'DEPLOY_CONFIRMATION_REQUIRED',
            message: deployPrompt,
          }),
        });
        continue;
      }

      if (!safety.allowed) {
        const blockedOutput: Record<string, unknown> = {
          blocked: true,
          block_code: safety.blockCode ?? 'POLICY_BLOCK',
          reason: safety.reason ?? 'Action blocked by safety policy.',
          safety_mode: safety.mode,
        };

        if (safety.requiresApproval && safety.approval) {
          approvalRequests.push({
            actionKey: safety.approval.actionKey,
            actionType: safety.approval.actionType,
            reason: safety.approval.reason,
            status: safety.approval.status,
          });
          blockedOutput.approval = safety.approval;
          events.push({
            type: 'approval_required',
            label: 'Human approval required',
            detail: safety.approval.reason,
            agent: 'planner',
          });

          await emitRuntimeEvent({
            eventType: 'approval.required',
            userId,
            sessionId,
            workflowId: args.workflow_id ? String(args.workflow_id) : undefined,
            agentId: 'planner',
            correlationId,
            traceId,
            spanId: plannerSpanId,
            severity: 'warning',
            payload: {
              actionKey: safety.approval.actionKey,
              actionType: safety.approval.actionType,
              reason: safety.approval.reason,
            },
          });
        } else {
          events.push({
            type: 'policy_blocked',
            label: 'Execution blocked by policy',
            detail: safety.reason,
            agent: 'planner',
          });
        }

        await recordAgentActionEvent({
          userId,
          sessionId,
          eventType: 'tool_blocked',
          actionName: toolName,
          status: 'warning',
          detail: safety.reason,
          errorCode: safety.blockCode,
          metadata: { args, mode: safety.mode },
        });

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(blockedOutput),
        });
        continue;
      }

      // Execute the tool
      const result = await executeTool(toolName, args, {
        userId,
        sessionId,
        policy,
        correlationId,
        traceId,
        parentSpanId: plannerSpanId,
      });

      // Track events
      if (result.event) {
        events.push(result.event);
        if (userId) {
          const timelineEventType = (() => {
            if (result.event.type === 'generating_workflow') return 'workflow_generated';
            if (result.event.type === 'requesting_credential') return 'credentials_required';
            if (result.event.type === 'testing') return 'test_succeeded';
            if (result.event.type === 'deploying' || result.event.type === 'activating' || result.event.type === 'workflow_ready') {
              return 'deployment_completed';
            }
            if (result.event.type === 'retrying') return 'retry_attempt';
            if (result.event.type === 'rolled_back') return 'rollback_executed';
            if (result.event.type === 'error') return 'failure_recovered';
            return 'workflow_generated';
          })();

          await timelineManager.recordEvent(
            userId,
            sessionId,
            timelineEventType,
            result.event.label,
            {
              workflowId: workflowId,
              description: result.event.detail,
              status: result.event.type === 'error' ? 'error' : 'info',
              metadata: {
                toolName,
                eventType: result.event.type,
              },
            }
          ).catch(() => undefined);
        }
        await onProgress?.({
          type: 'event',
          message: result.event.label,
          event: result.event,
          toolName,
        });
      }

      // Track credential requests
      if (toolName === 'request_credential' && result.output.awaiting_credential) {
        credentialRequests.push({
          provider: String(result.output.provider ?? ''),
          reason: String(result.output.reason ?? ''),
          instructions: result.output.instructions ? String(result.output.instructions) : undefined,
        });
      }

      // Track workflow deployment
      if (toolName === 'deploy_workflow_to_n8n' && result.success) {
        workflowId = result.output.workflow_id ? String(result.output.workflow_id) : undefined;
        workflowUrl = result.output.workflow_url ? String(result.output.workflow_url) : undefined;
      }

      // Track generated JSON for passing to deploy
      if (toolName === 'generate_workflow_json' && result.success) {
        if (result.output.workflow_graph && typeof result.output.workflow_graph === 'object') {
          workflowGraph = result.output.workflow_graph as WorkflowGraphSummary;
          await onProgress?.({
            type: 'event',
            message: 'Workflow graph ready',
            toolName,
            workflowGraph,
          });
        }
      }

      // Track activation
      if (toolName === 'activate_workflow' && result.success) {
        workflowComplete = true;
      }

      // Add tool result to messages
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result.output),
      });
    }
  }

  // Exhausted rounds — get final response without tools
  const finalResponse = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages,
    temperature: 0.2,
    max_tokens: 800,
  });

  await recordAiUsage({
    userId,
    sessionId,
    provider: 'openai',
    model: 'gpt-4o',
    agentName: 'planner',
    promptTokens: finalResponse.usage?.prompt_tokens ?? 0,
    completionTokens: finalResponse.usage?.completion_tokens ?? 0,
    metadata: { phase: 'final_response' },
  });

  const rawContent = finalResponse.choices[0]?.message?.content ?? 'I have completed the requested actions.';
  const { cleanContent, agentState } = extractAgentState(rawContent);

  const result = buildResult({
    message: cleanContent,
    events,
    credentialRequests,
    approvalRequests,
    workflowId,
    workflowUrl,
    workflowComplete,
    agentState,
    currentSlots,
    safetyMode: policy.mode,
    workflowGraph,
    agentTasks,
    automationBrain,
  });

  await emitRuntimeEvent({
    eventType: 'agent.completed',
    userId,
    sessionId,
    workflowId,
    agentId: 'planner',
    correlationId,
    traceId,
    spanId: plannerSpanId,
    payload: { workflowComplete, approvalsPending: approvalRequests.length, finalResponse: true },
  });

  await endSpan({ userId, spanId: plannerSpanId, status: 'success' });
  await finishTrace({ userId, traceId, status: 'completed' });

  await onProgress?.({
    type: 'phase',
    message: 'Finalizing your automation...',
  });

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractAgentState(content: string): {
  cleanContent: string;
  agentState: Record<string, unknown> | null;
} {
  const match = /<agent_state>([\s\S]*?)<\/agent_state>/i.exec(content);
  if (!match) return { cleanContent: content.trim(), agentState: null };

  const cleanContent = content.replace(/<agent_state>[\s\S]*?<\/agent_state>/i, '').trim();
  try {
    const agentState = JSON.parse(match[1]!) as Record<string, unknown>;
    return { cleanContent, agentState };
  } catch {
    return { cleanContent, agentState: null };
  }
}

function buildResult(params: {
  message: string;
  events: AgentEvent[];
  credentialRequests: Array<{ provider: string; reason: string; instructions?: string }>;
  approvalRequests: Array<{ actionKey: string; actionType: string; reason: string; status: string }>;
  workflowId?: string;
  workflowUrl?: string;
  workflowComplete: boolean;
  agentState: Record<string, unknown> | null;
  currentSlots: ConversationSlots;
  safetyMode: SafetyMode;
  workflowGraph?: WorkflowGraphSummary;
  agentTasks: AgentTask[];
  automationBrain?: AutomationBrainResult;
}): AgentTurnResult {
  const {
    message,
    events,
    credentialRequests,
    approvalRequests,
    workflowId,
    workflowUrl,
    workflowComplete,
    agentState,
    currentSlots,
    safetyMode,
    workflowGraph,
    agentTasks,
    automationBrain,
  } = params;

  const validStatuses = ['collecting_requirements', 'waiting_integrations', 'ready_to_build', 'blocked_low_confidence'] as const;

  const inferredRequiredIntegrations = Array.from(
    new Set([
      ...credentialRequests.map((request) => request.provider).filter(Boolean),
      ...(currentSlots.platform ? [currentSlots.platform] : []),
      ...(currentSlots.destination ? [currentSlots.destination] : []),
      ...(currentSlots.ai_provider ? [currentSlots.ai_provider] : []),
    ])
  );

  const inferredReadyFromEvents =
    workflowComplete ||
    Boolean(workflowGraph) ||
    events.some((event) => ['generating_workflow', 'deploying', 'activating', 'workflow_ready'].includes(event.type));

  const plannerStatus = agentState?.planner_status &&
    validStatuses.includes(agentState.planner_status as typeof validStatuses[number])
    ? (agentState.planner_status as AgentTurnResult['planner_status'])
    : credentialRequests.length > 0
    ? 'waiting_integrations'
    : inferredReadyFromEvents
    ? 'ready_to_build'
    : 'collecting_requirements';

  const slotsUpdate: Partial<ConversationSlots> = {};
  if (agentState?.slots && typeof agentState.slots === 'object') {
    Object.assign(slotsUpdate, agentState.slots as Partial<ConversationSlots>);
  }

  const inferredCanonicalPrompt = [
    currentSlots.trigger ? `Trigger: ${currentSlots.trigger}` : null,
    currentSlots.platform ? `Platform: ${currentSlots.platform}` : null,
    currentSlots.action ? `Action: ${currentSlots.action}` : null,
    currentSlots.destination ? `Destination: ${currentSlots.destination}` : null,
    currentSlots.ai_provider ? `AI: ${currentSlots.ai_provider}` : null,
  ]
    .filter(Boolean)
    .join('. ');

  return {
    assistant_message: message,
    options: Array.isArray(agentState?.options) ? (agentState!.options as string[]) : undefined,
    events,
    slots_update: slotsUpdate,
    workflow_complete: workflowComplete,
    workflow_id: workflowId,
    workflow_url: workflowUrl,
    credential_requests: credentialRequests,
    ready_to_build: agentState?.ready_to_build === true || inferredReadyFromEvents,
    canonical_prompt: agentState?.canonical_prompt
      ? String(agentState.canonical_prompt)
      : inferredCanonicalPrompt || undefined,
    confidence: typeof agentState?.confidence === 'number' ? agentState.confidence : inferredReadyFromEvents ? 88 : 68,
    planner_status: plannerStatus,
    missing_fields: Array.isArray(agentState?.missing_fields) ? (agentState!.missing_fields as string[]) : [],
    required_integrations: Array.isArray(agentState?.required_integrations)
      ? (agentState!.required_integrations as string[])
      : inferredRequiredIntegrations,
    approval_requests: approvalRequests,
    safety_mode: safetyMode,
    workflow_graph: workflowGraph,
    agent_tasks: agentTasks,
    automation_brain: automationBrain,
  };
}

function shouldStartAutonomousBuild(params: {
  userMessage: string;
  currentSlots: ConversationSlots;
}): boolean {
  const message = params.userMessage.toLowerCase();
  const hasIntentVerb = /(build|create|set up|setup|automate|generate|deploy|draft|make|connect|sync|route|send)/i.test(message);
  const hasDomainSignal = /(gmail|email|slack|shopify|airtable|webhook|workflow|automation|reply|lead|ticket|order|message|form|crm|database|sms|calendar|notion)/i.test(message);
  const hasWorkflowSignal = /(workflow|automation|trigger|action|sequence|flow|pipeline)/i.test(message);
  const hasEnoughSlots = [params.currentSlots.trigger, params.currentSlots.action, params.currentSlots.platform].filter(Boolean).length >= 2;
  const hasClearBuildIntent = hasIntentVerb && (hasDomainSignal || hasWorkflowSignal);
  return hasClearBuildIntent || hasEnoughSlots;
}

function hasExplicitDeployIntent(message: string): boolean {
  const text = message.toLowerCase();
  return /(approve\s*(and)?\s*deploy|deploy\s*(now|it)?|proceed\s*with\s*deploy|ship\s*it|go\s*live|activate\s*workflow|start\s*deployment)/i.test(text);
}


