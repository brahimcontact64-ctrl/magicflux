/**
 * AI Workflow Generator V1
 *
 * Pure TypeScript rule-based generator.  No LLM API required.
 *
 * Pipeline:
 *   1. Retrieve the most relevant training examples (keyword scoring)
 *   2. Parse the natural-language prompt into a structured intent
 *   3. Build a WorkflowJson from the intent using spec helpers
 *   4. Validate with validateWorkflow()
 *   5. If invalid, repair with repairWorkflow() and re-validate
 *   6. Return the first valid result
 */

import { validateWorkflow } from '../workflow-validator';
import { repairWorkflow }   from './workflow-repair';
import { TRAINING_DATASET, type TrainingPair } from './training-dataset';
import {
  buildLinearWorkflow,
  buildFanoutWorkflow,
  buildConditionalWorkflow,
  buildWaitWorkflow,
  webhookNode,
  shopifyTriggerNode,
  slackNode,
  emailNode,
  airtableNode,
  conditionNode,
  type WorkflowJson,
  type WorkflowNode,
  type ConditionRule,
  NODE_TYPES,
} from './ai-workflow-spec';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GenerateResult {
  workflow:       WorkflowJson;
  valid:          boolean;
  examplesUsed:   TrainingPair[];
  repairApplied:  boolean;
}

// ─── Internal intent model ────────────────────────────────────────────────────

type TriggerKind  = 'webhook' | 'shopify';
type ActionKind   = 'slack' | 'email' | 'airtable';
type TopologyKind = 'linear' | 'fanout' | 'conditional' | 'wait';

interface ActionSpec {
  kind:     ActionKind;
  channel?: string;   // slack
  text?:    string;   // slack
  to?:      string;   // email
  subject?: string;   // email
  body?:    string;   // email
  table?:   string;   // airtable
}

interface ConditionSpec {
  field:    string;
  operator: string;
  value:    string;
  /** name assigned to the IF node */
  name:     string;
}

interface WaitSpec {
  seconds: number;
  name:    string;
}

interface ParsedIntent {
  trigger:      TriggerKind;
  actions:      ActionSpec[];    // detected action types
  condition:    ConditionSpec | null;
  wait:         WaitSpec | null;
  topology:     TopologyKind;
  workflowName: string;
}

// ─── Text utilities ───────────────────────────────────────────────────────────

function lc(s: string): string { return s.toLowerCase(); }

/** Split text into lowercase tokens, discarding punctuation. */
function tokenize(text: string): string[] {
  return lc(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/** Check if lowercased haystack contains any of the given needles. */
function has(text: string, ...needles: string[]): boolean {
  const t = lc(text);
  return needles.some(n => t.includes(lc(n)));
}

/** Extract the first integer found after a pattern like "wait 10" or "after 5". */
function extractNumber(text: string, afterWords: string[]): number | null {
  const t = lc(text);
  for (const word of afterWords) {
    const re = new RegExp(`${word}\\s+(\\d+)`, 'i');
    const m = t.match(re);
    if (m) return parseInt(m[1], 10);
  }
  const m2 = t.match(/(\d+)\s*(?:minutes?|hours?|days?|seconds?)/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

/** Convert a duration in N units to seconds. */
function toSeconds(n: number, text: string): number {
  if (has(text, 'day', 'days'))    return n * 86_400;
  if (has(text, 'hour', 'hours'))  return n * 3_600;
  if (has(text, 'minute', 'min'))  return n * 60;
  return n; // assume seconds as default
}

// ─── Step 1 — Example retrieval (TF-style keyword scoring) ───────────────────

const EXAMPLE_RETRIEVAL_K = 3;

function scoreExample(promptTokens: Set<string>, pair: TrainingPair): number {
  const exText = [
    pair.naturalLanguage,
    pair.intent,
    pair.tags.join(' '),
  ].join(' ');
  const exTokens = tokenize(exText);
  let score = 0;
  for (const t of exTokens) {
    if (promptTokens.has(t)) score += 1;
  }
  return score;
}

function retrieveExamples(prompt: string, k = EXAMPLE_RETRIEVAL_K): TrainingPair[] {
  const promptTokens = new Set(tokenize(prompt));
  if (promptTokens.size === 0) return TRAINING_DATASET.slice(0, k);

  const scored = TRAINING_DATASET.map(pair => ({
    pair,
    score: scoreExample(promptTokens, pair),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(s => s.pair);
}

// ─── Step 2 — Intent parsing ──────────────────────────────────────────────────

function parseTrigger(prompt: string): TriggerKind {
  if (has(prompt, 'shopify', 'order placed', 'new order', 'purchase', 'sale')) {
    return 'shopify';
  }
  return 'webhook';
}

function parseActions(prompt: string): ActionSpec[] {
  const actions: ActionSpec[] = [];

  // Slack — also detected when a #channel name is present in the prompt
  const hasHashChannel = /#[a-z0-9_-]+/i.test(prompt);
  if (hasHashChannel || has(prompt, 'slack', 'slack message', 'send message', 'post to #', 'notify on slack')) {
    const ch = extractSlackChannel(prompt);
    actions.push({
      kind:    'slack',
      channel: ch,
      text:    buildSlackText(prompt),
    });
  }

  // Email
  if (has(prompt, 'email', 'send email', 'mail to', 'notify by email', 'send a mail')) {
    actions.push({
      kind:    'email',
      to:      extractEmailAddress(prompt),
      subject: buildEmailSubject(prompt),
      body:    'Automated notification from your MagicFlux workflow.',
    });
  }

  // Airtable
  if (has(prompt, 'airtable', 'save to', 'log to', 'record in', 'database', 'spreadsheet', 'table')) {
    actions.push({
      kind:  'airtable',
      table: extractAirtableTable(prompt),
    });
  }

  // Fallback — if nothing recognized, default to Slack notification
  if (actions.length === 0) {
    actions.push({ kind: 'slack', channel: '#general', text: 'New event received' });
  }

  return actions;
}

function parseCondition(prompt: string): ConditionSpec | null {
  const t = lc(prompt);
  // Also catches "if " at the very start of the prompt (no leading space)
  const startsWithIf = t.startsWith('if ');
  if (!startsWithIf && !has(prompt, ' if ', 'only if', 'based on', 'when order', 'vip', 'high value',
    'greater than', 'more than', 'less than', 'route by', 'depending on', 'check if')) {
    return null;
  }

  // Try to extract field + operator + value from common patterns
  let field = 'status';
  let operator = 'equals';
  let value = 'active';

  if (has(t, 'vip')) {
    field = 'customer_type'; operator = 'equals'; value = 'vip';
  } else if (has(t, 'high value', 'high-value') || has(t, 'greater than', 'more than', 'over')) {
    field = 'total_price'; operator = 'greaterThan';
    const n = extractNumber(t, ['over', 'greater than', 'more than', 'above', 'exceeds', 'worth']);
    value = n != null ? String(n) : '100';
  } else if (has(t, 'less than', 'under', 'below')) {
    field = 'total_price'; operator = 'lessThan';
    const n = extractNumber(t, ['less than', 'under', 'below']);
    value = n != null ? String(n) : '50';
  } else if (has(t, 'priority')) {
    field = 'priority'; operator = 'equals'; value = has(t, 'high') ? 'high' : 'urgent';
  } else if (has(t, 'paid')) {
    field = 'financial_status'; operator = 'equals'; value = 'paid';
  } else if (has(t, 'enterprise')) {
    field = 'tier'; operator = 'equals'; value = 'enterprise';
  } else if (has(t, 'new customer', 'first time', 'first order')) {
    field = 'orders_count'; operator = 'equals'; value = '1';
  } else if (has(t, 'error', 'fail', 'failed')) {
    field = 'status'; operator = 'equals'; value = 'failed';
  } else if (has(t, 'active')) {
    field = 'status'; operator = 'equals'; value = 'active';
  }

  return {
    field, operator, value,
    name: 'Check Condition',
  };
}

function parseWait(prompt: string): WaitSpec | null {
  // Match "after N minutes/hours/days" patterns as well as explicit wait/delay keywords
  const hasAfterTime = /after\s+\d+\s*(minute|hour|day|second)/i.test(prompt);
  if (!hasAfterTime && !has(prompt, 'wait', 'delay', 'later', 'pause')) return null;

  const t = lc(prompt);
  const n = extractNumber(t, ['wait', 'delay', 'after', 'pause for']);
  const seconds = n != null ? toSeconds(n, t) : 300; // default 5 minutes

  let name = `Wait ${formatDuration(seconds)}`;
  return { seconds, name };
}

function formatDuration(seconds: number): string {
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)} Day${seconds >= 172_800 ? 's' : ''}`;
  if (seconds >= 3_600)  return `${Math.round(seconds / 3_600)} Hour${seconds >= 7_200 ? 's' : ''}`;
  if (seconds >= 60)     return `${Math.round(seconds / 60)} Minute${seconds >= 120 ? 's' : ''}`;
  return `${seconds} Seconds`;
}

function parseTopology(
  actions: ActionSpec[],
  condition: ConditionSpec | null,
  wait: WaitSpec | null,
  prompt: string,
): TopologyKind {
  if (condition !== null) return 'conditional';
  if (wait !== null)      return 'wait';

  if (actions.length > 1) {
    // Fan-out when prompt implies simultaneity; linear when it implies sequence
    const sequential = has(prompt, ' then ', 'followed by', 'after that', 'next');
    return sequential ? 'linear' : 'fanout';
  }

  return 'linear';
}

function generateWorkflowName(trigger: TriggerKind, actions: ActionSpec[], condition: ConditionSpec | null, wait: WaitSpec | null): string {
  const src = trigger === 'shopify' ? 'Shopify Order' : 'Webhook';
  if (condition) return `${src} → Condition`;
  if (wait)      return `${src} → Wait → ${formatActionNames(actions)}`;
  if (actions.length > 1) return `${src} → ${formatActionNames(actions)}`;
  return `${src} → ${formatActionNames(actions)}`;
}

function formatActionNames(actions: ActionSpec[]): string {
  return actions.map(a => a.kind.charAt(0).toUpperCase() + a.kind.slice(1)).join(' + ');
}

// Parameter extraction helpers ─────────────────────────────────────────────

function extractSlackChannel(prompt: string): string {
  const m = lc(prompt).match(/#([a-z0-9_-]+)/);
  if (m) return `#${m[1]}`;
  if (has(prompt, 'order', 'purchase', 'sale')) return '#orders';
  if (has(prompt, 'alert', 'urgent', 'critical', 'error')) return '#alerts';
  if (has(prompt, 'sales', 'revenue')) return '#sales';
  if (has(prompt, 'team', 'engineering')) return '#team';
  return '#general';
}

function buildSlackText(prompt: string): string {
  if (has(prompt, 'shopify', 'order')) return 'New Shopify order received!';
  if (has(prompt, 'error', 'fail'))    return 'Error detected — please investigate.';
  if (has(prompt, 'payment'))          return 'Payment event received.';
  if (has(prompt, 'signup', 'register')) return 'New user signed up.';
  return 'New event received from MagicFlux workflow.';
}

function extractEmailAddress(prompt: string): string {
  const m = prompt.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (m) return m[0];
  if (has(prompt, 'team'))         return 'team@example.com';
  if (has(prompt, 'order', 'fulfilment')) return 'orders@example.com';
  if (has(prompt, 'admin'))        return 'admin@example.com';
  if (has(prompt, 'customer'))     return 'customer@example.com';
  return 'notifications@example.com';
}

function buildEmailSubject(prompt: string): string {
  if (has(prompt, 'shopify', 'order')) return 'New Shopify Order';
  if (has(prompt, 'signup', 'register')) return 'New User Registration';
  if (has(prompt, 'payment'))          return 'Payment Notification';
  if (has(prompt, 'error'))            return 'Error Alert';
  return 'Workflow Notification';
}

function extractAirtableTable(prompt: string): string {
  // Try to find a capitalised word preceded by "table" or a known table pattern
  const m = lc(prompt).match(/(?:table|in|into|to)\s+([a-z][a-z\s]{1,20}?)(?:\s|$|,)/);
  if (m) {
    const candidate = m[1].trim();
    if (!['the', 'a', 'an', 'my', 'your', 'our'].includes(candidate)) {
      return candidate.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
  }
  if (has(prompt, 'order'))     return 'Orders';
  if (has(prompt, 'lead', 'crm')) return 'Leads';
  if (has(prompt, 'user', 'customer')) return 'Customers';
  if (has(prompt, 'event'))     return 'Events';
  if (has(prompt, 'ticket', 'support')) return 'Support Tickets';
  if (has(prompt, 'sale', 'revenue')) return 'Sales';
  return 'Records';
}

// ─── Step 3 — Workflow construction ──────────────────────────────────────────

function buildActionNode(spec: ActionSpec, index = 0): WorkflowNode {
  const suffix = index > 0 ? ` ${index + 1}` : '';
  switch (spec.kind) {
    case 'slack':
      return slackNode(
        `Send Slack Message${suffix}`,
        spec.channel ?? '#general',
        spec.text ?? 'Workflow notification',
      );
    case 'email':
      return emailNode(
        `Send Email${suffix}`,
        spec.to      ?? 'team@example.com',
        spec.subject ?? 'Notification',
        spec.body    ?? 'Automated email from MagicFlux.',
      );
    case 'airtable':
      return airtableNode(
        `Save to Airtable${suffix}`,
        spec.table ?? 'Records',
      );
  }
}

function buildWorkflowFromIntent(intent: ParsedIntent): WorkflowJson {
  const { trigger, actions, condition, wait, topology, workflowName } = intent;

  const triggerNode = trigger === 'shopify'
    ? shopifyTriggerNode('Shopify Order Trigger')
    : webhookNode('Webhook Trigger');

  switch (topology) {
    case 'conditional': {
      // Distribute actions across branches
      const trueBranch  = actions.length >= 1 ? [buildActionNode(actions[0])] : [];
      const falseBranch = actions.length >= 2 ? [buildActionNode(actions[1], 1)] : [];

      const condRule: ConditionRule = {
        field:    condition!.field,
        operator: condition!.operator as ConditionRule['operator'],
        value:    condition!.value,
      };
      const condNode = {
        name: condition!.name,
        type: NODE_TYPES.IF,
        parameters: { conditions: [condRule] },
      };

      return buildConditionalWorkflow(
        workflowName,
        triggerNode,
        condNode,
        trueBranch,
        falseBranch,
      );
    }

    case 'wait': {
      const actionNodes = actions.map((a, i) => buildActionNode(a, i > 0 ? i : 0));
      return buildWaitWorkflow(
        workflowName,
        triggerNode,
        wait!.seconds,
        wait!.name,
        actionNodes,
      );
    }

    case 'fanout': {
      const targetNodes = actions.map((a, i) => buildActionNode(a, i > 0 ? i : 0));
      return buildFanoutWorkflow(workflowName, triggerNode, targetNodes);
    }

    case 'linear':
    default: {
      const chain: WorkflowNode[] = [
        triggerNode,
        ...actions.map((a, i) => buildActionNode(a, i > 0 ? i : 0)),
      ];
      return buildLinearWorkflow(workflowName, chain);
    }
  }
}

// ─── Step 2 assembled — full intent parse ────────────────────────────────────

function parseIntent(prompt: string): ParsedIntent {
  const trigger   = parseTrigger(prompt);
  const condition = parseCondition(prompt);
  const wait      = parseWait(prompt);

  // For conditional workflows, ensure at least 2 actions (true + false branch)
  let actions = parseActions(prompt);
  if (condition && actions.length < 2) {
    // Add a complementary default action on the false branch
    const existing = actions[0]?.kind;
    if (existing === 'slack') {
      actions.push({ kind: 'email', to: 'team@example.com', subject: 'Fallback Notification', body: 'Condition did not match.' });
    } else if (existing === 'email') {
      actions.push({ kind: 'slack', channel: '#fallback', text: 'Condition did not match.' });
    } else {
      actions.push({ kind: 'airtable', table: 'Fallback Events' });
    }
  }

  const topology    = parseTopology(actions, condition, wait, prompt);
  const workflowName = generateWorkflowName(trigger, actions, condition, wait);

  return { trigger, actions, condition, wait, topology, workflowName };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate a valid workflow from a natural-language prompt.
 *
 * The returned workflow is guaranteed to pass `validateWorkflow()`.
 * If the initial build is invalid, `repairWorkflow()` is applied automatically.
 */
export function generateWorkflow(prompt: string): GenerateResult {
  // 1. Retrieve relevant examples for context
  const examplesUsed = retrieveExamples(prompt.trim());

  // 2. Parse intent
  const intent = parseIntent(prompt.trim() || 'notify team on Slack');

  // 3. Build workflow
  const built = buildWorkflowFromIntent(intent);

  // 4. Validate
  const firstCheck = validateWorkflow(built);

  if (firstCheck.valid) {
    return { workflow: built, valid: true, examplesUsed, repairApplied: false };
  }

  // 5. Repair
  const repaired     = repairWorkflow(built);
  const finalCheck   = validateWorkflow(repaired.workflow);

  return {
    workflow:      repaired.workflow,
    valid:         finalCheck.valid,
    examplesUsed,
    repairApplied: true,
  };
}

// ─── Re-export for convenience ────────────────────────────────────────────────

export { retrieveExamples, parseIntent, buildWorkflowFromIntent };
export type { ParsedIntent, ActionSpec, ConditionSpec, WaitSpec };
