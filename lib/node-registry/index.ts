/**
 * Central node registry — single source of truth for all node types.
 *
 * All node metadata (label, icon, fields, category) lives here.
 * Nothing outside this module should hardcode node type strings or icons.
 */

import type { NodeDef } from './types';
export type { NodeDef, FieldSchema, FieldType, FieldError, SelectOption, NodeCategory } from './types';
export { validateNodeConfig } from './types';

import { webhookNode, scheduleTriggerNode, shopifyTriggerNode, gmailTriggerNode } from './nodes/triggers';
import { emailNode, slackNode } from './nodes/messaging';
import { airtableNode } from './nodes/storage';
import { conditionNode, waitNode } from './nodes/control';
import { openAiNode, codeNode } from './nodes/ai';
import { httpRequestNode } from './nodes/http';

// ─── Registry ─────────────────────────────────────────────────────────────────

const ALL_NODES: NodeDef[] = [
  // Triggers
  webhookNode,
  scheduleTriggerNode,
  shopifyTriggerNode,
  gmailTriggerNode,
  // Messaging
  emailNode,
  slackNode,
  // Storage
  airtableNode,
  // googleDriveNode is intentionally NOT registered here — its runtime handler
  // (lib/workflow-runtime/node-handlers/googledrive.ts) is a stub that always
  // fails with GOOGLE_DRIVE_NOT_IMPLEMENTED in live mode. Exposing it in the
  // node palette / NodeSettingsPanel would let a user build and "connect" a
  // workflow node that can never actually execute. Re-add it once a real
  // Drive handler (list/upload/download/delete/create-folder) exists.
  // Control
  conditionNode,
  waitNode,
  // AI / Code
  openAiNode,
  codeNode,
  // HTTP
  httpRequestNode,
];

/** type → NodeDef, O(1) lookup */
const REGISTRY = new Map<string, NodeDef>(
  ALL_NODES.map((def) => [def.type, def]),
);

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns the definition for a node type, or undefined if not registered. */
export function getNodeDef(type: string): NodeDef | undefined {
  return REGISTRY.get(type);
}

/** Returns all registered node definitions. */
export function getAllNodeDefs(): NodeDef[] {
  return ALL_NODES;
}

/** Returns all node defs for a given category. */
export function getNodeDefsByCategory(category: NodeDef['category']): NodeDef[] {
  return ALL_NODES.filter((d) => d.category === category);
}

/** Category display metadata (label + ordering). */
export const CATEGORY_META: Record<NodeDef['category'], { label: string; order: number }> = {
  trigger:   { label: 'Triggers',   order: 0 },
  messaging: { label: 'Messaging',  order: 1 },
  storage:   { label: 'Storage',    order: 2 },
  control:   { label: 'Control',    order: 3 },
  ai:        { label: 'AI / Code',  order: 4 },
  http:      { label: 'HTTP',       order: 5 },
};

/** Ordered list of unique categories present in the registry. */
export function getCategories(): NodeDef['category'][] {
  const seen = new Set<NodeDef['category']>();
  for (const def of ALL_NODES) seen.add(def.category);
  return [...seen].sort((a, b) => CATEGORY_META[a].order - CATEGORY_META[b].order);
}
