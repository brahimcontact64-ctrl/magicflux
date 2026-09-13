/**
 * Phase 9.9.3 -- Airtable schema-aware configuration, generation-time guard.
 *
 * The generator has no way to know a founder's real Airtable base/table
 * schema, so it is instructed (see executor.ts's AIRTABLE CONFIGURATION
 * CONTRACT) to leave baseId/tableId empty and let a separate, real
 * schema-picker Builder step (backed by lib/airtable/schema.ts's live
 * Airtable Metadata API calls) fill them in later. This is the
 * deterministic backstop: rejects a freshly generated Airtable node whose
 * baseId/tableId is non-empty but does NOT match the shape of a real
 * Airtable id -- i.e. an invented value like "app123456" (the exact
 * production regression) rather than either a genuine empty
 * "needs configuration" state or an already-verified real id surviving a
 * workflow regeneration.
 *
 * This is deliberately NOT a live Airtable API call at generation time --
 * Airtable may not even be connected yet when a workflow is first drafted,
 * and generation must not depend on that. Live verification happens at
 * two later points instead: the Builder's own configuration-save endpoint
 * (app/api/workflows/[id]/airtable-config) and the pre-activation gate
 * (lib/workflow/lifecycle.ts).
 */

// Real Airtable ids: 'app' or 'tbl' followed by exactly 14 alphanumeric
// characters. Anything non-empty that doesn't match this shape is either
// invented garbage or a human-readable placeholder -- never a real id.
const REAL_AIRTABLE_BASE_ID = /^app[a-zA-Z0-9]{14}$/;
const REAL_AIRTABLE_TABLE_ID = /^tbl[a-zA-Z0-9]{14}$/;

export type AirtableConfigValidation =
  | { ok: true }
  | { ok: false; reason: string; node: string };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Rejects any Airtable node in a freshly generated graph whose baseId/
 * tableId is non-empty but not shaped like a real Airtable id. Empty
 * values (the expected "needs configuration" state) always pass.
 */
export function validateNoInventedAirtableIds(nodes: unknown[]): AirtableConfigValidation {
  for (const rawNode of Array.isArray(nodes) ? nodes : []) {
    if (!rawNode || typeof rawNode !== 'object') continue;
    const node = rawNode as Record<string, unknown>;
    const type = String(node.type ?? '').toLowerCase();
    if (!type.includes('airtable')) continue;

    const name = String(node.name ?? node.id ?? '');
    const params = asRecord(node.parameters);
    const baseId = String(params.baseId ?? '').trim();
    const tableId = String(params.tableId ?? '').trim();

    if (baseId && !REAL_AIRTABLE_BASE_ID.test(baseId)) {
      return {
        ok: false,
        node: name,
        reason: `Airtable node "${name}" has an invented base id ("${baseId}") -- generation must leave baseId empty until a real base is selected via the Builder's Airtable configuration step.`,
      };
    }
    if (tableId && !REAL_AIRTABLE_TABLE_ID.test(tableId)) {
      return {
        ok: false,
        node: name,
        reason: `Airtable node "${name}" has an invented table id ("${tableId}") -- generation must leave tableId empty until a real table is selected via the Builder's Airtable configuration step.`,
      };
    }
  }

  return { ok: true };
}
