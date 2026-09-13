/**
 * Phase 9.9.3.2 -- Human Review decision-authority routing guard.
 *
 * Root cause this exists to prevent: a generated graph correctly routes
 * Human Review's own output ports by the human's chosen outcome
 * (_conditionBranch, dispatched deterministically by runtime/workflow-engine.ts
 * regardless of any data field), but then wires those ports into a node that
 * RE-EVALUATES the field the upstream magicflux-nodes.aiClassifier node
 * originally wrote (e.g. an "If Hot"/"If Warm"/"If Cold" style node reading
 * ={{$json["classification"]}}). Since Human Review never overwrites that
 * field by default, a human overriding the AI's "Hot" call to "Warm" reaches
 * the right port structurally, then immediately fails the re-check node's own
 * condition (classification is still "Hot", not "Warm") and falls into that
 * node's typically-empty false branch -- the human's decision silently
 * produces ZERO downstream actions, agree or disagree.
 *
 * This is a deterministic, fail-closed backstop: reject generation whenever a
 * Human Review node's own output ports feed a conditional node that reads the
 * same field an upstream aiClassifier wrote, UNLESS the Human Review node
 * explicitly declares "overwriteField" set to that exact field name (the
 * HUMAN DECISION AUTHORITY CONTRACT's documented "ALTERNATIVE" shape in
 * lib/agent/executor.ts, backed by a real, tested runtime overwrite in
 * lib/workflow-runtime/node-handlers/human-review.ts). Generic by
 * construction -- it traces whatever field name the classifier's own
 * "outputField" parameter names, never a hardcoded "classification" string,
 * and never assumes Hot/Warm/Cold-shaped outcomes.
 */

import {
  AI_CLASSIFIER_NODE_TYPE,
  HUMAN_REVIEW_NODE_TYPE,
  isConditionalNodeType,
} from '@/lib/workflow-runtime/node-capabilities';

export type HumanReviewRoutingValidation = { ok: true } | { ok: false; reason: string; node?: string };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type PortsShape = { main?: unknown };

function flattenTargets(main: unknown): string[] {
  if (!Array.isArray(main)) return [];
  const targets: string[] = [];
  for (const port of main) {
    if (!Array.isArray(port)) continue;
    for (const entry of port) {
      const target = (entry as { node?: unknown } | null | undefined)?.node;
      if (typeof target === 'string' && target.trim()) targets.push(target.trim());
    }
  }
  return targets;
}

/** True when `parameters` contains a `={{$json["<field>"]}}` (or `.field`) reference to exactly this field name -- narrow, deterministic, matches the shape condition.ts/executor.ts actually generate. */
function referencesJsonField(parameters: unknown, fieldName: string): boolean {
  if (!fieldName) return false;
  let text: string;
  try {
    text = JSON.stringify(parameters ?? {});
  } catch {
    return false;
  }
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\$json\\s*(?:\\[\\\\?["']${escaped}\\\\?["']\\]|\\.${escaped}\\b)`);
  return pattern.test(text);
}

/**
 * Validates that no magicflux-nodes.humanReview node's output ports feed a
 * conditional node re-checking the same field an upstream aiClassifier wrote,
 * unless that Human Review node explicitly declares a matching
 * "overwriteField". A graph with no humanReview node, or one with no
 * upstream aiClassifier at all, always passes -- this only fires for the
 * exact stale-reevaluation shape it exists to catch.
 */
export function validateHumanReviewOutcomeRouting(nodes: unknown[], connections: unknown): HumanReviewRoutingValidation {
  const nodeArray = Array.isArray(nodes) ? nodes : [];
  const connRecord = connections && typeof connections === 'object' && !Array.isArray(connections)
    ? (connections as Record<string, PortsShape>)
    : {};

  type NodeInfo = { name: string; type: string; parameters: unknown };
  const infos: NodeInfo[] = [];
  for (const raw of nodeArray) {
    if (!raw || typeof raw !== 'object') continue;
    const n = raw as Record<string, unknown>;
    const name = String(n.name ?? n.id ?? '').trim();
    if (!name) continue;
    infos.push({ name, type: String(n.type ?? ''), parameters: n.parameters });
  }
  const byName = new Map(infos.map((n) => [n.name, n]));

  // Reverse edges: target -> [source, source, ...]
  const predecessors = new Map<string, string[]>();
  for (const [source, ports] of Object.entries(connRecord)) {
    for (const target of flattenTargets(ports?.main)) {
      const list = predecessors.get(target) ?? [];
      list.push(source);
      predecessors.set(target, list);
    }
  }

  const reviewNodes = infos.filter((n) => n.type.toLowerCase() === HUMAN_REVIEW_NODE_TYPE.toLowerCase());
  if (reviewNodes.length === 0) return { ok: true };

  for (const review of reviewNodes) {
    // Trace backward for the nearest upstream aiClassifier feeding this
    // review node, to learn the exact field name it wrote (its own
    // "outputField" parameter, defaulting to "classification" -- see
    // ai-classifier.ts). No classifier upstream -> nothing to protect here.
    let outputField: string | null = null;
    const seen = new Set<string>();
    const stack = [...(predecessors.get(review.name) ?? [])];
    while (stack.length > 0 && !outputField) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const curNode = byName.get(cur);
      if (curNode && curNode.type.toLowerCase() === AI_CLASSIFIER_NODE_TYPE.toLowerCase()) {
        const rawOutputField = asRecord(curNode.parameters).outputField;
        outputField = typeof rawOutputField === 'string' && rawOutputField.trim() ? rawOutputField.trim() : 'classification';
        break;
      }
      stack.push(...(predecessors.get(cur) ?? []));
    }

    if (!outputField) continue;

    const overwriteFieldRaw = asRecord(review.parameters).overwriteField;
    const overwriteField = typeof overwriteFieldRaw === 'string' ? overwriteFieldRaw.trim() : '';
    if (overwriteField === outputField) continue; // explicit ALTERNATIVE shape -- Human Review overwrites this exact field on resume.

    const directTargets = flattenTargets(connRecord[review.name]?.main);
    for (const targetName of directTargets) {
      const targetNode = byName.get(targetName);
      if (!targetNode) continue;
      if (isConditionalNodeType(targetNode.type) && referencesJsonField(targetNode.parameters, outputField)) {
        return {
          ok: false,
          node: review.name,
          reason:
            `Human Review node "${review.name}" routes into "${targetName}", which re-checks the AI classifier's ` +
            `original "${outputField}" field. Human Review never overwrites that field by default, so a human ` +
            `decision that disagrees with the AI's original classification would reach the correct outcome port ` +
            `but then fail "${targetName}"'s own condition and produce zero downstream actions. Either wire Human ` +
            `Review's outcome ports DIRECTLY to each outcome's terminal action nodes (preferred), or set ` +
            `"overwriteField": "${outputField}" on the Human Review node so its resume deterministically overwrites ` +
            'that field with the human\'s chosen outcome before rejoining this chain.',
        };
      }
    }
  }

  return { ok: true };
}
