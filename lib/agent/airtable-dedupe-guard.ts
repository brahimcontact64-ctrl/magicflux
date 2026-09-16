/**
 * Phase 9.9.11A -- Part 9: Airtable business-dedupe product-truth guard.
 *
 * Mirrors the established pattern (template-expression-guard.ts,
 * notification-content-guard.ts, qualification-policy-guard.ts): rejects
 * generation/activation of any Airtable node whose "dedupe" parameter
 * claims the unimplemented "append" behavior (log this submission as a
 * linked interaction under an existing contact) -- this handler has no
 * reliable way to discover a base's own link-field schema, so it cannot
 * safely honor that request. Silently falling back to plain "create"
 * (the Phase 9.9.11 draft's original behavior) would misrepresent which
 * business behavior is actually configured -- exactly the kind of false
 * capability claim this platform's other guards already refuse to allow.
 *
 * A node with no "dedupe" parameter, or one requesting only "create"/
 * "update", always passes.
 */

export type AirtableDedupeGuardValidation = { ok: true } | { ok: false; reason: string; node: string };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const AIRTABLE_TYPES = new Set(['n8n-nodes-base.airtable', 'n8n-nodes-base.airtabletrigger']);

export function validateAirtableDedupeClaim(nodes: unknown[]): AirtableDedupeGuardValidation {
  for (const raw of Array.isArray(nodes) ? nodes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    if (!AIRTABLE_TYPES.has(String(node.type ?? '').toLowerCase())) continue;

    const dedupe = asRecord(node.parameters).dedupe;
    if (!dedupe || typeof dedupe !== 'object') continue;

    if ((dedupe as Record<string, unknown>).onMatch === 'append') {
      const name = String(node.name ?? node.id ?? '').trim();
      return {
        ok: false,
        node: name,
        reason:
          `Node "${name}" declares dedupe.onMatch:"append", which is not yet implemented -- there is no reliable way to discover this Airtable base's own link-field schema to safely create a correctly-linked interaction record. ` +
          'Use "update" (overwrite the matched record) or "create" (always insert a new record), or omit "dedupe" entirely. This workflow cannot be saved with an unimplemented behavior silently substituted for a different one.',
      };
    }
  }

  return { ok: true };
}
