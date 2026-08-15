/**
 * Workflow Repair Engine
 *
 * Accepts any unknown input (even completely malformed) and returns the closest
 * valid workflow it can construct, along with a log of every change made.
 *
 * Repair order is significant: structural fixes first, then graph-level fixes,
 * then topology fixes.  Each step re-uses the current state so later steps see
 * the results of earlier ones.
 */

import { validateWorkflow, ValidationCodes, type ValidationError } from '../workflow-validator';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RepairResult {
  /** The best valid (or most-fixed) workflow the engine could produce. */
  workflow: RepairedWorkflow;
  /** Ordered list of every change applied. */
  changes: RepairChange[];
  /** True only when the returned workflow passes validateWorkflow(). */
  valid: boolean;
  /** Any errors that could not be automatically fixed. */
  remainingErrors: ValidationError[];
}

export interface RepairChange {
  /** Matches a ValidationCodes constant, or 'STRUCTURE_FIX' for pre-validation repairs. */
  code: string;
  description: string;
}

export interface RepairedWorkflow {
  name: string;
  nodes: RepairedNode[];
  connections: RepairedConnections;
}

interface RepairedNode {
  name: string;
  type: string;
  id?: string;
  parameters?: Record<string, unknown>;
}

type RepairedConnections = Record<string, { main: Array<Array<{ node: string }>> }>;

// ─── Provider allowlist (mirrors validator — these are never condition nodes) ──

const PROVIDER_EXACT_TYPES = new Set([
  'n8n-nodes-base.shopify',       'n8n-nodes-base.shopifytrigger',
  'n8n-nodes-base.slack',         'n8n-nodes-base.slacktrigger',
  'n8n-nodes-base.airtable',      'n8n-nodes-base.airtabletrigger',
  'n8n-nodes-base.emailsend',     'n8n-nodes-base.emailreadimap',
  'n8n-nodes-base.gmail',         'n8n-nodes-base.gmailtrigger',
  'n8n-nodes-base.googledrive',   'n8n-nodes-base.googledrivetrigger',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isStartNodeType(type: string): boolean {
  const lc = type.toLowerCase();
  return lc.includes('trigger') || lc.includes('webhook') || lc.includes('manualtrigger');
}

function isConditionNodeType(type: string): boolean {
  const lc = type.toLowerCase();
  if (PROVIDER_EXACT_TYPES.has(lc)) return false;
  if (isStartNodeType(lc)) return false;
  return lc.includes('if') || lc.includes('condition') || lc.includes('switch') || lc.includes('filter');
}

/** Derives a human-readable node name from its type string. */
function nameFromType(type: string, index: number): string {
  const parts = type.split('.');
  const last = parts[parts.length - 1] ?? 'Node';
  const capitalised = last.charAt(0).toUpperCase() + last.slice(1);
  return `${capitalised} ${index + 1}`;
}

// ─── Main repair function ─────────────────────────────────────────────────────

/**
 * Repair a workflow.
 *
 * @param input  Any value — even null, a string, or a deeply broken object.
 * @returns      RepairResult containing the best workflow the engine could build.
 */
export function repairWorkflow(input: unknown): RepairResult {
  const changes: RepairChange[] = [];

  // ── Step 1: Ensure base object structure ─────────────────────────────────

  let raw: Record<string, unknown>;

  if (!isPlainObject(input)) {
    raw = {};
    changes.push({
      code: ValidationCodes.INVALID_WORKFLOW,
      description: `Input was ${input === null ? 'null' : typeof input} — reconstructed as empty object.`,
    });
  } else {
    raw = { ...input };
  }

  // ── Step 2: Ensure name ───────────────────────────────────────────────────

  if (!isNonEmptyString(raw.name)) {
    raw.name = 'Repaired Workflow';
  }

  // ── Step 3: Ensure nodes is an array ─────────────────────────────────────

  if (!Array.isArray(raw.nodes)) {
    raw.nodes = [];
    changes.push({
      code: ValidationCodes.MISSING_NODES,
      description: 'Added missing nodes array.',
    });
  }

  // ── Step 4: Ensure connections is a plain object ──────────────────────────

  if (!isPlainObject(raw.connections)) {
    raw.connections = {};
    changes.push({
      code: ValidationCodes.MISSING_CONNECTIONS,
      description: 'Added missing connections object.',
    });
  }

  // ── Step 5: Fix individual node fields ────────────────────────────────────

  const rawNodes = raw.nodes as unknown[];
  const nodes: RepairedNode[] = [];

  for (let i = 0; i < rawNodes.length; i++) {
    const rn = rawNodes[i];

    if (!isPlainObject(rn)) {
      changes.push({
        code: ValidationCodes.MISSING_NODE_NAME,
        description: `Skipped non-object node at index ${i}.`,
      });
      continue;
    }

    let name = isNonEmptyString(rn.name) ? rn.name.trim() : '';
    let type = isNonEmptyString(rn.type) ? rn.type.trim() : '';

    if (!type) {
      type = 'n8n-nodes-base.webhook';
      changes.push({
        code: ValidationCodes.MISSING_NODE_TYPE,
        description: `Set default type "n8n-nodes-base.webhook" for unnamed node at index ${i}.`,
      });
    }

    if (!name) {
      name = nameFromType(type, i);
      changes.push({
        code: ValidationCodes.MISSING_NODE_NAME,
        description: `Generated name "${name}" for node at index ${i}.`,
      });
    }

    const node: RepairedNode = { name, type };
    if (isNonEmptyString(rn.id)) node.id = rn.id;
    if (isPlainObject(rn.parameters)) node.parameters = rn.parameters as Record<string, unknown>;

    nodes.push(node);
  }

  raw.nodes = nodes;

  // ── Step 6: Fix duplicate node names ─────────────────────────────────────
  //
  // Strategy: keep the first occurrence of each name unchanged.
  // Rename subsequent duplicates to <name>_2, <name>_3, etc.
  // Build a renameMap so connections can be updated consistently.

  {
    const firstSeen = new Map<string, number>(); // name → first-occurrence index
    const usedNames = new Set<string>();
    const renameMap = new Map<string, string>(); // OLD name → NEW name (per-occurrence)

    // First pass: collect original names and record first occurrences
    for (let i = 0; i < nodes.length; i++) {
      const origName = nodes[i].name;
      if (!firstSeen.has(origName)) {
        firstSeen.set(origName, i);
        usedNames.add(origName);
      }
    }

    // Second pass: rename duplicates (every non-first occurrence)
    const seenCount = new Map<string, number>();
    for (const node of nodes) {
      const count = seenCount.get(node.name) ?? 0;
      seenCount.set(node.name, count + 1);

      if (count === 0) continue; // first occurrence — keep

      const base = node.name;
      let candidate = `${base}_${count + 1}`;
      while (usedNames.has(candidate)) {
        candidate = `${candidate}_`;  // keep appending underscore until unique
      }

      renameMap.set(node.name, candidate); // maps the duplicate to new name
      usedNames.add(candidate);
      changes.push({
        code: ValidationCodes.DUPLICATE_NODE_NAME,
        description: `Renamed duplicate node "${node.name}" → "${candidate}".`,
      });
      node.name = candidate;
    }

    raw.nodes = nodes;

    // Update connections: rename sources and targets using renameMap
    if (renameMap.size > 0) {
      const oldConns = raw.connections as Record<string, unknown>;
      const updatedConns: Record<string, unknown> = {};
      for (const [src, val] of Object.entries(oldConns)) {
        const newSrc = renameMap.get(src) ?? src;
        if (!isPlainObject(val)) { updatedConns[newSrc] = val; continue; }
        const cd = val as Record<string, unknown>;
        if (!Array.isArray(cd.main)) { updatedConns[newSrc] = val; continue; }
        const newMain = (cd.main as unknown[]).map(port => {
          if (!Array.isArray(port)) return port;
          return port.map((entry: unknown) => {
            if (!isPlainObject(entry)) return entry;
            const e = entry as Record<string, unknown>;
            if (typeof e.node !== 'string') return e;
            return { ...e, node: renameMap.get(e.node) ?? e.node };
          });
        });
        updatedConns[newSrc] = { main: newMain };
      }
      raw.connections = updatedConns;
    }
  }

  // ── Step 7: Fix missing start node ────────────────────────────────────────

  {
    const currentNodes = raw.nodes as RepairedNode[];
    const hasStart = currentNodes.some(n => isStartNodeType(n.type));

    if (!hasStart) {
      const triggerNode: RepairedNode = {
        name: 'Webhook Trigger',
        type: 'n8n-nodes-base.webhook',
      };
      currentNodes.unshift(triggerNode);
      raw.nodes = currentNodes;
      changes.push({
        code: ValidationCodes.NO_START_NODE,
        description: 'Added "Webhook Trigger" (n8n-nodes-base.webhook) as start node.',
      });
    }
  }

  // ── Step 8: Fix connections (unknown sources / targets) ───────────────────

  {
    const nodeSet = new Set((raw.nodes as RepairedNode[]).map(n => n.name));
    const rawConns = raw.connections as Record<string, unknown>;
    const fixedConns: RepairedConnections = {};

    for (const [source, connData] of Object.entries(rawConns)) {
      if (!nodeSet.has(source)) {
        changes.push({
          code: ValidationCodes.UNKNOWN_SOURCE_NODE,
          description: `Removed connection from unknown source node "${source}".`,
        });
        continue;
      }

      if (!isPlainObject(connData)) continue;
      const cd = connData as Record<string, unknown>;
      if (!Array.isArray(cd.main)) continue;

      const fixedMain: Array<Array<{ node: string }>> = [];

      for (const port of cd.main as unknown[]) {
        if (!Array.isArray(port)) { fixedMain.push([]); continue; }

        const fixedPort: Array<{ node: string }> = [];
        for (const entry of port as unknown[]) {
          if (!isPlainObject(entry)) continue;
          const e = entry as Record<string, unknown>;
          const target = e.node;
          if (!isNonEmptyString(target)) continue;

          if (!nodeSet.has(target)) {
            changes.push({
              code: ValidationCodes.UNKNOWN_TARGET_NODE,
              description: `Removed unknown target "${target}" from connection source "${source}".`,
            });
            continue;
          }

          fixedPort.push({ node: target });
        }
        fixedMain.push(fixedPort);
      }

      fixedConns[source] = { main: fixedMain };
    }

    raw.connections = fixedConns;
  }

  // ── Step 9: Fix condition node port count ─────────────────────────────────

  {
    const currentNodes = raw.nodes as RepairedNode[];
    const conns = raw.connections as RepairedConnections;

    for (const node of currentNodes) {
      if (!isConditionNodeType(node.type)) continue;

      const existing = conns[node.name];
      if (!existing) {
        conns[node.name] = { main: [[], []] };
        changes.push({
          code: ValidationCodes.INVALID_CONDITION_PORTS,
          description: `Added two empty output ports for condition node "${node.name}".`,
        });
      } else if (existing.main.length < 2) {
        while (existing.main.length < 2) existing.main.push([]);
        changes.push({
          code: ValidationCodes.INVALID_CONDITION_PORTS,
          description: `Added missing second output port for condition node "${node.name}".`,
        });
      }
    }

    raw.connections = conns;
  }

  // ── Step 10: Fix cycles ───────────────────────────────────────────────────
  //
  // Run a validation pass specifically for cycle errors.
  // For each cycle, parse the path from the error message and remove the
  // back edge (last node → first node in the reported path).
  //
  // Error format: "Cycle detected: A → B → C → A"
  // Self-loop:    "Cycle detected: A → A"

  {
    const midCheck = validateWorkflow(raw as unknown);
    const cycleErrors = midCheck.errors.filter(e => e.code === ValidationCodes.GRAPH_CYCLE_DETECTED);

    if (cycleErrors.length > 0) {
      const conns = raw.connections as RepairedConnections;

      for (const err of cycleErrors) {
        // Match: "Cycle detected: <path-with-arrows> → <first-node>"
        const match = err.message.match(/^Cycle detected: (.+?) → ([^→\n]+)$/);
        if (!match) continue;

        const pathStr = match[1].trim();
        const backTarget = match[2].trim();
        const pathNodes = pathStr.split(' → ').map(s => s.trim());
        const lastNode  = pathNodes[pathNodes.length - 1];

        const conn = conns[lastNode];
        if (!conn) continue;

        let removed = false;
        for (const port of conn.main) {
          const idx = port.findIndex(e => e.node === backTarget);
          if (idx !== -1) {
            port.splice(idx, 1);
            removed = true;
            changes.push({
              code: ValidationCodes.GRAPH_CYCLE_DETECTED,
              description: `Removed back edge "${lastNode}" → "${backTarget}" to break cycle.`,
            });
            break;
          }
        }

        if (!removed) {
          // Self-loop or unusual format — try to remove any self-reference
          for (const port of conn.main) {
            const idx = port.findIndex(e => e.node === lastNode);
            if (idx !== -1) {
              port.splice(idx, 1);
              changes.push({
                code: ValidationCodes.GRAPH_CYCLE_DETECTED,
                description: `Removed self-loop on "${lastNode}".`,
              });
              break;
            }
          }
        }
      }

      raw.connections = conns;
    }
  }

  // ── Final validation ──────────────────────────────────────────────────────

  const final = validateWorkflow(raw as unknown);

  return {
    workflow: raw as unknown as RepairedWorkflow,
    changes,
    valid: final.valid,
    remainingErrors: final.errors,
  };
}

// ─── Convenience: repair + assert valid ───────────────────────────────────────

/**
 * Repair a workflow and throw if it still fails validation after repair.
 * Useful in generation pipelines where a valid workflow is required.
 */
export function repairOrThrow(input: unknown): RepairedWorkflow {
  const result = repairWorkflow(input);
  if (!result.valid) {
    const codes = result.remainingErrors.map(e => e.code).join(', ');
    throw new Error(`Workflow could not be fully repaired. Remaining errors: ${codes}`);
  }
  return result.workflow;
}
