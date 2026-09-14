/**
 * Phase 9.9.4D -- Airtable semantic field-preservation guard.
 *
 * Root cause this exists to prevent: an Airtable "create"/"update" node's
 * "fields" mapping was left entirely to the LLM's own free-form judgment,
 * anchored by an ILLUSTRATIVE EXAMPLE in the generation prompt (Phase
 * 9.9.4/9.9.4C's "e.g. Name, Email, Classification"/"...Confidence").
 * Regenerating the identical request produced a DIFFERENT field set each
 * time -- adding "Confidence" (Phase 9.9.4C) silently dropped "Email"
 * (Phase 9.9.4D), because nothing ever verified the result against a fixed
 * contract; the model was simply re-improvising a list from prose every
 * time.
 *
 * This guard replaces prompt-example anchoring with a deterministic,
 * code-enforced completeness check derived from two EXPLICIT, STRUCTURED
 * sources -- never free-form example text:
 *
 *   1. `recordIdentityFields` -- the generate_workflow_json tool's own new
 *      "record_identity_fields" argument (lib/agent/tools.ts): the
 *      identity/contact fields of the entity this automation processes
 *      (e.g. ["name","email"] for a lead-intake workflow). Populated once,
 *      per request, as a narrow, separate decision from "what should this
 *      Airtable action save" -- then enforced by code on every Airtable
 *      node, not re-derived by the model each time.
 *   2. Whatever fields an upstream magicflux-nodes.aiClassifier node itself
 *      guarantees (its own "outputField", plus "confidence" -- always
 *      present in aiClassifierHandler's output, see
 *      lib/workflow-runtime/node-handlers/ai-classifier.ts) -- traced
 *      backward exactly like lib/agent/human-review-routing-guard.ts does,
 *      so this can never drift from that guard's own notion of "the
 *      classifier's outputs".
 *
 * A workflow with no Airtable node, no upstream classifier, and no
 * recordIdentityFields is completely unaffected -- this guard only ever
 * requires fields that are BOTH explicitly declared/available AND actually
 * reachable by the node it's checking.
 */

import {
  AI_CLASSIFIER_NODE_TYPE,
} from '@/lib/workflow-runtime/node-capabilities';
import { referencesJsonField } from '@/lib/workflow-runtime/node-handlers/json-field-reference';

export type AirtablePersistenceValidation = { ok: true } | { ok: false; reason: string; node?: string };

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

function isAirtableWriteNode(type: string): boolean {
  const lc = type.toLowerCase();
  if (!lc.includes('airtable')) return false;
  return true;
}

/**
 * Validates that every real Airtable "create"/"update" node's "fields"
 * mapping VALUES cover:
 *   - every field named in `recordIdentityFields` (as-is, case-sensitive --
 *     these come from the same tool argument that names the trigger's own
 *     payload keys), and
 *   - when fed (directly or indirectly) by a magicflux-nodes.aiClassifier
 *     node, that classifier's own "outputField" and the literal
 *     "confidence" field it always produces.
 * Operation is read from the node's own "operation" parameter (default
 * "create", matching airtableHandler's own default) -- "list"/"get"/
 * "delete" nodes never write a record and are exempt.
 */
export function validateAirtablePersistenceCompleteness(
  nodes: unknown[],
  connections: unknown,
  recordIdentityFields: string[] = []
): AirtablePersistenceValidation {
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

  const identityFields = recordIdentityFields.map((f) => String(f).trim()).filter(Boolean);
  const airtableNodes = infos.filter((n) => isAirtableWriteNode(n.type));

  for (const node of airtableNodes) {
    const params = asRecord(node.parameters);
    const operation = String(params.operation ?? 'create').toLowerCase();
    if (operation !== 'create' && operation !== 'update') continue; // list/get/delete never write a record.

    // Trace backward for an upstream aiClassifier, exactly like
    // human-review-routing-guard.ts, so the two guards can never disagree
    // about what a classifier guarantees.
    let classifierOutputField: string | null = null;
    const seen = new Set<string>();
    const stack = [...(predecessors.get(node.name) ?? [])];
    while (stack.length > 0 && !classifierOutputField) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const curNode = byName.get(cur);
      if (curNode && curNode.type.toLowerCase() === AI_CLASSIFIER_NODE_TYPE.toLowerCase()) {
        const rawOutputField = asRecord(curNode.parameters).outputField;
        classifierOutputField = typeof rawOutputField === 'string' && rawOutputField.trim() ? rawOutputField.trim() : 'classification';
        break;
      }
      stack.push(...(predecessors.get(cur) ?? []));
    }

    const required = [...identityFields];
    if (classifierOutputField) {
      required.push(classifierOutputField, 'confidence');
    }
    if (required.length === 0) continue; // Nothing explicitly required for this workflow -- not this guard's concern.

    const fields = asRecord(params.fields);
    const missing = required.filter((field, idx) => required.indexOf(field) === idx && !referencesJsonField(fields, field));

    if (missing.length > 0) {
      return {
        ok: false,
        node: node.name,
        reason:
          `Airtable node "${node.name}" is missing a mapping for ${missing.map((f) => `"${f}"`).join(', ')} in its "fields" -- ` +
          `${identityFields.length > 0 ? 'this workflow\'s declared record fields and/or ' : ''}` +
          `the upstream AI Classifier's own output must all be persisted, not dropped when other fields are added or removed. ` +
          `Add a "={{$json[\"${missing[0]}\"]}}" mapping for each missing field.`,
      };
    }
  }

  return { ok: true };
}
