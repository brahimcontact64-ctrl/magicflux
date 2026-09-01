/**
 * Workflow Validator
 *
 * Single source of truth that guarantees any workflow saved to the database
 * can execute safely inside the runtime engine (runtime/workflow-engine.ts).
 *
 * All rules are derived directly from the engine source:
 *   - Node lookup key  : node.name (String(node.name ?? node.id ?? '').trim())
 *   - Start node rule  : type.includes('trigger'|'webhook'|'manualtrigger')
 *   - Condition rule   : type.includes('if'|'condition'|'switch'|'filter')
 *     BUT provider types from HANDLER_NODE_ALLOWLIST are NEVER condition nodes
 *     even when their name happens to contain 'if' (e.g. 'shopify' ⊃ 'if').
 *   - Condition routing: _conditionBranch=0 → port[0], =1 → port[1]
 *   - Max executions   : 400 nodes (validator is more conservative: 200)
 *   - Connections key  : source node name → ConnectionEntry[][]
 *   - Connection target: ConnectionEntry.node must equal target node name
 *   - Node capability  : lib/workflow-runtime/node-capabilities.ts (Phase 9.1.6)
 *     is the single source of truth for "can the runtime actually execute
 *     this node" — an unsupported/unsafe node is a hard ERROR here, not a
 *     warning, so it can never reach activateWorkflow().
 */

import { checkNodeCapability, PROVIDER_EXACT_TYPES } from '@/lib/workflow-runtime/node-capabilities';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  path?: string;
}

// ─── Error / warning codes ────────────────────────────────────────────────────

export const ValidationCodes = {
  // Structure
  INVALID_WORKFLOW:        'INVALID_WORKFLOW',
  MISSING_NODES:           'MISSING_NODES',
  EMPTY_WORKFLOW:          'EMPTY_WORKFLOW',
  MISSING_CONNECTIONS:     'MISSING_CONNECTIONS',
  // Nodes
  MISSING_NODE_NAME:       'MISSING_NODE_NAME',
  MISSING_NODE_TYPE:       'MISSING_NODE_TYPE',
  DUPLICATE_NODE_NAME:     'DUPLICATE_NODE_NAME',
  // Connections
  UNKNOWN_SOURCE_NODE:     'UNKNOWN_SOURCE_NODE',
  UNKNOWN_TARGET_NODE:     'UNKNOWN_TARGET_NODE',
  // Topology
  NO_START_NODE:           'NO_START_NODE',
  INVALID_CONDITION_PORTS: 'INVALID_CONDITION_PORTS',
  GRAPH_CYCLE_DETECTED:    'GRAPH_CYCLE_DETECTED',
  WORKFLOW_TOO_LARGE:      'WORKFLOW_TOO_LARGE',
  // Capability (Phase 9.1.6) — hard errors: a node the runtime cannot
  // safely execute must never pass validation, so it can never reach
  // activateWorkflow(). See lib/workflow-runtime/node-capabilities.ts.
  UNSUPPORTED_NODE_CAPABILITY: 'UNSUPPORTED_NODE_CAPABILITY',
  // Warnings only
  UNREACHABLE_NODE:        'UNREACHABLE_NODE',
} as const;

// ─── Size limits (validator is intentionally more conservative than engine) ───

const MAX_NODES = 200;
const MAX_EDGES = 1000;

// ─── Node type registry ───────────────────────────────────────────────────────
//
// PROVIDER_EXACT_TYPES (imported above) and checkNodeCapability() now live in
// lib/workflow-runtime/node-capabilities.ts — the single source of truth this
// validator, the planner, the editor, and node-handlers/index.ts's own
// dispatch all read, instead of four independently hand-synced copies
// (Phase 9.1.6). allowlist-consistency.security.test.ts still enforces
// agreement with PROVIDER_NODE_ALLOWLIST in lib/integrations.ts.

// ─── Internal representation ──────────────────────────────────────────────────

/** A node that has passed basic field validation. */
interface ValidatedNode {
  readonly name: string;
  readonly type: string;
  readonly index: number;
}

/**
 * Flat adjacency map: source name → unique target names (all ports merged).
 * Used for cycle detection and reachability.
 */
type AdjacencyMap = Map<string, string[]>;

/**
 * Per-port map: source name → [[port0 targets], [port1 targets], ...].
 * Used for condition-node port count validation.
 */
type PortMap = Map<string, string[][]>;

// ─── Type guards ──────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// ─── Node type helpers ────────────────────────────────────────────────────────

/**
 * Returns true when the node type marks it as a workflow entry point.
 * Mirrors workflow-engine.ts findStartNodes().
 */
function isStartNodeType(type: string): boolean {
  const lc = type.toLowerCase();
  return lc.includes('trigger') || lc.includes('webhook') || lc.includes('manualtrigger');
}

/**
 * Returns true when the node type should be routed to conditionHandler.
 * Mirrors pickHandler() in node-handlers/index.ts — CRITICAL: provider types
 * from HANDLER_NODE_ALLOWLIST are checked FIRST.  'n8n-nodes-base.shopify'
 * contains the substring 'if' (shop-i-f-y) so without this guard it would be
 * wrongly classified as a condition node, requiring two output ports.
 */
function isConditionNodeType(type: string): boolean {
  const lc = type.toLowerCase();
  if (PROVIDER_EXACT_TYPES.has(lc)) return false;           // provider — not a condition
  if (isStartNodeType(lc)) return false;                    // trigger — not a condition
  return (
    lc.includes('if')        ||
    lc.includes('condition') ||
    lc.includes('switch')    ||
    lc.includes('filter')
  );
}

// ─── Phase helpers ────────────────────────────────────────────────────────────

// Phase 1 ─ structure ─────────────────────────────────────────────────────────

type StructureOk = {
  ok: true;
  rawNodes: unknown[];
  rawConnections: Record<string, unknown>;
};
type StructureFail = { ok: false; errors: ValidationError[] };
type StructureResult = StructureOk | StructureFail;

function checkStructure(workflow: unknown): StructureResult {
  if (!isPlainObject(workflow)) {
    return {
      ok: false,
      errors: [{
        code: ValidationCodes.INVALID_WORKFLOW,
        message: 'Workflow must be a non-null plain object.',
      }],
    };
  }

  const errors: ValidationError[] = [];

  if (!Array.isArray(workflow.nodes)) {
    errors.push({
      code: ValidationCodes.MISSING_NODES,
      message: '`nodes` must be an array.',
      path: 'nodes',
    });
  } else if ((workflow.nodes as unknown[]).length === 0) {
    errors.push({
      code: ValidationCodes.EMPTY_WORKFLOW,
      message: 'Workflow must contain at least one node.',
      path: 'nodes',
    });
  }

  if (!isPlainObject(workflow.connections)) {
    errors.push({
      code: ValidationCodes.MISSING_CONNECTIONS,
      message: '`connections` must be a plain object.',
      path: 'connections',
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    rawNodes:       workflow.nodes as unknown[],
    rawConnections: workflow.connections as Record<string, unknown>,
  };
}

// Phase 2 ─ per-node field validation ─────────────────────────────────────────

interface NodeCheckResult {
  validNodes: ValidatedNode[];
  errors: ValidationError[];
}

function checkNodes(rawNodes: unknown[]): NodeCheckResult {
  const errors: ValidationError[] = [];
  const validNodes: ValidatedNode[] = [];

  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i];

    if (!isPlainObject(raw)) {
      errors.push({
        code: ValidationCodes.MISSING_NODE_NAME,
        message: `Node at index ${i} is not a plain object.`,
        path: `nodes[${i}]`,
      });
      continue;
    }

    let ok = true;

    if (!isNonEmptyString(raw.name)) {
      errors.push({
        code: ValidationCodes.MISSING_NODE_NAME,
        message: `Node at index ${i} is missing a non-empty \`name\`.`,
        path: `nodes[${i}].name`,
      });
      ok = false;
    }

    if (!isNonEmptyString(raw.type)) {
      errors.push({
        code: ValidationCodes.MISSING_NODE_TYPE,
        message: `Node at index ${i} is missing a non-empty \`type\`.`,
        path: `nodes[${i}].type`,
      });
      ok = false;
    }

    if (ok) {
      validNodes.push({ name: raw.name as string, type: raw.type as string, index: i });
    }
  }

  return { validNodes, errors };
}

// Phase 3 ─ unique names ──────────────────────────────────────────────────────

function checkUniqueNames(nodes: ValidatedNode[]): ValidationError[] {
  const seen = new Map<string, number>(); // name → first occurrence index
  const errors: ValidationError[] = [];

  for (const node of nodes) {
    const first = seen.get(node.name);
    if (first !== undefined) {
      errors.push({
        code: ValidationCodes.DUPLICATE_NODE_NAME,
        message: `Duplicate node name "${node.name}" — first at index ${first}, repeated at index ${node.index}.`,
        path: `nodes[${node.index}].name`,
      });
    } else {
      seen.set(node.name, node.index);
    }
  }

  return errors;
}

// Phase 4 ─ size limits ───────────────────────────────────────────────────────

function checkSize(
  nodes: ValidatedNode[],
  rawConnections: Record<string, unknown>,
): ValidationError[] {
  if (nodes.length > MAX_NODES) {
    return [{
      code: ValidationCodes.WORKFLOW_TOO_LARGE,
      message: `Workflow has ${nodes.length} nodes; maximum is ${MAX_NODES}.`,
      path: 'nodes',
    }];
  }

  let edgeCount = 0;
  for (const value of Object.values(rawConnections)) {
    if (!isPlainObject(value)) continue;
    const main = value.main;
    if (!Array.isArray(main)) continue;
    for (const port of main) {
      if (Array.isArray(port)) edgeCount += port.length;
    }
  }

  if (edgeCount > MAX_EDGES) {
    return [{
      code: ValidationCodes.WORKFLOW_TOO_LARGE,
      message: `Workflow has ${edgeCount} edges; maximum is ${MAX_EDGES}.`,
      path: 'connections',
    }];
  }

  return [];
}

// Phase 5 ─ connection validation + graph construction ────────────────────────

interface ConnectionCheckResult {
  errors: ValidationError[];
  adj: AdjacencyMap;
  ports: PortMap;
}

function checkConnections(
  rawConnections: Record<string, unknown>,
  nodeSet: ReadonlySet<string>,
): ConnectionCheckResult {
  const errors: ValidationError[] = [];
  const adj: AdjacencyMap = new Map();
  const ports: PortMap = new Map();

  // Initialise every node with empty outgoing lists
  for (const name of nodeSet) {
    adj.set(name, []);
    ports.set(name, []);
  }

  for (const [source, connData] of Object.entries(rawConnections)) {
    if (!nodeSet.has(source)) {
      errors.push({
        code: ValidationCodes.UNKNOWN_SOURCE_NODE,
        message: `Connection source "${source}" does not match any node name.`,
        path: `connections["${source}"]`,
      });
      continue; // skip — can't build edges for a phantom source
    }

    if (!isPlainObject(connData)) continue;
    const main = connData.main;
    if (!Array.isArray(main)) continue;

    const portList: string[][] = [];

    for (let portIdx = 0; portIdx < main.length; portIdx++) {
      const port = main[portIdx];
      const portTargets: string[] = [];

      if (!Array.isArray(port)) {
        portList.push(portTargets); // empty port — keep index alignment
        continue;
      }

      for (let entryIdx = 0; entryIdx < port.length; entryIdx++) {
        const entry = port[entryIdx];
        if (!isPlainObject(entry)) continue;

        const target = entry.node;
        if (typeof target !== 'string' || target.trim() === '') continue;

        if (!nodeSet.has(target)) {
          errors.push({
            code: ValidationCodes.UNKNOWN_TARGET_NODE,
            message: `Connection target "${target}" in source "${source}" port ${portIdx} does not match any node name.`,
            path: `connections["${source}"].main[${portIdx}][${entryIdx}]`,
          });
          // Don't add to graph — keeps adj/ports clean for downstream analysis
        } else {
          portTargets.push(target);

          // Flat adjacency (deduplicated) for cycle + reachability algorithms
          const outgoing = adj.get(source) as string[];
          if (!outgoing.includes(target)) outgoing.push(target);
        }
      }

      portList.push(portTargets);
    }

    ports.set(source, portList);
  }

  return { errors, adj, ports };
}

// Phase 6a ─ start node ────────────────────────────────────────────────────────

function checkStartNode(nodes: ValidatedNode[]): ValidationError[] {
  const hasStart = nodes.some(n => isStartNodeType(n.type));
  if (!hasStart) {
    return [{
      code: ValidationCodes.NO_START_NODE,
      message:
        'Workflow has no start node. Add a node whose type contains ' +
        '"trigger", "webhook", or "manualTrigger".',
      path: 'nodes',
    }];
  }
  return [];
}

// Phase 6b ─ condition port count ─────────────────────────────────────────────

function checkConditionPorts(
  nodes: ValidatedNode[],
  ports: PortMap,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const node of nodes) {
    if (!isConditionNodeType(node.type)) continue;

    const nodePorts = ports.get(node.name) ?? [];
    if (nodePorts.length < 2) {
      errors.push({
        code: ValidationCodes.INVALID_CONDITION_PORTS,
        message:
          `Condition node "${node.name}" (type: "${node.type}") must define at least ` +
          `two output ports in connections — port[0] for the true branch, port[1] for ` +
          `the false branch. Found ${nodePorts.length} port(s).`,
        path: `connections["${node.name}"]`,
      });
    }
  }

  return errors;
}

// Phase 7a ─ cycle detection (iterative DFS, O(V+E)) ─────────────────────────
//
// Three-colour DFS:
//   WHITE (0) — not yet visited
//   GRAY  (1) — on the current path (in stack)
//   BLACK (2) — fully explored
//
// A back edge from node N to a GRAY ancestor signals a cycle.
// The path array records the current DFS stack for meaningful cycle messages.

const WHITE = 0 as const;
const GRAY  = 1 as const;
const BLACK = 2 as const;
type Color = 0 | 1 | 2;

function detectCycles(
  nodeNames: ReadonlySet<string>,
  adj: AdjacencyMap,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const color = new Map<string, Color>();
  for (const n of nodeNames) color.set(n, WHITE);

  const reportedKeys = new Set<string>(); // deduplicate identical cycles
  const currentPath: string[] = [];
  const pathSet     = new Set<string>();

  // One DFS tree rooted at `start`.
  // Uses an explicit frame stack [nodeName, nextNeighborIndex] to avoid
  // JavaScript call-stack growth on deep linear graphs.
  function dfsWith(start: string): void {
    // Push initial frame
    color.set(start, GRAY);
    currentPath.push(start);
    pathSet.add(start);

    // Stack of [node, index into its neighbour list]
    const stack: [string, number][] = [[start, 0]];

    while (stack.length > 0) {
      const frame       = stack[stack.length - 1];
      const [node]      = frame;
      const neighbours  = adj.get(node) ?? [];

      let advanced = false;

      // Advance through unprocessed neighbours
      while (frame[1] < neighbours.length) {
        const ni       = frame[1]++;           // consume this index
        const nb       = neighbours[ni];
        const c        = color.get(nb) ?? WHITE;

        if (c === GRAY && pathSet.has(nb)) {
          // Back edge → cycle
          const cycleStart = currentPath.indexOf(nb);
          const cycle      = currentPath.slice(cycleStart);
          const key        = [...cycle].sort().join('\0');

          if (!reportedKeys.has(key)) {
            reportedKeys.add(key);
            errors.push({
              code:    ValidationCodes.GRAPH_CYCLE_DETECTED,
              message: `Cycle detected: ${cycle.join(' → ')} → ${nb}`,
              path:    'nodes',
            });
          }
          // Don't push nb — continue scanning remaining neighbours
        } else if (c === WHITE) {
          // Tree edge — descend
          color.set(nb, GRAY);
          currentPath.push(nb);
          pathSet.add(nb);
          stack.push([nb, 0]);
          advanced = true;
          break; // restart outer while with new top-of-stack
        }
        // BLACK: cross/forward edge — skip
      }

      if (!advanced) {
        // All neighbours of `node` processed — backtrack
        stack.pop();
        currentPath.pop();
        pathSet.delete(node);
        color.set(node, BLACK);
      }
    }
  }

  for (const name of nodeNames) {
    if ((color.get(name) ?? WHITE) === WHITE) dfsWith(name);
  }

  return errors;
}

// Phase 7b ─ unreachable nodes (BFS from start nodes, O(V+E)) ─────────────────

function detectUnreachable(
  nodes: ValidatedNode[],
  adj: AdjacencyMap,
  startNodes: ValidatedNode[],
): ValidationWarning[] {
  const visited = new Set<string>();
  const queue: string[] = startNodes.map(n => n.name);

  for (let i = 0; i < queue.length; i++) {
    const name = queue[i];
    if (visited.has(name)) continue;
    visited.add(name);
    for (const target of (adj.get(name) ?? [])) {
      if (!visited.has(target)) queue.push(target);
    }
  }

  const warnings: ValidationWarning[] = [];
  for (const node of nodes) {
    if (!visited.has(node.name)) {
      warnings.push({
        code:    ValidationCodes.UNREACHABLE_NODE,
        message: `Node "${node.name}" is unreachable from any start node.`,
        path:    `nodes[${node.index}]`,
      });
    }
  }

  return warnings;
}

// Phase 4.5 ─ node capability (Phase 9.1.6, hard error) ───────────────────────
//
// Checks every node against lib/workflow-runtime/node-capabilities.ts — the
// same check the runtime's own dispatch (pickHandler()) applies. A node the
// runtime cannot safely execute is a validation ERROR, not a warning: it
// must never reach activateWorkflow(). Message is the capability's
// `userMessage` only — no raw node type strings or internal handler jargon
// reach the caller (Phase 9.1.6 Step E).

function checkNodeCapabilities(rawNodes: unknown[], validNodes: ValidatedNode[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const node of validNodes) {
    const raw = rawNodes[node.index];
    const parameters = isPlainObject(raw) ? (raw as { parameters?: unknown }).parameters : undefined;
    const capability = checkNodeCapability({ type: node.type, parameters });
    if (!capability.capable) {
      errors.push({
        code:    ValidationCodes.UNSUPPORTED_NODE_CAPABILITY,
        message: `"${node.name}": ${capability.userMessage}`,
        path:    `nodes[${node.index}].type`,
      });
    }
  }

  return errors;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Validates a workflow object against every rule enforced by the runtime
 * engine.  Returns a `ValidationResult` that is `valid: true` only when
 * the workflow can be executed safely without modification.
 *
 * @param workflow  The raw value stored (or to be stored) in `workflow_json`.
 */
export function validateWorkflow(workflow: unknown): ValidationResult {
  const errors:   ValidationError[]   = [];
  const warnings: ValidationWarning[] = [];

  // ── Phase 1: Structure ────────────────────────────────────────────────────
  const structure = checkStructure(workflow);
  if (!structure.ok) {
    return { valid: false, errors: structure.errors, warnings };
  }

  const { rawNodes, rawConnections } = structure;

  // ── Phase 2: Node fields ──────────────────────────────────────────────────
  const { validNodes, errors: nodeErrors } = checkNodes(rawNodes);
  errors.push(...nodeErrors);

  // ── Phase 3: Unique names ─────────────────────────────────────────────────
  const dupeErrors = checkUniqueNames(validNodes);
  errors.push(...dupeErrors);

  // ── Phase 4: Size ─────────────────────────────────────────────────────────
  errors.push(...checkSize(validNodes, rawConnections));

  // ── Phase 4.5: Node capability (Phase 9.1.6) — hard error, always checked ──
  errors.push(...checkNodeCapabilities(rawNodes, validNodes));

  // Graph analysis requires a well-formed node set.  If any node has a missing
  // name, an empty name, or a duplicate name, the nodeMap would be ambiguous —
  // skip graph phases to avoid misleading errors.
  const graphBlocked = nodeErrors.length > 0 || dupeErrors.length > 0;
  if (graphBlocked) {
    return { valid: false, errors, warnings };
  }

  const nodeSet = new Set(validNodes.map(n => n.name));

  // ── Phase 5: Connections ──────────────────────────────────────────────────
  const { errors: connErrors, adj, ports } = checkConnections(rawConnections, nodeSet);
  errors.push(...connErrors);

  // ── Phase 6a: Start node ──────────────────────────────────────────────────
  errors.push(...checkStartNode(validNodes));

  // ── Phase 6b: Condition ports ─────────────────────────────────────────────
  errors.push(...checkConditionPorts(validNodes, ports));

  // Graph topology algorithms are only meaningful when the connection map is
  // complete (no phantom sources or targets).
  if (connErrors.length === 0) {
    // ── Phase 7a: Cycle detection ───────────────────────────────────────────
    errors.push(...detectCycles(nodeSet, adj));

    // ── Phase 7b: Unreachable nodes ─────────────────────────────────────────
    const startNodes = validNodes.filter(n => isStartNodeType(n.type));
    if (startNodes.length > 0) {
      warnings.push(...detectUnreachable(validNodes, adj, startNodes));
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
