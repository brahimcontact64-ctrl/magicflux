/**
 * MagicFlux Autonomous Agent — Tool Executor
 *
 * Executes tool calls decided by OpenAI. Each tool interacts with real infrastructure.
 */

import {
  getWorkflowStatus,
  listExecutions,
  runTestExecution,
  type N8nConfig,
} from '@/lib/ai-engine/n8n-deployer';
import { providerCredentialIsValid } from '@/lib/conversation-agent';
import { requiredProvidersFromWorkflow } from '@/lib/integrations';
import OpenAI from 'openai';
import { recordAgentActionEvent, recordAiUsage } from './observability';
import { buildWorkflowGraphSummary } from './workflow-graph';
import type { ExecutionPolicy } from './safety';
import { createCorrelationId, emitRuntimeEvent } from '@/lib/runtime/events';
import { enqueueRuntimeJob, runtimeQueueForTool, runtimeTaskTypeForTool } from '@/lib/runtime/queue';
import { getToolExecutionPolicy } from '@/lib/runtime/tool-policy';
import { createTraceId, endSpan, startSpan } from '@/lib/runtime/tracing';
import { createServiceClient } from '@/lib/supabase-server';
import { liveGraphManager } from '@/lib/graph/live-graph-manager';
import { extractAllProvidersFromWorkflowGraph, hasForbiddenProviderPattern, isCanonicalProvider, isInternalProviderLabel, normalizeProvider, toProviderToken } from '@/lib/agent/provider-allowlist';
import { getProviderCredentialSchema } from '@/lib/agent/provider-credential-registry';
import { findIncapableNodes } from '@/lib/agent/capability-filter';
import { SUPPORTED_TRIGGER_TYPES, isSupportedTriggerType } from '@/lib/agent/tools';
import { checkConcreteValuesPreserved } from '@/lib/agent/concrete-value-guard';
import {
  detectOneTimeSchedulePhrase,
  isValidIanaTimezone,
  validateCanonicalScheduleTrigger,
  ONE_TIME_SCHEDULE_REJECTION_MESSAGE,
  MISSING_TIMEZONE_MESSAGE,
} from '@/lib/agent/schedule-guard';
import { validateBranchConnections } from '@/lib/agent/branch-connection-guard';
import { validateAiClassificationClaim } from '@/lib/agent/ai-classification-guard';
import { validateHumanReviewClaim } from '@/lib/agent/human-review-guard';
import { validateNoInventedAirtableIds } from '@/lib/agent/airtable-config-guard';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolResult = {
  tool: string;
  success: boolean;
  /** Data to send back as the tool result message */
  output: Record<string, unknown>;
  /** Optional agent-visible event for the UI stream */
  event?: AgentEvent;
  retryCount?: number;
};

export type AgentEventType =
  | 'thinking'
  | 'generating_workflow'
  | 'deploying'
  | 'activating'
  | 'testing'
  | 'requesting_credential'
  | 'explaining_architecture'
  | 'workflow_ready'
  | 'approval_required'
  | 'policy_blocked'
  | 'retrying'
  | 'rolled_back'
  | 'error';

export type AgentEvent = {
  type: AgentEventType;
  label: string;
  detail?: string;
  workflowId?: string;
  workflowUrl?: string;
  agent?: 'planner' | 'integration' | 'deploy' | 'monitoring' | 'recovery';
};

export type ExecutionContext = {
  userId: string | null;
  sessionId: string;
  policy: ExecutionPolicy;
  correlationId?: string;
  traceId?: string;
  parentSpanId?: string;
  /**
   * Phase 9.8.7 -- the current turn's raw/canonical user message, passed
   * through unmodified from lib/agent/loop.ts's `latestUserMessage`. Never
   * a credential/secret -- just the user's own request text. Used so
   * generate_workflow_json's second-stage generation (and its
   * post-generation guard) can preserve concrete literals (recipient
   * address, subject, message) the user actually typed, instead of relying
   * solely on the outer tool-call's own summarized arguments.
   */
  rawUserIntent?: string;
};

// ---------------------------------------------------------------------------
// n8n config from environment
// ---------------------------------------------------------------------------

function getN8nConfig(): N8nConfig {
  const apiUrl = process.env.N8N_API_URL ?? 'http://localhost:5678';
  const apiKey = process.env.N8N_API_KEY ?? '';
  return { apiUrl, apiKey };
}

function parseWorkflowJson(value: unknown): { nodes: object[]; connections: object } {
  const parsed = JSON.parse(String(value ?? '{}')) as { nodes?: object[]; connections?: object };
  return {
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    connections: parsed.connections ?? {},
  };
}

/**
 * Persists a workflow row (insert or update) for the given generated
 * workflow_json. Phase 9.8.1 -- called from generate_workflow_json's own
 * success path immediately upon generation, so the workflow the user
 * reviews always has a stable, addressable id before Approve + Deploy can
 * even be clicked. Returns null only when there's no authenticated user
 * (anonymous/unauthenticated sessions never persist).
 */
export async function ensurePersistedWorkflowDraft(params: {
  userId: string | null;
  sessionId: string;
  args: Record<string, unknown>;
}): Promise<string | null> {
  if (!params.userId) return null;

  const db = createServiceClient();
  const workflowName = String(params.args.workflow_name ?? 'MagicFlux Workflow').trim() || 'MagicFlux Workflow';
  const workflowData = parseWorkflowJson(params.args.workflow_json);
  const workflowJson = {
    nodes: workflowData.nodes,
    connections: workflowData.connections,
  };

  const existingWorkflowId = params.args.workflow_id ? String(params.args.workflow_id).trim() : '';
  let workflowId = existingWorkflowId;

  if (workflowId) {
    const { error } = await db
      .from('workflows')
      .update({
        name: workflowName,
        workflow_json: workflowJson,
        integrations: requiredProvidersFromWorkflow(workflowJson),
        status: 'draft',
        updated_at: new Date().toISOString(),
      })
      .eq('id', workflowId)
      .eq('user_id', params.userId);

    if (error) throw error;
  } else {
    const { data, error } = await db
      .from('workflows')
      .insert({
        user_id: params.userId,
        name: workflowName,
        description: 'Generated by the AI Builder chat',
        prompt: workflowName,
        workflow_json: workflowJson,
        integrations: requiredProvidersFromWorkflow(workflowJson),
        status: 'draft',
      })
      .select('id')
      .single();

    if (error) throw error;
    workflowId = String(data.id);
  }

  const graphVersion = await liveGraphManager.createGraphVersion(
    params.userId,
    workflowId,
    workflowJson,
    {
      changesDescription: 'Initial graph persisted immediately after generation',
      changedBy: 'ai',
    }
  );

  const { error: mutationError } = await db.from('workflow_graph_mutations').insert({
    user_id: params.userId,
    workflow_id: workflowId,
    version: graphVersion.version,
    mutation_type: 'update_node',
    reason: 'Initial workflow graph snapshot at generation time',
    patch: {
      source: 'executor_prequeue',
      node_count: workflowData.nodes.length,
    },
    diff: {
      initialized: true,
      node_count: workflowData.nodes.length,
    },
    created_at: new Date().toISOString(),
  });

  if (mutationError) throw mutationError;

  const { error: conversationUpdateError } = await db
    .from('automation_conversations')
    .update({
      workflow_id: workflowId,
      updated_at: new Date().toISOString(),
    })
    .eq('session_id', params.sessionId)
    .eq('user_id', params.userId);

  if (conversationUpdateError) {
    const message = String(conversationUpdateError.message ?? conversationUpdateError);
    if (!/workflow_id/i.test(message) || !/column/i.test(message)) {
      throw conversationUpdateError;
    }
  }

  params.args.workflow_id = workflowId;
  params.args.workflow_json = JSON.stringify(workflowJson);

  return workflowId;
}

// ---------------------------------------------------------------------------
// Workflow JSON generator — uses OpenAI to build real n8n node JSON
// ---------------------------------------------------------------------------

async function generateWorkflowJson(params: {
  userId: string | null;
  sessionId: string;
  correlationId: string;
  workflow_name: string;
  trigger: string;
  action: string;
  /** Phase 9.8.2 -- optional. Genuinely internal automations (branch +
   * assign a field, no external system involved) have no real platform;
   * an empty string here means "none", not "unspecified". */
  platform?: string;
  destination?: string;
  ai_provider?: string;
  schedule?: string;
  /** Phase 9.8.8 -- required IANA timezone whenever trigger === 'schedule'; see schedule-guard.ts. */
  timezone?: string;
  automation_style?: string;
  required_capabilities?: string[];
  skill_packs?: string[];
  block_blueprint?: string[];
  requested_providers?: string[];
  nodes_description: string;
  /**
   * Phase 9.8.7 -- the user's own raw request text (never a credential),
   * passed alongside the outer agent's summarized arguments so this
   * generation call can preserve concrete literals (an exact recipient
   * address, subject, message) verbatim even when nodes_description only
   * describes the automation's shape rather than repeating its content.
   */
  raw_user_intent?: string;
}): Promise<{
  nodes: object[];
  connections: object;
  explanation: string;
  usage: { promptTokens: number; completionTokens: number };
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const openai = new OpenAI({ apiKey });

  await emitRuntimeEvent({
    eventType: 'ai.request.started',
    userId: params.userId,
    sessionId: params.sessionId,
    correlationId: params.correlationId,
    agentId: 'deploy',
    payload: { model: 'gpt-4o', purpose: 'generate_workflow_json' },
  });

  // Phase 9.8.2 -- confirmed live in production (Founder manual re-test
  // after 9.8.1): a request to "mark/classify/tag/set [field] as [value]
  // if [condition]" was repeatedly interpreted as needing an external
  // messaging platform (Telegram) or a provider-specific "order
  // management" action, when it is really just n8n-nodes-base.if +
  // n8n-nodes-base.set -- fully supported, deterministic primitives. The
  // upstream tool schema (lib/agent/tools.ts) now makes platform optional
  // and gives internal-transformation examples for action/block_blueprint,
  // but this prompt is the last line of defense: it states the
  // deterministic-primitive rule FIRST, unconditionally, before any
  // platform-specific instructions, and only mentions Platform at all when
  // one was actually given.
  const hasPlatform = Boolean(params.platform && params.platform.trim());

  const rawUserIntent = params.raw_user_intent?.trim();

  const prompt = `You are an expert n8n workflow engineer. Generate a complete, valid n8n workflow JSON for this automation.

CRITICAL RULE -- read this before anything else: many automations only need to branch on a condition and derive/assign a field value that is ALREADY DETERMINISTICALLY COMPUTABLE from the input (e.g. "mark as VIP if amount > 100", "set status to approved/rejected based on a numeric threshold", "tag as qualified/unqualified based on an exact match"). For these, use ONLY n8n-nodes-base.if (branching) and n8n-nodes-base.set (field assignment) -- do NOT invent a messaging step (Telegram, WhatsApp, Slack, email, etc.), a notification, or a CRM/"order management"-style external action unless the request explicitly names a real external platform or asks to send/post/notify something to a named destination. When in doubt and no real platform was requested below, prefer if + set over any external action. This does NOT apply to genuine AI-based classification/judgment (see the AI CLASSIFICATION CONTRACT below) -- see that section instead when the decision requires interpreting unstructured criteria, not a deterministic formula already present in the data.

AI CLASSIFICATION CONTRACT -- MANDATORY whenever this automation needs to classify, score, detect intent/sentiment, or otherwise make an AI-based judgment call about incoming data that is NOT a deterministic formula already present in the input (e.g. "classify this lead as Hot/Warm/Cold based on budget, urgency, and purchase intent", "detect the customer's intent", "route by sentiment", "extract structured fields from free text"): you MUST insert a real AI classification node with type EXACTLY "magicflux-nodes.aiClassifier" immediately after the trigger (or after any deterministic pre-processing) and BEFORE any n8n-nodes-base.if node that branches on its result. Never branch on a field (e.g. $json["classification"]) that no upstream node in this same graph actually computes -- an IF node reading a field nothing produces is a placeholder, not real AI classification, and will be rejected. The aiClassifier node's "parameters" must include:
  - "instruction": a clear natural-language description of exactly what to classify/decide and on what basis, copied from the request's own criteria.
  - "allowedLabels": an array of the exact allowed output label strings (e.g. ["Hot","Warm","Cold"]).
  - "outputField": the field name downstream IF nodes will read (defaults to "classification" if omitted -- prefer the default unless the request names a different field).
  - "confidenceThreshold": optional number in [0,1] (defaults to 0.6) -- below this, the node reports needs_review:true instead of guessing; if the request mentions flagging uncertain/low-confidence cases for human review, route that case to a real magicflux-nodes.humanReview node (see HUMAN REVIEW CONTRACT below) -- NEVER a plain IF node checking needs_review, which only inspects a value, it never actually creates anything a human can act on.
Every downstream IF node that reads the classification MUST branch on exactly "={{$json[\"<outputField>\"]}}" -- the literal field the aiClassifier node writes. Do NOT use this node type for a deterministic threshold/exact-match branch (e.g. "if amount > 100") -- that stays n8n-nodes-base.if directly on the real input field, no AI step needed.

HUMAN REVIEW CONTRACT -- MANDATORY whenever this automation needs to pause for a real person to approve, reject, or otherwise decide an outcome (e.g. "flag for human review instead of guessing", "require approval before proceeding", "escalate risky/uncertain cases to a human", refund/order/content approval): you MUST insert a real node with type EXACTLY "magicflux-nodes.humanReview". This is a genuinely new, real, supported node type in this product (like magicflux-nodes.aiClassifier) -- NEVER represent "human review"/"approval" using n8n-nodes-base.set (it is a data no-op, not a pause) or n8n-nodes-base.if alone (it only reads a value, it creates no durable record a human can act on and does not actually pause anything). The humanReview node's "parameters" must include:
  - "instruction": a clear natural-language description of what the reviewer needs to decide.
  - "allowedOutcomes": an array of the exact decision outcome strings (defaults to ["approve","reject"] if omitted -- prefer the default two-outcome shape unless the request names specific custom outcomes).
Like an IF node, its connections MUST use separate output-port arrays in the SAME order as "allowedOutcomes" (main[0] for the first outcome, main[1] for the second, etc.), each present as its own array even if empty -- never collapsed into one port. Place it wherever the pause should happen (e.g. immediately after an aiClassifier node's low-confidence/needs_review case, or directly after the trigger for an approval-gated action).

AIRTABLE CONFIGURATION CONTRACT -- MANDATORY for every n8n-nodes-base.airtable node: you have NO knowledge of the founder's real Airtable base/table/field schema, so you MUST NOT invent a base id (e.g. "appXXXXXXXXXXXXXX"), a table id (e.g. "tblXXXXXXXXXXXXXX"), or guess that a made-up id is real. Parameters must be exactly:
  - "baseId": leave this an EMPTY STRING "" -- real base selection happens in a separate, real schema-picker step in the Builder after Airtable is connected, never here.
  - "tableId": leave this an EMPTY STRING "" for the same reason.
  - "operation": one of create/update/list/get/delete (default "create" if the request just says "save"/"log"/"add" to Airtable).
  - "fields": an object whose KEYS are descriptive/semantic names for what each value represents (e.g. "Name", "Email", "Classification") based on the request -- these are a proposed mapping the founder will reconcile against their table's REAL field names in that same configuration step, not real field identifiers themselves. VALUES follow the same concrete-value-preservation rule as every other node (verbatim literals/expressions, never placeholders).
Never use "application"/"applicationId"/"base"/"table"/"tableName" as parameter keys -- they are not read by anything and only existed in workflows generated before this contract.

CRITICAL RULE -- concrete values are authoritative: if the raw request below contains an exact literal value the workflow needs -- a recipient email address, a subject line, a message/body, a Slack channel name, a webhook path, or any other concrete parameter -- that literal MUST be copied verbatim into the corresponding node parameter. This applies to every action type, not only email. NEVER invent, generalize, or replace a literal the user actually provided with placeholder/template text such as "recipient@example.com", "Your Subject Here", "Your message content here", "#channel", or similar -- those are only acceptable when the user genuinely did not specify a real value for that field.

${rawUserIntent ? `Raw User Request (authoritative source for exact literals -- read this for the real recipient/subject/message/channel/etc.):\n"${rawUserIntent}"\n` : ''}
Workflow Name: ${params.workflow_name}
Trigger: ${params.trigger}
Action: ${params.action}
${hasPlatform ? `Platform: ${params.platform}` : 'Platform: none -- this automation has no external platform. Do not introduce one.'}
${params.destination ? `Destination: ${params.destination}` : ''}
${params.ai_provider ? `AI Provider: ${params.ai_provider}` : ''}
${params.schedule ? `Schedule: ${params.schedule}` : ''}
${params.trigger === 'schedule' ? `
SCHEDULE TRIGGER CONTRACT -- MANDATORY: this automation is time-triggered. The trigger node's "type" MUST be exactly "n8n-nodes-base.scheduleTrigger" -- never n8n-nodes-base.cron, never a wait/delay/interval/timer node, never any other invented alternate. Its "parameters" MUST include:
  - "cronExpression": a valid 5-field cron expression that implements the recurring cadence described below (interpret the schedule as a RECURRING cadence only -- never a one-time absolute date/time).
  - "timezone": exactly "${params.timezone}" (copy this literal string -- do not omit it, do not substitute UTC or any other timezone).
` : ''}
${params.automation_style ? `Style: ${params.automation_style}` : ''}
${params.required_capabilities && params.required_capabilities.length > 0 ? `Required Capabilities: ${params.required_capabilities.join(', ')}` : ''}
${params.skill_packs && params.skill_packs.length > 0 ? `Activated Skill Packs: ${params.skill_packs.join(', ')}` : ''}
${params.block_blueprint && params.block_blueprint.length > 0 ? `Block Blueprint: ${params.block_blueprint.join(' -> ')}` : ''}
${params.requested_providers && params.requested_providers.length > 0 ? `Requested Providers (STRICT): ${params.requested_providers.join(', ')}` : ''}
Description: ${params.nodes_description}

Return a JSON object with this exact structure:
{
  "nodes": [ /* array of valid n8n node objects */ ],
  "connections": { /* n8n connections map */ },
  "explanation": "Clear 4-6 step numbered explanation of how this workflow operates"
}

Use real n8n node types (e.g. n8n-nodes-base.gmailTrigger, n8n-nodes-base.openAi, etc.), EXCEPT for the two MagicFlux-native capabilities: "magicflux-nodes.aiClassifier" (see AI CLASSIFICATION CONTRACT above) and "magicflux-nodes.humanReview" (see HUMAN REVIEW CONTRACT above) -- both are genuine, real, supported node types in this product, not n8n nodes, and must be spelled EXACTLY that way when used.
Each node must have: id, name, type, typeVersion, position [x,y], parameters, displayName, provider.
For provider use ONLY these canonical ids: stripe, airtable, openai, slack, gmail, google_drive, google_sheets, telegram, shopify, hubspot, elevenlabs, claude, facebook, canva, twitter, whatsapp, cloudflare_ai, deepgram, supabase. n8n-nodes-base.if, n8n-nodes-base.set, magicflux-nodes.aiClassifier, and magicflux-nodes.humanReview need NO provider at all (leave provider null) -- they are internal/platform-native nodes, never an external system.
Forbidden provider names: notification, notification_action, send_message, email, storage, upload, file_upload, team_chat, ai, utility, action, document_extraction, payment_action, order_management, monitoring.
Never invent provider names. No aliases. No fallback names.
Do not emit credentialSchema or credential defaults; provider credentialSchema is hydrated server-side from canonical providerCredentialRegistry.
Do not emit generic provider placeholders; attach provider metadata directly on every node.
Do NOT use n8n-nodes-base.code, n8n-nodes-base.function, or any custom-code/scripting node -- arbitrary code execution is not available in this product yet. For data shaping, field mapping, marking, classifying, or tagging, use n8n-nodes-base.set (direct field assignment only, no expressions or scripting). If the automation genuinely requires custom logic that set/if/an available action cannot express, say so plainly in the explanation rather than inventing a code node or an unrequested external platform.

CONDITIONAL/BRANCH CONNECTIONS CONTRACT -- MANDATORY for n8n-nodes-base.if, switch, condition, or filter nodes: the branch a downstream node belongs to is encoded ONLY by which position it occupies in the SOURCE node's own "main" array -- "connections['Node Name'].main" MUST be an array with a SEPARATE array entry per output port: main[0] = every target reached on the TRUE branch, main[1] = every target reached on the FALSE branch. Each of main[0] and main[1] MUST be present as its own array, even if a branch has no downstream target at all (use an empty array [] for that branch -- never omit the port entirely). NEVER put both branches' targets into the same main[0] array and try to distinguish them using the target object's own "index" field -- that field is the TARGET's input port (always 0 for a single-input node), not the source branch, and is silently ignored by the runtime for this purpose. Example of the ONLY correct shape for an if node with true->A and false->B:
"connections": { "My If": { "main": [ [ { "node": "A", "type": "main", "index": 0 } ], [ { "node": "B", "type": "main", "index": 0 } ] ] } }
Keep it production-ready and deployable.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 3000,
  });

  const raw = response.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw) as {
    nodes?: object[];
    connections?: object;
    explanation?: string;
  };

  const normalizedNodes = (Array.isArray(parsed.nodes) ? parsed.nodes : []).map((rawNode) => {
    const node = { ...(rawNode as Record<string, unknown>) };
    const providerMeta = typeof node.parameters === 'object' && node.parameters !== null
      ? ((node.parameters as Record<string, unknown>).providerMeta as Record<string, unknown> | undefined)
      : undefined;
    const rawProvider =
      (typeof node.provider === 'string' ? node.provider : undefined)
      ?? (typeof node.integration === 'string' ? node.integration : undefined)
      ?? (typeof providerMeta?.provider === 'string' ? providerMeta.provider : undefined)
      ?? '';
    const normalizedProvider = normalizeProvider(String(rawProvider));
    const provider = normalizedProvider && isCanonicalProvider(normalizedProvider)
      ? normalizedProvider
      : null;

    const credentialSchema = getProviderCredentialSchema(provider);
    const requiresCredentials = credentialSchema.length > 0;

    const normalizedNode: Record<string, unknown> & { parameters?: Record<string, unknown> } = {
      ...node,
      parameters: typeof node.parameters === 'object' && node.parameters !== null
        ? (node.parameters as Record<string, unknown>)
        : undefined,
      displayName: String(node.displayName ?? node.name ?? 'Workflow Node'),
      provider,
      requiresCredentials,
      credentialSchema,
    };

    return normalizedNode;
  });

  await emitRuntimeEvent({
    eventType: 'ai.request.completed',
    userId: params.userId,
    sessionId: params.sessionId,
    correlationId: params.correlationId,
    agentId: 'deploy',
    payload: {
      model: 'gpt-4o',
      prompt_tokens: response.usage?.prompt_tokens ?? 0,
      completion_tokens: response.usage?.completion_tokens ?? 0,
    },
  });

  return {
    nodes: normalizedNodes,
    connections: parsed.connections ?? {},
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : 'Workflow generated.',
    usage: {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool executor — maps tool name → real implementation
// ---------------------------------------------------------------------------

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ExecutionContext
): Promise<ToolResult> {
  const n8n = getN8nConfig();
  const startedAt = Date.now();
  const correlationId = ctx.correlationId ?? createCorrelationId(ctx.sessionId);
  const traceId = ctx.traceId ?? createTraceId();
  const executionId = `${toolName}-${Date.now()}`;
  const toolSpanId = await startSpan({
    userId: ctx.userId,
    traceId,
    parentSpanId: ctx.parentSpanId,
    name: `tool:${toolName}`,
    kind: 'tool',
    agentId: 'runtime',
    sessionId: ctx.sessionId,
    workflowId: args.workflow_id ? String(args.workflow_id) : undefined,
    executionId,
    attributes: { args },
  });
  let failed = false;

  await recordAgentActionEvent({
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    eventType: 'tool_started',
    actionName: toolName,
    status: 'info',
    detail: `Starting ${toolName}`,
    metadata: { args },
  });

  await emitRuntimeEvent({
    eventType: 'tool.started',
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    workflowId: args.workflow_id ? String(args.workflow_id) : undefined,
    executionId,
    correlationId,
    traceId,
    spanId: toolSpanId,
    parentSpanId: ctx.parentSpanId,
    agentId: 'runtime',
    payload: { toolName, args },
  });

  try {
    const toolPolicy = getToolExecutionPolicy(toolName);
    // Phase 9.8.1 -- deploy_workflow_to_n8n and activate_workflow removed
    // from this gate (and from AGENT_TOOLS entirely -- see lib/agent/tools.ts).
    // test_workflow is the only tool still routed through deploy_queue's
    // async worker.
    const shouldQueue = toolName === 'test_workflow';

    if (shouldQueue) {
      const queued = await enqueueRuntimeJob({
        queueName: runtimeQueueForTool(toolName),
        taskType: runtimeTaskTypeForTool(toolName),
        payload: {
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          workflowId: args.workflow_id ? String(args.workflow_id) : undefined,
          toolName,
          policyMode: ctx.policy.mode,
          args,
          correlationId,
          executionId,
          traceId,
          parentSpanId: toolSpanId,
        },
        attempts: toolPolicy.retry.attempts + 1,
      });

      if (!queued.enqueued) {
        return {
          tool: toolName,
          success: false,
          output: {
            error_code: 'RUNTIME_NOT_CONFIGURED',
            error: queued.reason ?? 'Queue unavailable',
            queued: false,
          },
          event: {
            type: 'error',
            label: 'I could not start execution right now',
            detail: queued.reason ? 'Runtime is temporarily unavailable. Please retry in a moment.' : undefined,
            agent: 'recovery',
          },
        };
      }

      return {
        tool: toolName,
        success: true,
        output: {
          queued: true,
          queue_job_id: queued.queueJobId,
          queue: runtimeQueueForTool(toolName),
          execution_id: executionId,
          correlation_id: correlationId,
          message: `${toolName} queued for deterministic runtime worker execution`,
        },
        event: {
          type: 'testing',
          label: 'Testing your automation...',
          detail: 'Test run is being prepared.',
          agent: 'deploy',
        },
      };
    }

    switch (toolName) {
      // -----------------------------------------------------------------------
      case 'generate_workflow_json': {
        // Phase 9.8.6 -- defense in depth: the tool schema's `enum` (tools.ts)
        // is a strong hint but not a cryptographic guarantee against every
        // possible model deviation. Fail closed on an unrecognized trigger
        // rather than silently forwarding it as free text into the
        // generation prompt, where it could produce an unsupported or
        // unintended node (e.g. an externally-callable webhook nobody asked
        // for).
        const rawTrigger = String(args.trigger ?? '');
        if (!isSupportedTriggerType(rawTrigger)) {
          return {
            tool: toolName,
            success: false,
            output: {
              error: `Unsupported trigger type: "${rawTrigger}". Supported trigger types: ${SUPPORTED_TRIGGER_TYPES.join(', ')}.`,
              unsupported_trigger: rawTrigger,
            },
            event: {
              type: 'error',
              label: 'Unsupported trigger type requested',
              detail: `"${rawTrigger}" is not a supported trigger type.`,
              agent: 'planner',
            },
          };
        }

        // Phase 9.8.8 -- Schedule Contract Truth. Two fail-closed checks run
        // BEFORE generation is even attempted, so a request the runtime
        // cannot honestly represent never reaches the model at all:
        //   (a) a one-time/absolute schedule phrase must never be silently
        //       forced into a recurring cron (MagicFlux's scheduler is
        //       recurring-cron only -- see schedule-guard.ts's module doc).
        //   (b) a schedule trigger requires an explicit, real IANA timezone;
        //       it must never silently default to UTC.
        let scheduleTimezone: string | undefined;
        if (rawTrigger === 'schedule') {
          const scheduleText = String(args.schedule ?? '').trim() || (ctx.rawUserIntent ?? '');
          if (detectOneTimeSchedulePhrase(scheduleText)) {
            return {
              tool: toolName,
              success: false,
              output: {
                error: ONE_TIME_SCHEDULE_REJECTION_MESSAGE,
                one_time_schedule_unsupported: true,
              },
              event: {
                type: 'error',
                label: 'One-time scheduling is not supported yet',
                detail: ONE_TIME_SCHEDULE_REJECTION_MESSAGE,
                agent: 'planner',
              },
            };
          }

          const tzArg = String(args.timezone ?? '').trim();
          if (!isValidIanaTimezone(tzArg)) {
            return {
              tool: toolName,
              success: false,
              output: {
                error: MISSING_TIMEZONE_MESSAGE,
                missing_timezone: true,
              },
              event: {
                type: 'error',
                label: 'Timezone required for scheduled workflow',
                detail: MISSING_TIMEZONE_MESSAGE,
                agent: 'planner',
              },
            };
          }
          scheduleTimezone = tzArg;
        }

        const requiredCapabilities = Array.isArray(args.required_capabilities)
          ? args.required_capabilities.map((value) => String(value).trim()).filter(Boolean)
          : [];
        const skillPacks = Array.isArray(args.skill_packs)
          ? args.skill_packs.map((value) => String(value).trim()).filter(Boolean)
          : [];
        const blockBlueprint = Array.isArray(args.block_blueprint)
          ? args.block_blueprint.map((value) => String(value).trim()).filter(Boolean)
          : [];

        const result = await generateWorkflowJson({
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          correlationId,
          workflow_name: String(args.workflow_name ?? 'My Workflow'),
          trigger: String(args.trigger ?? ''),
          action: String(args.action ?? ''),
          platform: String(args.platform ?? ''),
          destination: args.destination ? String(args.destination) : undefined,
          ai_provider: args.ai_provider ? String(args.ai_provider) : undefined,
          schedule: args.schedule ? String(args.schedule) : undefined,
          timezone: scheduleTimezone,
          automation_style: args.automation_style ? String(args.automation_style) : undefined,
          required_capabilities: requiredCapabilities,
          skill_packs: skillPacks,
          block_blueprint: blockBlueprint,
          requested_providers: Array.isArray(args.requested_providers)
            ? args.requested_providers.map((value) => String(value)).filter(Boolean)
            : undefined,
          nodes_description: String(args.nodes_description ?? ''),
          raw_user_intent: ctx.rawUserIntent,
        });

        await recordAiUsage({
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          provider: 'openai',
          model: 'gpt-4o',
          agentName: 'deploy',
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          metadata: { tool: toolName },
        });

        const workflowGraph = buildWorkflowGraphSummary({
          nodes: result.nodes,
          connections: result.connections,
        });

        // Phase 9.5.1A: this is the primary, LLM-driven canonical
        // generation path (the /builder chat flow, via runAgentLoop ->
        // this tool) -- unlike lib/planner's deterministic path, it had no
        // capability check at all before this. The prompt given to the
        // model (see generateWorkflowJson() above) now steers it away from
        // code/function nodes, but that's guidance, not a guarantee; this
        // is the deterministic backstop. Uses the same authoritative
        // checkNodeCapability() every other path (planner, both
        // validators, runtime dispatch) already uses -- one source of
        // truth, not a second blocklist. A capability failure is reported
        // back into the loop the same way the provider-parity check below
        // already does (success:false with a safe, non-technical reason),
        // never silently dropped or replaced with a node that can't
        // actually do what was asked.
        const incapableNodes = findIncapableNodes(result.nodes);

        if (incapableNodes.length > 0) {
          const reasons = Array.from(new Set(incapableNodes.map((n) => n.userMessage)));
          return {
            tool: toolName,
            success: false,
            output: {
              error: reasons.join(' '),
              capability_unavailable: true,
              unsupported_steps: incapableNodes.map((n) => n.name),
            },
            event: {
              type: 'error',
              label: 'Unsupported capability requested',
              detail: reasons.join(' '),
              agent: 'planner',
            },
          };
        }

        // Phase 9.9.0 -- deterministic backstop against a conditional node
        // (if/switch/condition/filter) whose generated connections collapse
        // true/false branches into a single output port instead of
        // separate main[0]/main[1] arrays. Confirmed live in production:
        // this produces a graph that renders correctly in the Builder but
        // executes identical downstream nodes for every branch outcome
        // (runtime/workflow-engine.ts's branch dispatch only ever looks at
        // the taken branch's own port -- a real branch never falls back to
        // "fire every port" -- so a collapsed graph must be rejected here
        // rather than silently persisted as something the runtime cannot
        // actually route the way it looks).
        const branchCheck = validateBranchConnections(result.nodes, result.connections);
        if (!branchCheck.ok) {
          return {
            tool: toolName,
            success: false,
            output: {
              error: branchCheck.reason,
              malformed_branch_connections: true,
              node: branchCheck.node,
            },
            event: {
              type: 'error',
              label: 'Generated workflow has malformed branch connections',
              detail: branchCheck.reason,
              agent: 'planner',
            },
          };
        }

        // Phase 9.9.1 -- product-truth backstop: a request that plausibly
        // claims AI-based classification/decision-making (see
        // ai-classification-guard.ts's vocabulary) must be backed by a real
        // magicflux-nodes.aiClassifier node in the generated graph.
        // Confirmed live in production: the Builder narrated "AI analyzes
        // the lead based on budget, urgency, and purchase intent" while the
        // generated graph contained zero AI-inference nodes -- just an IF
        // node branching on a field nothing computed. Reject rather than
        // silently persist an unsupported-capability claim.
        const aiClaimCheck = validateAiClassificationClaim(ctx.rawUserIntent ?? '', String(args.nodes_description ?? ''), result.nodes);
        if (!aiClaimCheck.ok) {
          return {
            tool: toolName,
            success: false,
            output: {
              error: aiClaimCheck.reason,
              missing_ai_classifier: true,
            },
            event: {
              type: 'error',
              label: 'AI classification requires a real AI classifier node',
              detail: aiClaimCheck.reason,
              agent: 'planner',
            },
          };
        }

        // Phase 9.9.2 -- product-truth backstop, mirroring the AI
        // classification claim check above: a request that plausibly
        // claims human review/approval semantics must be backed by a real
        // magicflux-nodes.humanReview node.
        const humanReviewClaimCheck = validateHumanReviewClaim(ctx.rawUserIntent ?? '', String(args.nodes_description ?? ''), result.nodes);
        if (!humanReviewClaimCheck.ok) {
          return {
            tool: toolName,
            success: false,
            output: {
              error: humanReviewClaimCheck.reason,
              missing_human_review: true,
            },
            event: {
              type: 'error',
              label: 'Human review requires a real review node',
              detail: humanReviewClaimCheck.reason,
              agent: 'planner',
            },
          };
        }

        // Phase 9.9.3 -- deterministic backstop: an Airtable node's
        // baseId/tableId must be empty (needs configuration) or a
        // real-shaped id (already verified/surviving a regeneration) --
        // never an invented value like "app123456", the exact production
        // regression. Real verification happens later, in the Builder's
        // own configuration-save endpoint and the pre-activation gate --
        // this only stops the generator from ever persisting a fake id in
        // the first place.
        const airtableIdCheck = validateNoInventedAirtableIds(result.nodes);
        if (!airtableIdCheck.ok) {
          return {
            tool: toolName,
            success: false,
            output: {
              error: airtableIdCheck.reason,
              invented_airtable_id: true,
              node: airtableIdCheck.node,
            },
            event: {
              type: 'error',
              label: 'Airtable configuration cannot be invented',
              detail: airtableIdCheck.reason,
              agent: 'planner',
            },
          };
        }

        // Phase 9.8.8 -- deterministic backstop matching the concrete-value
        // guard's placement: even with the strengthened prompt above, the
        // model can still emit a schedule-like node that findIncapableNodes()
        // happily accepts (e.g. a generic "wait"/legacy-cron type matches
        // GENERIC_HANDLER_SUBSTRINGS, so it's "known" but not the canonical,
        // certified schedule trigger this product actually runs). Reject
        // before persistence rather than silently deploying an automation
        // whose trigger doesn't behave the way the founder asked.
        if (rawTrigger === 'schedule') {
          const scheduleTriggerCheck = validateCanonicalScheduleTrigger(result.nodes, scheduleTimezone ?? '');
          if (!scheduleTriggerCheck.ok) {
            return {
              tool: toolName,
              success: false,
              output: {
                error: scheduleTriggerCheck.reason,
                unsupported_schedule_trigger: true,
                invalid_types: scheduleTriggerCheck.invalidTypes,
              },
              event: {
                type: 'error',
                label: 'Unsupported schedule trigger generated',
                detail: scheduleTriggerCheck.reason,
                agent: 'planner',
              },
            };
          }
        }

        const requestedProviders = Array.isArray(args.requested_providers)
          ? Array.from(
              new Set(
                args.requested_providers
                  .map((value) => toProviderToken(String(value)))
                  .filter((provider) => provider && isCanonicalProvider(provider))
              )
            )
          : [];

        if (requestedProviders.length > 0) {
          const graphProviders = extractAllProvidersFromWorkflowGraph(workflowGraph);
          // Phase 9.8.4 -- rawGraphProviders previously only dropped empty
          // strings, unlike its sibling extractAllProvidersFromWorkflowGraph()
          // above, which already excludes internal category labels (a node
          // with no external system, e.g. a trigger or an if/set step, has
          // provider: null and falls back to its WorkflowGraphNode.integration
          // bucket -- 'core', 'scheduler', etc. -- for cost-estimation
          // purposes only, never meant to be validated as a provider name).
          // Missing that same exclusion here made any workflow combining an
          // internal node with a genuinely requested external platform fail
          // with a false "Invalid: core" -- reusing the one exported
          // predicate keeps both extraction paths permanently in sync.
          const rawGraphProviders = Array.from(
            new Set(
              (workflowGraph.nodes ?? [])
                .map((node) => normalizeProvider(String(node.provider ?? node.integration ?? '')))
                .filter((provider) => Boolean(provider) && !isInternalProviderLabel(provider))
            )
          );
          const graphSet = new Set(graphProviders);
          const requestedSet = new Set(requestedProviders);

          const missingProviders = requestedProviders.filter((provider) => !graphSet.has(provider));
          const extraProviders = graphProviders.filter((provider) => !requestedSet.has(provider));
          const forbiddenProviders = rawGraphProviders.filter((provider) => hasForbiddenProviderPattern(provider));
          const invalidProviders = rawGraphProviders.filter(
            (provider) => !hasForbiddenProviderPattern(provider) && !isCanonicalProvider(provider)
          );

          console.log({
            requestedProviders,
            graphProviders,
            missingProviders,
            extraProviders,
            forbiddenProviders,
            invalidProviders,
          });

          if (missingProviders.length > 0 || extraProviders.length > 0 || forbiddenProviders.length > 0 || invalidProviders.length > 0) {
            return {
              tool: toolName,
              success: false,
              output: {
                error: 'Provider parity validation failed: generated workflow providers do not match requested providers.',
                validation_failed: true,
                requestedProviders,
                graphProviders,
                missing: missingProviders,
                extras: extraProviders,
                forbidden: forbiddenProviders,
                invalidCanonical: invalidProviders,
                workflow_graph: workflowGraph,
              },
              event: {
                type: 'error',
                label: 'Provider validation failed',
                detail: `Missing: ${missingProviders.join(', ') || 'none'} | Extra: ${extraProviders.join(', ') || 'none'} | Forbidden: ${forbiddenProviders.join(', ') || 'none'} | Invalid: ${invalidProviders.join(', ') || 'none'}`,
                agent: 'planner',
              },
            };
          }
        }

        // Phase 9.8.7 -- deterministic, fail-closed backstop: even with the
        // raw user request now threaded into the generation prompt above,
        // an LLM can still occasionally drop or paraphrase a literal the
        // user actually provided (confirmed in production: "send an email
        // to nssmpro@gmail.com..." generated parameters.to =
        // "recipient@example.com"). This never touches runtime precedence
        // (persisted node parameters still always win over trigger input at
        // execution time) -- it only stops a wrong workflow from ever being
        // persisted in the first place.
        const concreteValueCheck = checkConcreteValuesPreserved(ctx.rawUserIntent ?? '', result.nodes);
        if (!concreteValueCheck.ok) {
          return {
            tool: toolName,
            success: false,
            output: {
              error: concreteValueCheck.reason,
              concrete_value_mismatch: true,
            },
            event: {
              type: 'error',
              label: 'Generated workflow did not preserve your exact details',
              detail: concreteValueCheck.reason,
              agent: 'planner',
            },
          };
        }

        // Phase 9.8.1 -- persist the exact reviewed workflow immediately on
        // successful generation, rather than deferring persistence to a
        // deploy-time chat tool call. This is the root-cause fix for the
        // Phase 9.8 production incident: Approve + Deploy can now be a
        // deterministic POST /api/workflows/[id]/lifecycle call against a
        // stable, already-persisted id -- never a chat message that could
        // be reinterpreted as a fresh automation request. A persistence
        // failure here is reported honestly rather than silently returning
        // a workflow the frontend can't actually deploy later.
        let persistedWorkflowId: string | null = null;
        try {
          persistedWorkflowId = await ensurePersistedWorkflowDraft({
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            args: {
              workflow_name: args.workflow_name,
              workflow_json: JSON.stringify({ nodes: result.nodes, connections: result.connections }),
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to persist generated workflow';
          return {
            tool: toolName,
            success: false,
            output: {
              error_code: 'WORKFLOW_PERSISTENCE_FAILED',
              error: message,
            },
            event: {
              type: 'error',
              label: 'I generated the workflow but could not save it',
              detail: 'Please retry. If it happens again, check workflow persistence.',
              agent: 'recovery',
            },
          };
        }

        const toolResult: ToolResult = {
          tool: toolName,
          success: true,
          output: {
            workflow_id: persistedWorkflowId,
            workflow_json: JSON.stringify({ nodes: result.nodes, connections: result.connections }),
            explanation: result.explanation,
            node_count: result.nodes.length,
            workflow_graph: workflowGraph,
          },
          event: {
            type: 'generating_workflow',
            label: `Workflow blueprint generated`,
            detail: `${result.nodes.length} nodes — ${String(args.workflow_name)}`,
            agent: 'deploy',
            workflowId: persistedWorkflowId ?? undefined,
          },
        };

        await recordAgentActionEvent({
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          eventType: 'tool_completed',
          actionName: toolName,
          status: 'success',
          detail: 'Workflow JSON generated',
          durationMs: Date.now() - startedAt,
          workflowId: persistedWorkflowId ?? undefined,
          metadata: { nodeCount: result.nodes.length },
        });

        return toolResult;
      }

      // Phase 9.8.1 -- deploy_workflow_to_n8n and activate_workflow cases
      // removed entirely (see lib/agent/tools.ts's removal comment for the
      // full rationale and audit). They deployed to an external n8n
      // instance never used by the canonical Builder journey and never
      // touched this app's own `workflows`/`deployment_versions` tables.

      // -----------------------------------------------------------------------
      case 'test_workflow': {
        const workflowId = String(args.workflow_id ?? '');
        const result = await runTestExecution(
          n8n,
          workflowId,
          args.trigger_node ? String(args.trigger_node) : undefined
        );

        return {
          tool: toolName,
          success: result.status === 'success',
          output: {
            execution_id: result.executionId,
            status: result.status,
            message: result.message,
            node_statuses: result.nodeStatuses,
            started_at: result.startedAt,
            stopped_at: result.stoppedAt,
          },
          event: {
            type: result.status === 'success' ? 'testing' : 'error',
            label: result.status === 'success' ? 'Test execution passed' : 'Test execution failed',
            detail: result.message,
            workflowId,
            agent: 'monitoring',
          },
        };
      }

      // -----------------------------------------------------------------------
      case 'validate_credential': {
        const provider = String(args.provider ?? '');
        const value = String(args.credential_value ?? '');
        const valid = providerCredentialIsValid(provider, value);

        return {
          tool: toolName,
          success: true,
          output: {
            provider,
            valid,
            message: valid
              ? `${provider} credential is valid`
              : `${provider} credential format is invalid — please check and try again`,
          },
        };
      }

      // -----------------------------------------------------------------------
      case 'get_workflow_status': {
        const workflowId = String(args.workflow_id ?? '');
        const status = await getWorkflowStatus(n8n, workflowId);

        return {
          tool: toolName,
          success: true,
          output: {
            workflow_id: status.id,
            name: status.name,
            active: status.active,
            created_at: status.createdAt,
            updated_at: status.updatedAt,
          },
        };
      }

      // -----------------------------------------------------------------------
      case 'get_execution_logs': {
        const workflowId = String(args.workflow_id ?? '');
        const limit = typeof args.limit === 'number' ? args.limit : 5;
        const executions = await listExecutions(n8n, workflowId, limit);

        return {
          tool: toolName,
          success: true,
          output: {
            executions: executions.map((e) => ({
              id: e.id,
              status: e.status,
              started_at: e.startedAt,
              stopped_at: e.stoppedAt,
              finished: e.finished,
            })),
          },
        };
      }

      // -----------------------------------------------------------------------
      case 'explain_workflow_architecture': {
        const steps = Array.isArray(args.steps) ? (args.steps as string[]) : [];
        const integrations = Array.isArray(args.integrations_required)
          ? (args.integrations_required as string[])
          : [];

        const explanation =
          `Here is how your **${String(args.workflow_name)}** automation will work:\n\n` +
          steps.map((s, i) => `${i + 1}. ${s}`).join('\n') +
          (integrations.length > 0
            ? `\n\n**Integrations needed:** ${integrations.join(', ')}`
            : '');

        return {
          tool: toolName,
          success: true,
          output: { explanation, steps, integrations_required: integrations },
          event: {
            type: 'explaining_architecture',
            label: 'Architecture ready',
            detail: `${steps.length} steps`,
            agent: 'planner',
          },
        };
      }

      // -----------------------------------------------------------------------
      case 'request_credential': {
        const provider = String(args.provider ?? '');
        const reason = String(args.reason ?? '');
        const instructions = args.instructions ? String(args.instructions) : undefined;

        return {
          tool: toolName,
          success: true,
          output: {
            provider,
            reason,
            instructions,
            awaiting_credential: true,
          },
          event: {
            type: 'requesting_credential',
            label: `Need ${provider} credentials`,
            detail: reason,
            agent: 'integration',
          },
        };
      }

      // -----------------------------------------------------------------------
      default:
        return {
          tool: toolName,
          success: false,
          output: { error: `Unknown tool: ${toolName}` },
        };
    }
  } catch (err) {
    failed = true;
    const message = err instanceof Error ? err.message : String(err);
    await recordAgentActionEvent({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      eventType: 'tool_failed',
      actionName: toolName,
      status: 'error',
      detail: message,
      durationMs: Date.now() - startedAt,
      errorCode: 'TOOL_RUNTIME_ERROR',
    });
    return {
      tool: toolName,
      success: false,
      output: { error: message },
      event: { type: 'error', label: 'I hit an execution error', detail: message },
    };
  } finally {
    await emitRuntimeEvent({
      eventType: failed ? 'tool.failed' : 'tool.completed',
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      workflowId: args.workflow_id ? String(args.workflow_id) : undefined,
      executionId,
      correlationId,
      traceId,
      spanId: toolSpanId,
      parentSpanId: ctx.parentSpanId,
      agentId: 'runtime',
      severity: failed ? 'error' : 'info',
      payload: { toolName, duration_ms: Date.now() - startedAt },
    });

    await endSpan({
      userId: ctx.userId,
      spanId: toolSpanId,
      status: failed ? 'error' : 'success',
      errorMessage: failed ? `${toolName} failed` : undefined,
      attributes: { duration_ms: Date.now() - startedAt, toolName },
    });

    await recordAgentActionEvent({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      eventType: 'tool_finished',
      actionName: toolName,
      status: 'info',
      durationMs: Date.now() - startedAt,
    });
  }
}
