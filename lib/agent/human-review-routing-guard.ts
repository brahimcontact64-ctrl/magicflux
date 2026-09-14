/**
 * Phase 9.9.3.2 / 9.9.4C -- Human Review decision-authority routing guard.
 *
 * Two related but distinct defects this guards against:
 *
 * 1. (9.9.3.2) A generated graph correctly routes Human Review's own output
 *    ports by the human's chosen outcome (_conditionBranch, dispatched
 *    deterministically by runtime/workflow-engine.ts regardless of any data
 *    field), but then wires those ports into a node that RE-EVALUATES the
 *    field the upstream magicflux-nodes.aiClassifier node originally wrote
 *    (e.g. an "If Hot"/"If Warm"/"If Cold" style node reading
 *    ={{$json["classification"]}}). Since Human Review never overwrites
 *    that field by default, a human overriding the AI's "Hot" call to
 *    "Warm" reaches the right port structurally, then immediately fails the
 *    re-check node's own condition and produces zero downstream actions.
 *
 * 2. (9.9.4C) Even when routing is structurally correct (Human Review's
 *    ports go DIRECTLY to each outcome's terminal actions -- the preferred
 *    shape, no re-check node at all), the execution's DATA can still carry
 *    the AI classifier's stale, superseded classification/confidence in
 *    fields nothing re-checks for routing but that downstream record-
 *    keeping (an Airtable "Classification"/"Confidence" mapping, a message
 *    template) may still read. Whenever a Human Review node's own
 *    allowedOutcomes are exactly the set of labels an upstream aiClassifier
 *    can produce -- i.e. it is genuinely reviewing that classification, not
 *    an unrelated approve/reject decision -- its own "outputField" MUST be
 *    configured to match the classifier's "outputField", so resume
 *    deterministically makes the human's choice canonical.
 *
 * Both cases share one escape valve: an explicitly configured "outputField"
 * on the Human Review node (mirroring aiClassifier's own parameter of the
 * same name -- lib/workflow-runtime/node-handlers/human-review.ts's real,
 * tested runtime overwrite). Generic by construction -- traces whatever
 * field name the classifier's own "outputField" parameter names and whatever
 * labels/outcomes the two nodes actually declare, never a hardcoded
 * "classification" string or Hot/Warm/Cold-shaped assumption.
 */

import {
  AI_CLASSIFIER_NODE_TYPE,
  HUMAN_REVIEW_NODE_TYPE,
  isConditionalNodeType,
} from '@/lib/workflow-runtime/node-capabilities';
import { referencesJsonField } from '@/lib/workflow-runtime/node-handlers/json-field-reference';

export type HumanReviewRoutingValidation = { ok: true } | { ok: false; reason: string; node?: string };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((x) => setA.has(x)) && new Set(b).size === setA.size;
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

/**
 * Validates two things for every magicflux-nodes.humanReview node fed by an
 * upstream magicflux-nodes.aiClassifier:
 *   (1) its output ports never feed a conditional node re-checking the
 *       classifier's original field, unless outputField overwrites that
 *       exact field on resume;
 *   (2) when its allowedOutcomes are exactly the classifier's allowedLabels
 *       (a genuine classification review, not an unrelated approve/reject
 *       decision), outputField MUST be configured to match the classifier's
 *       outputField, so the human's choice becomes the canonical value any
 *       downstream reader (Airtable mapping, message template) sees.
 * A graph with no humanReview node, or one with no upstream aiClassifier at
 * all, always passes.
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
    // review node, to learn the exact field name and labels it produces.
    // No classifier upstream -> nothing to protect here.
    let classifierOutputField: string | null = null;
    let classifierLabels: string[] = [];
    const seen = new Set<string>();
    const stack = [...(predecessors.get(review.name) ?? [])];
    while (stack.length > 0 && !classifierOutputField) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const curNode = byName.get(cur);
      if (curNode && curNode.type.toLowerCase() === AI_CLASSIFIER_NODE_TYPE.toLowerCase()) {
        const curParams = asRecord(curNode.parameters);
        const rawOutputField = curParams.outputField;
        classifierOutputField = typeof rawOutputField === 'string' && rawOutputField.trim() ? rawOutputField.trim() : 'classification';
        classifierLabels = stringArray(curParams.allowedLabels);
        break;
      }
      stack.push(...(predecessors.get(cur) ?? []));
    }

    if (!classifierOutputField) continue;

    const reviewParams = asRecord(review.parameters);
    const reviewOutputFieldRaw = reviewParams.outputField;
    const reviewOutputField = typeof reviewOutputFieldRaw === 'string' ? reviewOutputFieldRaw.trim() : '';
    const reviewOutcomes = stringArray(reviewParams.allowedOutcomes);

    // Check 2 (Phase 9.9.4C): a genuine classification review -- this
    // review's own outcomes are exactly the classifier's labels -- must
    // configure outputField so the human's choice becomes canonical,
    // regardless of which routing topology (direct-port or rejoined) is used.
    if (sameSet(reviewOutcomes, classifierLabels) && reviewOutputField !== classifierOutputField) {
      return {
        ok: false,
        node: review.name,
        reason:
          `Human Review node "${review.name}" reviews the same labels (${classifierLabels.join('/')}) the upstream ` +
          `AI Classifier produces in "${classifierOutputField}", but does not configure "outputField": ` +
          `"${classifierOutputField}". Without it, downstream data (e.g. an Airtable mapping, a message template) ` +
          `would keep showing the AI's original, possibly-overridden value instead of the human's decision. Set ` +
          `"outputField": "${classifierOutputField}" on the Human Review node so its resume makes the human's ` +
          'choice canonical.',
      };
    }

    if (reviewOutputField === classifierOutputField) continue; // outputField already covers both checks.

    // Check 1 (Phase 9.9.3.2): stale re-evaluation via a downstream
    // conditional node re-checking the classifier's original field.
    const directTargets = flattenTargets(connRecord[review.name]?.main);
    for (const targetName of directTargets) {
      const targetNode = byName.get(targetName);
      if (!targetNode) continue;
      if (isConditionalNodeType(targetNode.type) && referencesJsonField(targetNode.parameters, classifierOutputField)) {
        return {
          ok: false,
          node: review.name,
          reason:
            `Human Review node "${review.name}" routes into "${targetName}", which re-checks the AI classifier's ` +
            `original "${classifierOutputField}" field. Human Review never overwrites that field by default, so a ` +
            `human decision that disagrees with the AI's original classification would reach the correct outcome ` +
            `port but then fail "${targetName}"'s own condition and produce zero downstream actions. Either wire ` +
            `Human Review's outcome ports DIRECTLY to each outcome's terminal action nodes (preferred), or set ` +
            `"outputField": "${classifierOutputField}" on the Human Review node so its resume deterministically ` +
            'overwrites that field with the human\'s chosen outcome before rejoining this chain.',
        };
      }
    }
  }

  return { ok: true };
}
