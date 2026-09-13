/**
 * Phase 9.8.2 (condition.ts) / 9.8.7 (extracted, shared with email.ts) --
 * deliberately narrow, not a general n8n expression evaluator. The
 * runtime's own documented policy (see set.ts's header comment) is that
 * `={{ ... }}` expressions are never interpreted generally. This module
 * recognizes exactly one well-defined, extremely common shape: a direct
 * top-level reference to the incoming trigger data, e.g.
 * `={{$json["orderAmount"]}}` or `={{$json.orderAmount}}`. Anything else
 * (nested paths, function calls, arithmetic, string concatenation) is left
 * unresolved on purpose -- resolveFieldReference() returns the original
 * string unchanged, which will simply fail to match/read as expected
 * rather than silently guessing at a more complex expression's meaning.
 *
 * Extracted into its own module so every node handler that needs this one
 * narrow capability (condition.ts, email.ts, ...) shares a single
 * implementation instead of each maintaining its own copy that could drift.
 */

export function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

// The AI generator is not deterministic about field-name casing convention
// (e.g. it may write `orderAmount` in one generation and `order_amount` in
// another for the identical semantic field named by the user's own prompt
// words). A trigger has no fixed input schema -- the incoming payload's key
// casing is whatever the real caller sends -- so an exact-key lookup alone
// would make resolution depend on a casing coincidence between the
// generated parameter and the caller's payload. This normalizes to a
// canonical form (lowercase, alphanumeric only) ONLY as a fallback after an
// exact match fails. It never merges genuinely different field names --
// "orderAmount" and "order_amount" normalize to the same string because
// they ARE the same identifier, just formatted differently; "orderAmount"
// and "totalAmount" do not collide.
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findCaseInsensitiveKey(obj: Record<string, unknown>, field: string): string | undefined {
  const target = normalizeKey(field);
  return Object.keys(obj).find((k) => normalizeKey(k) === target);
}

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    const rec = asRecord(cur);
    if (part in rec) {
      cur = rec[part];
    } else {
      const matchedKey = findCaseInsensitiveKey(rec, part);
      cur = matchedKey !== undefined ? rec[matchedKey] : undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

const JSON_FIELD_REFERENCE = /^=\{\{\s*\$json(?:\[["']([^"']+)["']\]|\.([a-zA-Z0-9_]+))\s*\}\}$/;

/** True only for a string matching exactly the narrow `={{$json["field"]}}` / `={{$json.field}}` shape -- never a general expression. */
export function isJsonFieldReference(value: unknown): value is string {
  return typeof value === 'string' && JSON_FIELD_REFERENCE.test(value.trim());
}

/** Resolves the narrow `={{$json["field"]}}` / `={{$json.field}}` shape against `data`. Any other value (including a more complex expression) is returned unchanged. */
export function resolveFieldReference(value: unknown, data: Record<string, unknown>): unknown {
  if (typeof value !== 'string') return value;
  const match = value.trim().match(JSON_FIELD_REFERENCE);
  if (!match) return value;
  const fieldName = match[1] ?? match[2];
  return getNestedValue(data, fieldName);
}
