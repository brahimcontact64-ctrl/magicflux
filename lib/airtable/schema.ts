/**
 * Phase 9.9.3 — Airtable schema-aware configuration.
 *
 * Server-side only. Uses Airtable's real Metadata API
 * (https://api.airtable.com/v0/meta/...) with the user's own stored
 * Personal Access Token to discover real bases/tables/fields, and to
 * validate a proposed base/table/field mapping before it is ever trusted
 * as a workflow's Airtable configuration. The generator has no way to
 * know a founder's real Airtable schema -- this module is the single
 * place that ever asks Airtable what's actually there, so nothing
 * downstream (the Builder's configuration step, the pre-activation gate)
 * has to guess or re-implement schema discovery.
 */

import 'server-only';
import { redactText } from '@/lib/security/redact';

const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';

export type AirtableBase = { id: string; name: string; permissionLevel?: string };
export type AirtableFieldSchema = { id: string; name: string; type: string };
export type AirtableTableSchema = { id: string; name: string; fields: AirtableFieldSchema[] };

/**
 * Airtable field types the API rejects writes to -- computed/system
 * fields. Mapping a workflow value onto one of these is never valid,
 * regardless of what the value itself looks like (this is what "validate
 * required field types where possible" means here: we cannot type-check a
 * runtime expression like ={{$json["x"]}} against a target type without
 * evaluating it, but we CAN deterministically know a field is read-only).
 */
const READONLY_AIRTABLE_FIELD_TYPES = new Set([
  'formula',
  'rollup',
  'count',
  'autoNumber',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'button',
  'multipleLookupValues',
]);

export function isWritableAirtableFieldType(type: string): boolean {
  return !READONLY_AIRTABLE_FIELD_TYPES.has(type);
}

async function airtableApiFetch(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${AIRTABLE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Airtable API request failed (${res.status}): ${redactText(text.slice(0, 200))}`);
  }
  return res.json();
}

/** Lists every base this token's connection can access. */
export async function listAirtableBases(token: string): Promise<AirtableBase[]> {
  const data = await airtableApiFetch(token, '/meta/bases') as {
    bases?: Array<{ id: string; name: string; permissionLevel?: string }>;
  };
  return (data.bases ?? []).map((b) => ({ id: b.id, name: b.name, permissionLevel: b.permissionLevel }));
}

/** Lists every table (with its real fields) in a given base. */
export async function listAirtableTables(token: string, baseId: string): Promise<AirtableTableSchema[]> {
  const data = await airtableApiFetch(token, `/meta/bases/${encodeURIComponent(baseId)}/tables`) as {
    tables?: Array<{ id: string; name: string; fields?: Array<{ id: string; name: string; type: string }> }>;
  };
  return (data.tables ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    fields: (t.fields ?? []).map((f) => ({ id: f.id, name: f.name, type: f.type })),
  }));
}

/** Returns the real field schema for one table, or null if the table doesn't exist in this base. */
export async function getAirtableTableFields(
  token: string,
  baseId: string,
  tableIdOrName: string
): Promise<AirtableFieldSchema[] | null> {
  const tables = await listAirtableTables(token, baseId);
  const table = tables.find((t) => t.id === tableIdOrName || t.name === tableIdOrName);
  return table ? table.fields : null;
}

export type AirtableMappingValidation =
  | { ok: true; table: AirtableTableSchema }
  | { ok: false; reason: string; unknownFields?: string[]; readonlyFields?: string[] };

/**
 * Verifies, against Airtable's real live schema, that a base/table exist
 * and that every field key a workflow wants to write to is a real,
 * writable field on that table. Never coerces or guesses -- an unknown
 * field or a read-only field type is always rejected outright.
 */
export async function validateAirtableMapping(
  token: string,
  baseId: string,
  tableIdOrName: string,
  fieldKeys: string[]
): Promise<AirtableMappingValidation> {
  if (!baseId.trim()) return { ok: false, reason: 'No Airtable base is configured for this step yet.' };
  if (!tableIdOrName.trim()) return { ok: false, reason: 'No Airtable table is configured for this step yet.' };

  let tables: AirtableTableSchema[];
  try {
    tables = await listAirtableTables(token, baseId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Could not verify Airtable base "${baseId}": ${message}` };
  }

  const table = tables.find((t) => t.id === tableIdOrName || t.name === tableIdOrName);
  if (!table) {
    return { ok: false, reason: `Table "${tableIdOrName}" was not found in Airtable base "${baseId}".` };
  }

  const byName = new Map(table.fields.map((f) => [f.name, f]));
  const byId = new Map(table.fields.map((f) => [f.id, f]));

  const unknownFields: string[] = [];
  const readonlyFields: string[] = [];
  for (const key of fieldKeys) {
    const field = byName.get(key) ?? byId.get(key);
    if (!field) {
      unknownFields.push(key);
      continue;
    }
    if (!isWritableAirtableFieldType(field.type)) {
      readonlyFields.push(key);
    }
  }

  if (unknownFields.length > 0) {
    return { ok: false, reason: `Unknown Airtable field(s): ${unknownFields.join(', ')}.`, unknownFields };
  }
  if (readonlyFields.length > 0) {
    return { ok: false, reason: `Field(s) are read-only/computed in Airtable and cannot be written to: ${readonlyFields.join(', ')}.`, readonlyFields };
  }

  return { ok: true, table };
}
