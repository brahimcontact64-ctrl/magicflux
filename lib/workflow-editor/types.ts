/**
 * Shared types for the visual workflow editor.
 *
 * Connections deliberately remain name-based (not ID-based) so the existing
 * runtime engine, validator, and n8n deployment pipeline work unchanged.
 * UUIDs live only inside node objects and are used exclusively by React Flow.
 */

// ─── Workflow JSON (persisted format) ─────────────────────────────────────────

export interface WorkflowJsonNode {
  /** Stable UUID assigned by the editor. Auto-migrated on first visual-editor load. */
  id?: string;
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
  /** Canvas position [x, y]. Auto-layout applied when missing. */
  position?: [number, number];
}

/** A single outgoing connection entry (runtime format). */
export interface ConnectionEntry {
  node: string; // target node NAME (not ID — runtime requirement)
}

/** Per-node connection map (port index → list of targets). */
export type NodeConnections = { main: ConnectionEntry[][] };

/**
 * The workflow_json format stored in the database.
 * Connections use node names so the runtime, validator, and n8n never need changes.
 */
export interface WorkflowJson {
  name: string;
  nodes: WorkflowJsonNode[];
  connections: Record<string, NodeConnections>;
}

// ─── React Flow node data ──────────────────────────────────────────────────────

export interface WorkflowNodeData extends Record<string, unknown> {
  name: string;
  nodeType: string;
  parameters: Record<string, unknown>;
}

// ─── History snapshot ─────────────────────────────────────────────────────────

export interface HistorySnapshot {
  nodes: import('@xyflow/react').Node<WorkflowNodeData>[];
  edges: import('@xyflow/react').Edge<Record<string, unknown>>[];
}
