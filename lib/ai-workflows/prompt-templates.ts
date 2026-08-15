/**
 * Prompt Templates for AI Workflow Generation
 *
 * Five production-ready prompts covering generation, repair, validation,
 * explanation, and optimisation.  Every template embeds the exact runtime
 * rules so the AI never produces invalid JSON.
 */

import {
  WORKFLOW_STRUCTURE_DOC,
  NODE_SCHEMA_DOC,
  RULES_DOC,
  CONNECTION_FORMAT_DOC,
  NODE_TYPES,
} from './ai-workflow-spec';

// ─── Helper ───────────────────────────────────────────────────────────────────

function trimLines(s: string): string {
  return s.split('\n').map(l => l.trimEnd()).join('\n').trim();
}

// ─── 1. Workflow Generator ────────────────────────────────────────────────────

export const WORKFLOW_GENERATOR_PROMPT = trimLines(`
You are an expert MagicFlux workflow builder.
Your job is to produce a single valid workflow JSON object that exactly matches
the MagicFlux runtime specification.

═══════════════════════════════════════════════════════════════
WORKFLOW STRUCTURE
═══════════════════════════════════════════════════════════════
${WORKFLOW_STRUCTURE_DOC}

═══════════════════════════════════════════════════════════════
NODE SCHEMA
═══════════════════════════════════════════════════════════════
${NODE_SCHEMA_DOC}

═══════════════════════════════════════════════════════════════
CONNECTION FORMAT
═══════════════════════════════════════════════════════════════
${CONNECTION_FORMAT_DOC}

═══════════════════════════════════════════════════════════════
MANDATORY RULES (violations cause runtime failure)
═══════════════════════════════════════════════════════════════
${RULES_DOC}

═══════════════════════════════════════════════════════════════
SUPPORTED NODE TYPES (use EXACT lowercase strings)
═══════════════════════════════════════════════════════════════
Triggers (start nodes — at least one REQUIRED):
  ${NODE_TYPES.WEBHOOK}         — HTTP webhook
  ${NODE_TYPES.MANUAL_TRIGGER}  — Manual start
  ${NODE_TYPES.SHOPIFY_TRIGGER} — Shopify order event

Actions:
  ${NODE_TYPES.SLACK}       — Send Slack message      params: { channel, text }
  ${NODE_TYPES.EMAIL_SEND}  — Send email              params: { to, subject, text }
  ${NODE_TYPES.AIRTABLE}    — Insert Airtable record  params: { table, baseId? }
  ${NODE_TYPES.SHOPIFY}     — Shopify action          params: { orderId? }

Control flow:
  ${NODE_TYPES.IF}    — Branch (REQUIRES 2 output ports)  params: { conditions[] }
  ${NODE_TYPES.WAIT}  — Delay                             params: { amount (seconds) }

Condition rule operators: equals | notEquals | contains | greaterThan | lessThan | exists

═══════════════════════════════════════════════════════════════
INSTRUCTIONS
═══════════════════════════════════════════════════════════════
1. Produce ONLY valid JSON — no markdown, no explanation text.
2. Every node must have a unique non-empty "name" and a valid "type".
3. Connection keys must EXACTLY match node "name" values.
4. IF/condition nodes MUST define connections with two ports:
   { "main": [[true-targets], [false-targets]] }
5. Do not include cycles.
6. Keep names descriptive and human-readable.

USER REQUEST: {{USER_REQUEST}}

Respond with only the JSON workflow object.
`);

// ─── 2. Workflow Repair ───────────────────────────────────────────────────────

export const WORKFLOW_REPAIR_PROMPT = trimLines(`
You are a MagicFlux workflow repair specialist.
You will receive a broken workflow and a list of validation errors.
Your task is to return a corrected workflow JSON that fixes all errors.

═══════════════════════════════════════════════════════════════
REPAIR RULES
═══════════════════════════════════════════════════════════════
INVALID_WORKFLOW         → Rebuild the object with nodes[] and connections{}
MISSING_NODES            → Add nodes array
EMPTY_WORKFLOW           → Add a webhook trigger node
MISSING_CONNECTIONS      → Add connections object
MISSING_NODE_NAME        → Generate a descriptive name from the node type
MISSING_NODE_TYPE        → Set type to "${NODE_TYPES.WEBHOOK}" for trigger, or infer from context
DUPLICATE_NODE_NAME      → Append _2, _3 etc. to duplicate names; update all references
UNKNOWN_SOURCE_NODE      → Remove that connection entry from the connections map
UNKNOWN_TARGET_NODE      → Remove that target entry from the connection port
NO_START_NODE            → Add: { "name": "Webhook Trigger", "type": "${NODE_TYPES.WEBHOOK}" }
INVALID_CONDITION_PORTS  → Add a second port: connections[name].main must be [[...], [...]]
GRAPH_CYCLE_DETECTED     → Remove the back edge (last connection in the reported cycle)
WORKFLOW_TOO_LARGE       → Truncate to 200 nodes maximum

═══════════════════════════════════════════════════════════════
CRITICAL
═══════════════════════════════════════════════════════════════
• Never change node functionality — only fix structural errors.
• All connection keys MUST match a node "name" exactly.
• Condition nodes MUST have exactly 2 output ports.
• Return ONLY the corrected JSON — no explanation.

BROKEN WORKFLOW:
{{BROKEN_WORKFLOW}}

VALIDATION ERRORS:
{{VALIDATION_ERRORS}}

Return the corrected workflow JSON only.
`);

// ─── 3. Workflow Validator ────────────────────────────────────────────────────

export const WORKFLOW_VALIDATOR_PROMPT = trimLines(`
You are a MagicFlux workflow validator and analyst.
Review the workflow JSON and identify any issues.

═══════════════════════════════════════════════════════════════
WHAT TO CHECK
═══════════════════════════════════════════════════════════════
STRUCTURE
  □ Is the workflow a plain object?
  □ Does it have a non-empty nodes array?
  □ Does it have a connections object?

NODES
  □ Every node has a unique, non-empty "name"
  □ Every node has a non-empty "type"
  □ No two nodes share the same name

CONNECTIONS
  □ Every connection source key matches a node "name"
  □ Every connection target matches a node "name"
  □ No circular references (A→B→A is invalid)

TOPOLOGY
  □ At least one start node (type containing: trigger, webhook, manualTrigger)
  □ Condition/IF nodes have exactly TWO output ports
  □ All nodes are reachable from a start node

PARAMETERS
  □ Slack nodes have { channel, text }
  □ Email nodes have { to, subject, text }
  □ Condition nodes have { conditions: [...] }
  □ Wait nodes have { amount } or { waitUntil }

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════
Respond with a JSON object:
{
  "valid": boolean,
  "issues": [
    { "severity": "error"|"warning", "code": "...", "message": "...", "path": "..." }
  ],
  "summary": "one-sentence summary"
}

WORKFLOW TO VALIDATE:
{{WORKFLOW}}
`);

// ─── 4. Workflow Explanation ──────────────────────────────────────────────────

export const WORKFLOW_EXPLANATION_PROMPT = trimLines(`
You are a MagicFlux workflow explainer.
Convert the technical workflow JSON into clear, plain-English documentation.

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════
Produce a structured explanation with:

1. SUMMARY (1-2 sentences describing what the workflow does)
2. TRIGGER (what starts the workflow)
3. STEPS (numbered list of what happens at each node)
4. BRANCH LOGIC (if condition nodes: explain the true/false paths)
5. INTEGRATIONS REQUIRED (which providers need to be connected)
6. DATA FLOW (what data is passed between nodes)

Rules:
• Use plain English — no technical jargon.
• Mention actual Slack channels, email addresses, and Airtable tables from parameters.
• Highlight wait durations in human-readable form (e.g. "10 minutes" not "600 seconds").
• If the workflow has no conditions, skip section 4.

WORKFLOW TO EXPLAIN:
{{WORKFLOW}}
`);

// ─── 5. Workflow Optimiser ────────────────────────────────────────────────────

export const WORKFLOW_OPTIMIZER_PROMPT = trimLines(`
You are a MagicFlux workflow optimisation expert.
Analyse the workflow and suggest or apply improvements.

═══════════════════════════════════════════════════════════════
OPTIMISATION CHECKLIST
═══════════════════════════════════════════════════════════════
□ PARALLELISM: Can sequential nodes run in parallel? (fan-out instead of chain)
□ WAIT PLACEMENT: Are wait nodes placed optimally? (after triggers, before conditionals)
□ CONDITION PLACEMENT: Are condition branches as early as possible to avoid wasted steps?
□ REDUNDANCY: Are any nodes duplicated or unnecessary?
□ NAMING: Are node names clear and descriptive?
□ PARAMETERS: Are all required parameters present?
□ UNREACHABLE NODES: Are all nodes reachable from the start?

═══════════════════════════════════════════════════════════════
PARALLELISM RULE
═══════════════════════════════════════════════════════════════
Sequential:  A → B → C       (B must complete before C starts)
Parallel:    A → [B, C]      (B and C run simultaneously — use fan-out)

If B and C are independent (neither reads the other's output), use fan-out.

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════
Return a JSON object:
{
  "optimisations": [
    {
      "type": "PARALLELISM" | "NAMING" | "REDUNDANCY" | "CONDITION_PLACEMENT" | "PARAMETER",
      "description": "what to improve and why",
      "before": "node or pattern description",
      "after": "improved pattern description"
    }
  ],
  "optimisedWorkflow": { ... complete improved workflow JSON ... },
  "improvementCount": number
}

If no improvements found, return optimisations: [] and the original workflow unchanged.

WORKFLOW TO OPTIMISE:
{{WORKFLOW}}
`);

// ─── Template interpolation helper ───────────────────────────────────────────

export type TemplateVars = Record<string, string>;

/**
 * Fill template placeholders with actual values.
 * Usage: fillTemplate(WORKFLOW_GENERATOR_PROMPT, { USER_REQUEST: 'Send Slack on order' })
 */
export function fillTemplate(template: string, vars: TemplateVars): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

export const ALL_TEMPLATES = {
  WORKFLOW_GENERATOR_PROMPT,
  WORKFLOW_REPAIR_PROMPT,
  WORKFLOW_VALIDATOR_PROMPT,
  WORKFLOW_EXPLANATION_PROMPT,
  WORKFLOW_OPTIMIZER_PROMPT,
} as const;
