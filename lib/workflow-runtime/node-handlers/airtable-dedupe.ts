/**
 * Phase 9.9.11 -- Part F: Airtable business (CRM) deduplication.
 *
 * Deliberately separate from transport/technical idempotency
 * (lib/runtime/idempotency.ts, provider-outcome.ts): those exist to stop
 * the SAME webhook delivery/retry from producing a second row. This module
 * answers a different question -- does a real, DIFFERENT submission
 * describe a lead/contact the business ALREADY has a record for? A
 * customer legitimately submitting again on a separate real occasion must
 * remain possible; this only matches on an explicit, business-configured
 * identity, never technical delivery metadata.
 *
 * Optional and additive: a node with no "dedupe" parameter configured
 * behaves exactly as before (always creates) -- existing, already-
 * certified workflows never silently gain this behavior (Part K).
 *
 * Phase 9.9.11A -- Part 9 product-truth correction: "append" (log this
 * submission as a linked interaction/event under the existing contact,
 * rather than updating its own fields) is NOT implemented -- this handler
 * has no reliable way to discover a base's own link-field schema, so it
 * cannot safely create a correctly-linked child record. The Phase 9.9.11
 * draft silently fell back to plain "create" whenever "append" was
 * configured, which is exactly the false capability claim this platform
 * elsewhere refuses to allow (see lib/agent/notification-content-guard.ts
 * and qualification-policy-guard.ts's own "fail validation, never silently
 * degrade" precedent). "append" is now an explicitly REJECTED value, never
 * a valid AirtableDedupeOnMatch at all -- see
 * lib/agent/airtable-dedupe-guard.ts for the matching generation/
 * activation-time guard that refuses to persist/activate a node claiming
 * it, rather than only catching this here at runtime.
 */

export type AirtableDedupeOnMatch = 'create' | 'update';

export type AirtableDedupePolicy = {
  version: 1;
  /** Real Airtable column names (matching keys already present in the node's own "fields" mapping) that together identify "the same lead/contact". */
  identityFields: string[];
  onMatch: AirtableDedupeOnMatch;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Fails closed to `null` (exactly today's create-only behavior) on
 * anything absent or structurally invalid -- never a partial/guessed
 * policy. A policy explicitly requesting the unimplemented "append" value
 * is REJECTED (returns null) rather than silently treated as "create" --
 * see this module's doc comment.
 */
export function parseAirtableDedupePolicy(raw: unknown): AirtableDedupePolicy | null {
  const obj = asRecord(raw);
  if (obj.version !== 1) return null;
  if (obj.onMatch === 'append') return null;

  const identityFieldsRaw = Array.isArray(obj.identityFields) ? obj.identityFields : [];
  const identityFields = Array.from(new Set(identityFieldsRaw.map((f) => String(f).trim()).filter(Boolean)));
  if (identityFields.length === 0) return null;

  const onMatch = obj.onMatch === 'update' ? 'update' : 'create';

  return { version: 1, identityFields, onMatch };
}

/** Normalizes a value for identity comparison the same way for both the search formula and the compared record -- trims whitespace and lowercases, so "Jane@Example.com" and " jane@example.com " are recognized as the same identity. Numbers/booleans are stringified first. */
export function normalizeIdentityValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function escapeAirtableFormulaString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Builds an Airtable filterByFormula that matches an existing record whose
 * identity fields equal (case-insensitively, trimmed) the CURRENT record's
 * resolved values -- exact-match only, never a fuzzy/partial search. A
 * field whose current value is empty is excluded from the formula (an
 * empty identity value should never match every record that also happens
 * to have that field blank).
 */
export function buildIdentityFilterFormula(policy: AirtableDedupePolicy, record: Record<string, unknown>): string | null {
  const clauses = policy.identityFields
    .map((field) => ({ field, value: normalizeIdentityValue(record[field]) }))
    .filter((c) => c.value.length > 0)
    .map((c) => `LOWER({${c.field}}) = "${escapeAirtableFormulaString(c.value)}"`);

  if (clauses.length === 0) return null; // nothing to identify by on this submission -- caller must fall back to a plain create.
  return clauses.length === 1 ? clauses[0] : `AND(${clauses.join(', ')})`;
}
