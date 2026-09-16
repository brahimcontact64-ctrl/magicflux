/**
 * Phase 9.9.10 -- qualification policy product-truth guard.
 *
 * Mirrors the established pattern (template-expression-guard.ts,
 * notification-content-guard.ts): if a generated magicflux-nodes.aiClassifier
 * node's "qualificationPolicy" parameter is present but structurally
 * invalid, aiClassifierHandler's parseQualificationPolicy() would silently
 * fall back to "no policy" at runtime -- exactly matching Phase 9.9.9 Part
 * G's product-truth principle: a generation that CLAIMS a business
 * qualification policy must fail validation rather than silently persist a
 * policy that will never actually apply. A node with no "qualificationPolicy"
 * at all always passes -- this never forces the parameter onto a workflow
 * that doesn't want one.
 */

import { parseQualificationPolicy } from '@/lib/workflow-runtime/node-handlers/qualification-policy';
import { AI_CLASSIFIER_NODE_TYPE } from '@/lib/workflow-runtime/node-capabilities';

export type QualificationPolicyValidation = { ok: true } | { ok: false; reason: string; node: string };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function validateQualificationPolicyShape(nodes: unknown[]): QualificationPolicyValidation {
  for (const raw of Array.isArray(nodes) ? nodes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    if (String(node.type ?? '').toLowerCase() !== AI_CLASSIFIER_NODE_TYPE.toLowerCase()) continue;

    const params = asRecord(node.parameters);
    if (!('qualificationPolicy' in params) || params.qualificationPolicy === null || params.qualificationPolicy === undefined) continue;

    const parsed = parseQualificationPolicy(params.qualificationPolicy);
    if (parsed) continue;

    const name = String(node.name ?? node.id ?? '').trim();
    return {
      ok: false,
      node: name,
      reason:
        `Node "${name}" declares a "qualificationPolicy" but it is structurally invalid (wrong version, no fields, or every field name falls outside its own "allowedInputFields"/is an internal or credential-shaped name) -- ` +
        'it would silently be ignored at runtime rather than actually governing classification. Fix or remove it before this workflow can be saved.',
    };
  }

  return { ok: true };
}
