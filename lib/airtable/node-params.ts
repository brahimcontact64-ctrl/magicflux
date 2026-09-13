/**
 * Phase 9.9.3 -- single source of truth for reading an Airtable node's
 * base/table identity out of its `parameters`, canonical-first with
 * backward-compatible aliases. Shared by the runtime handler
 * (lib/workflow-runtime/node-handlers/airtable.ts) and the pre-activation
 * schema gate (lib/workflow/lifecycle.ts) so "which parameter keys count"
 * can never drift between the two the way it did before this phase (the
 * handler never read 'application'/'applicationId' at all, silently
 * making that value dead weight).
 */

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function firstNonEmptyString(params: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const val = params[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return '';
}

/** Canonical key first; the rest are read-only backward-compat aliases for workflows generated before this phase. */
export const AIRTABLE_BASE_ID_KEYS = ['baseId', 'base', 'application', 'applicationId'];
export const AIRTABLE_TABLE_ID_KEYS = ['tableId', 'table', 'tableName'];

export type AirtableNodeConfig = {
  baseId: string;
  tableId: string;
  fieldKeys: string[];
};

export function extractAirtableNodeConfig(node: { parameters?: unknown }): AirtableNodeConfig {
  const params = asRecord(node.parameters);
  const baseId = firstNonEmptyString(params, AIRTABLE_BASE_ID_KEYS);
  const tableId = firstNonEmptyString(params, AIRTABLE_TABLE_ID_KEYS);
  const fields = asRecord(params.fields);
  return { baseId, tableId, fieldKeys: Object.keys(fields) };
}

export function isAirtableNodeType(type: unknown): boolean {
  return String(type ?? '').toLowerCase().includes('airtable');
}
