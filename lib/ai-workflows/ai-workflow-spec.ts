/**
 * MagicFlux AI Workflow Specification
 *
 * Single source of truth for AI workflow generation.
 * Every rule here is derived directly from the runtime engine source.
 * Any workflow built with these types and helpers will pass validateWorkflow()
 * and execute immediately without modification.
 *
 * Engine source: runtime/workflow-engine.ts
 * Validator:     lib/workflow-validator/index.ts
 * Handlers:      lib/workflow-runtime/node-handlers/
 */

// ─── Core types ───────────────────────────────────────────────────────────────

export interface WorkflowNode {
  /** PRIMARY GRAPH KEY — must be unique and non-empty. Used in connections. */
  name: string;
  /** Node type string — must match a supported type (see NODE_REGISTRY). */
  type: string;
  /** Optional stable ID — used in execution step records. */
  id?: string;
  /** Handler-specific configuration — see parameter schemas per node type. */
  parameters?: Record<string, unknown>;
}

export interface ConnectionEntry {
  /** Exact name of the target node (must match WorkflowNode.name). */
  node: string;
  type?: string;
  index?: number;
}

export type PortList = ConnectionEntry[][];  // outer = ports, inner = targets per port

export interface WorkflowConnections {
  /**
   * Key   = source node name (exact string match with WorkflowNode.name)
   * Value = { main: PortList }
   *   main[0] = port 0 targets  (true branch for condition nodes)
   *   main[1] = port 1 targets  (false branch for condition nodes)
   */
  [sourceName: string]: { main: PortList };
}

export interface WorkflowJson {
  /** Human-readable workflow title (not used by engine). */
  name: string;
  /** Ordered list of nodes. At least one must be a start node. */
  nodes: WorkflowNode[];
  /** Directed edges between nodes. Keys are source node names. */
  connections: WorkflowConnections;
}

// ─── Parameter schemas ────────────────────────────────────────────────────────

export interface SlackParameters {
  channel: string;   // e.g. "#general" — Slack channel name
  text: string;      // Message body
  message?: string;  // Alias for text
}

export interface EmailParameters {
  to: string;        // Recipient address  e.g. "user@example.com"
  subject: string;   // Email subject line
  text: string;      // Plain-text body (also accepted as: html, message)
  html?: string;     // HTML alternative
}

export interface AirtableParameters {
  table: string;     // Table name   e.g. "Orders"
  baseId?: string;   // Base ID (falls back to connected credential)
  base?: string;     // Alias for baseId
}

export interface ShopifyParameters {
  orderId?: string;  // Optional — if present, fetches that specific order
}

export interface ConditionRule {
  field:    string;  // Dot-notation path into inputData  e.g. "order.status"
  operator: ConditionOperator;
  value?:   unknown; // Not used for "exists"
}

export type ConditionOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'greaterThan'
  | 'lessThan'
  | 'exists';

export interface ConditionParameters {
  /**
   * All rules are evaluated with AND logic.
   * Empty array → passes on branch 0 (true).
   * REQUIRES exactly two output ports in connections:
   *   connections[name].main[0] = true-branch targets
   *   connections[name].main[1] = false-branch targets
   */
  conditions: ConditionRule[];
}

export interface WaitParameters {
  /** Duration in seconds (mutually exclusive with waitUntil). */
  amount?: number;
  duration?: number;  // alias for amount
  seconds?: number;   // alias for amount
  /** ISO 8601 timestamp — absolute date/time to wait until. */
  waitUntil?: string;
  resumeAt?: string;  // alias for waitUntil
  date?: string;      // alias for waitUntil
  dateTime?: string;  // alias for waitUntil
}

// ─── Node registry ────────────────────────────────────────────────────────────
//
// Mirrors HANDLER_NODE_ALLOWLIST in lib/workflow-runtime/node-handlers/index.ts
// and generic substring routing in pickHandler().

export const NODE_TYPES = {
  // ── Triggers (start nodes) ────────────────────────────────────────────────
  WEBHOOK:           'n8n-nodes-base.webhook',
  MANUAL_TRIGGER:    'n8n-nodes-base.manualTrigger',
  SHOPIFY_TRIGGER:   'n8n-nodes-base.shopifytrigger',
  SLACK_TRIGGER:     'n8n-nodes-base.slacktrigger',
  AIRTABLE_TRIGGER:  'n8n-nodes-base.airtabletrigger',
  GMAIL_TRIGGER:     'n8n-nodes-base.gmailtrigger',
  GDRIVE_TRIGGER:    'n8n-nodes-base.googledrivetrigger',

  // ── Actions ───────────────────────────────────────────────────────────────
  SLACK:             'n8n-nodes-base.slack',
  EMAIL_SEND:        'n8n-nodes-base.emailsend',
  EMAIL_READ_IMAP:   'n8n-nodes-base.emailreadimap',
  GMAIL:             'n8n-nodes-base.gmail',
  AIRTABLE:          'n8n-nodes-base.airtable',
  SHOPIFY:           'n8n-nodes-base.shopify',
  GOOGLE_DRIVE:      'n8n-nodes-base.googledrive',

  // ── Control flow ──────────────────────────────────────────────────────────
  IF:                'n8n-nodes-base.if',
  WAIT:              'n8n-nodes-base.wait',
} as const;

export type NodeTypeLiteral = typeof NODE_TYPES[keyof typeof NODE_TYPES];

export interface NodeSpec {
  type: NodeTypeLiteral;
  description: string;
  isStartNode: boolean;
  isConditionNode: boolean;
  requiresConditionPorts: boolean;
  parameterSchema: string;
  exampleParameters: Record<string, unknown>;
}

export const NODE_REGISTRY: Record<string, NodeSpec> = {
  webhook: {
    type: NODE_TYPES.WEBHOOK,
    description: 'HTTP webhook trigger. Starts the workflow when an HTTP POST arrives. Returns the request body as outputData.',
    isStartNode: true,
    isConditionNode: false,
    requiresConditionPorts: false,
    parameterSchema: 'none required',
    exampleParameters: {},
  },
  manualTrigger: {
    type: NODE_TYPES.MANUAL_TRIGGER,
    description: 'Manual trigger for testing. Starts the workflow when triggered from the UI.',
    isStartNode: true,
    isConditionNode: false,
    requiresConditionPorts: false,
    parameterSchema: 'none required',
    exampleParameters: {},
  },
  shopifyTrigger: {
    type: NODE_TYPES.SHOPIFY_TRIGGER,
    description: 'Shopify event trigger. Starts the workflow when a Shopify event (e.g. order created) fires. Passes event data as outputData.',
    isStartNode: true,
    isConditionNode: false,
    requiresConditionPorts: false,
    parameterSchema: 'none required',
    exampleParameters: {},
  },
  slack: {
    type: NODE_TYPES.SLACK,
    description: 'Send a Slack message via webhook. Requires a connected Slack integration.',
    isStartNode: false,
    isConditionNode: false,
    requiresConditionPorts: false,
    parameterSchema: '{ channel: string, text: string }',
    exampleParameters: { channel: '#general', text: 'Hello from MagicFlux!' },
  },
  emailSend: {
    type: NODE_TYPES.EMAIL_SEND,
    description: 'Send an email via SMTP. Requires a connected email integration.',
    isStartNode: false,
    isConditionNode: false,
    requiresConditionPorts: false,
    parameterSchema: '{ to: string, subject: string, text: string }',
    exampleParameters: { to: 'user@example.com', subject: 'Notification', text: 'Automated message.' },
  },
  airtable: {
    type: NODE_TYPES.AIRTABLE,
    description: 'Insert a record into Airtable. Requires a connected Airtable integration. Inserts inputData as the record fields.',
    isStartNode: false,
    isConditionNode: false,
    requiresConditionPorts: false,
    parameterSchema: '{ table: string, baseId?: string }',
    exampleParameters: { table: 'Records', baseId: '' },
  },
  shopify: {
    type: NODE_TYPES.SHOPIFY,
    description: 'Shopify action node. When type includes "order", fetches order by ID from inputData.order_id.',
    isStartNode: false,
    isConditionNode: false,
    requiresConditionPorts: false,
    parameterSchema: '{ orderId?: string }',
    exampleParameters: {},
  },
  ifCondition: {
    type: NODE_TYPES.IF,
    description: 'Branches the workflow. Evaluates conditions against inputData. True → port[0], False → port[1]. REQUIRES exactly two output ports.',
    isStartNode: false,
    isConditionNode: true,
    requiresConditionPorts: true,
    parameterSchema: '{ conditions: ConditionRule[] }',
    exampleParameters: {
      conditions: [{ field: 'status', operator: 'equals', value: 'active' }],
    },
  },
  wait: {
    type: NODE_TYPES.WAIT,
    description: 'Pauses workflow execution. Use "amount" for duration (seconds) or "waitUntil" for absolute time.',
    isStartNode: false,
    isConditionNode: false,
    requiresConditionPorts: false,
    parameterSchema: '{ amount?: number } | { waitUntil?: string }',
    exampleParameters: { amount: 300 },
  },
  gmail: {
    type: NODE_TYPES.GMAIL,
    description: 'Gmail action via SMTP. Same parameter schema as emailSend.',
    isStartNode: false,
    isConditionNode: false,
    requiresConditionPorts: false,
    parameterSchema: '{ to: string, subject: string, text: string }',
    exampleParameters: { to: 'user@example.com', subject: 'Notice', text: 'Automated email.' },
  },
};

// ─── Validation rules reference ───────────────────────────────────────────────

export const VALIDATION_RULES = {
  MAX_NODES: 200,
  MAX_EDGES: 1000,
  START_NODE_SUBSTRINGS: ['trigger', 'webhook', 'manualtrigger'],
  CONDITION_NODE_SUBSTRINGS: ['if', 'condition', 'switch', 'filter'],
  PROVIDER_EXACT_TYPES: [
    'n8n-nodes-base.shopify', 'n8n-nodes-base.shopifytrigger',
    'n8n-nodes-base.slack', 'n8n-nodes-base.slacktrigger',
    'n8n-nodes-base.airtable', 'n8n-nodes-base.airtabletrigger',
    'n8n-nodes-base.emailsend', 'n8n-nodes-base.emailreadimap',
    'n8n-nodes-base.gmail', 'n8n-nodes-base.gmailtrigger',
    'n8n-nodes-base.googledrive', 'n8n-nodes-base.googledrivetrigger',
  ] as ReadonlyArray<string>,
} as const;

// ─── Builder helpers ──────────────────────────────────────────────────────────

/**
 * Build a linear (chain) workflow: node[0] → node[1] → ... → node[n].
 */
export function buildLinearWorkflow(
  name: string,
  nodes: WorkflowNode[],
): WorkflowJson {
  const connections: WorkflowConnections = {};
  for (let i = 0; i < nodes.length - 1; i++) {
    connections[nodes[i].name] = {
      main: [[{ node: nodes[i + 1].name }]],
    };
  }
  return { name, nodes, connections };
}

/**
 * Build a fan-out workflow: trigger → [all targets in parallel].
 */
export function buildFanoutWorkflow(
  name: string,
  triggerNode: WorkflowNode,
  targetNodes: WorkflowNode[],
): WorkflowJson {
  const nodes = [triggerNode, ...targetNodes];
  const connections: WorkflowConnections = {
    [triggerNode.name]: {
      main: [targetNodes.map(n => ({ node: n.name }))],
    },
  };
  return { name, nodes, connections };
}

/**
 * Build a conditional workflow: trigger → condition → trueBranch | falseBranch.
 * The condition node gets exactly two output ports.
 */
export function buildConditionalWorkflow(
  name: string,
  triggerNode: WorkflowNode,
  conditionNode: WorkflowNode,
  trueBranchNodes: WorkflowNode[],
  falseBranchNodes: WorkflowNode[],
): WorkflowJson {
  const nodes = [
    triggerNode,
    conditionNode,
    ...trueBranchNodes,
    ...falseBranchNodes,
  ];

  const connections: WorkflowConnections = {
    [triggerNode.name]: { main: [[{ node: conditionNode.name }]] },
    [conditionNode.name]: {
      main: [
        trueBranchNodes.length  > 0 ? trueBranchNodes.map(n => ({ node: n.name }))  : [],
        falseBranchNodes.length > 0 ? falseBranchNodes.map(n => ({ node: n.name })) : [],
      ],
    },
  };

  // Chain within each branch
  for (const branch of [trueBranchNodes, falseBranchNodes]) {
    for (let i = 0; i < branch.length - 1; i++) {
      connections[branch[i].name] = { main: [[{ node: branch[i + 1].name }]] };
    }
  }

  return { name, nodes, connections };
}

/**
 * Build a wait workflow: trigger → wait → action.
 */
export function buildWaitWorkflow(
  name: string,
  triggerNode: WorkflowNode,
  waitSeconds: number,
  waitNodeName: string,
  actionNodes: WorkflowNode[],
): WorkflowJson {
  const waitNode: WorkflowNode = {
    name: waitNodeName,
    type: NODE_TYPES.WAIT,
    parameters: { amount: waitSeconds },
  };
  return buildLinearWorkflow(name, [triggerNode, waitNode, ...actionNodes]);
}

/** Convenience: create a webhook trigger node. */
export function webhookNode(name = 'Webhook Trigger'): WorkflowNode {
  return { name, type: NODE_TYPES.WEBHOOK };
}

/** Convenience: create a Shopify trigger node. */
export function shopifyTriggerNode(name = 'Shopify Order Trigger'): WorkflowNode {
  return { name, type: NODE_TYPES.SHOPIFY_TRIGGER };
}

/** Convenience: create a Slack action node. */
export function slackNode(
  name: string,
  channel: string,
  text: string,
): WorkflowNode {
  return { name, type: NODE_TYPES.SLACK, parameters: { channel, text } };
}

/** Convenience: create an email send node. */
export function emailNode(
  name: string,
  to: string,
  subject: string,
  text: string,
): WorkflowNode {
  return { name, type: NODE_TYPES.EMAIL_SEND, parameters: { to, subject, text } };
}

/** Convenience: create an Airtable node. */
export function airtableNode(
  name: string,
  table: string,
  baseId = '',
): WorkflowNode {
  return { name, type: NODE_TYPES.AIRTABLE, parameters: { table, baseId } };
}

/** Convenience: create an IF condition node. */
export function conditionNode(
  name: string,
  conditions: ConditionRule[],
): WorkflowNode {
  return { name, type: NODE_TYPES.IF, parameters: { conditions } };
}

/** Convenience: create a wait node. */
export function waitNode(name: string, seconds: number): WorkflowNode {
  return { name, type: NODE_TYPES.WAIT, parameters: { amount: seconds } };
}

// ─── Documentation strings (used in prompt templates) ────────────────────────

export const WORKFLOW_STRUCTURE_DOC = `
A MagicFlux workflow is a JSON object with this structure:
{
  "name": string,          // Human-readable title
  "nodes": Node[],         // Array of node objects; must be non-empty
  "connections": {         // Adjacency map; key = source node name
    "<sourceName>": {
      "main": [            // Array of output ports
        [{ "node": "<targetName>" }],   // port 0 targets
        [{ "node": "<targetName>" }]    // port 1 targets (condition nodes only)
      ]
    }
  }
}
`.trim();

export const NODE_SCHEMA_DOC = `
Every node must have:
  name: string  — unique identifier; must match connection keys exactly
  type: string  — determines which handler runs

Optional:
  id: string              — stable UUID (auto-assigned if absent)
  parameters: object      — handler-specific configuration

Node type → handler mapping:
  n8n-nodes-base.webhook          → webhookHandler    (START NODE)
  n8n-nodes-base.shopifytrigger   → shopifyHandler    (START NODE)
  n8n-nodes-base.slack            → slackHandler      parameters: { channel, text }
  n8n-nodes-base.emailsend        → emailHandler      parameters: { to, subject, text }
  n8n-nodes-base.airtable         → airtableHandler   parameters: { table, baseId? }
  n8n-nodes-base.if               → conditionHandler  parameters: { conditions[] } NEEDS 2 PORTS
  n8n-nodes-base.wait             → waitHandler       parameters: { amount? (seconds) | waitUntil? (ISO) }
`.trim();

export const RULES_DOC = `
Critical rules for valid workflows:
1. At least one node whose type contains "trigger", "webhook", or "manualtrigger"
2. All node names must be unique and non-empty strings
3. Connection source keys must match node names exactly (case-sensitive)
4. Connection target node values must match node names exactly
5. Condition nodes (type contains "if") MUST have exactly 2 output ports:
     connections["NodeName"].main = [ [true-targets], [false-targets] ]
6. No graph cycles (A→B→A is invalid)
7. Maximum 200 nodes, 1000 edges
`.trim();

export const CONNECTION_FORMAT_DOC = `
Connection format examples:

LINEAR: A → B
  "A": { "main": [[{ "node": "B" }]] }

FAN-OUT: A → [B, C, D]
  "A": { "main": [[{ "node": "B" }, { "node": "C" }, { "node": "D" }]] }

CONDITION: A → B (true) / C (false)
  "A": { "main": [[{ "node": "B" }], [{ "node": "C" }]] }
  Note: port[0] = true branch, port[1] = false branch
`.trim();
