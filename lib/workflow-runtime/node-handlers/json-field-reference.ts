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

// Phase 9.9.4A -- same narrow reference grammar as JSON_FIELD_REFERENCE
// above, but WITHOUT the leading '=' and start/end anchors, so it can match
// one or more occurrences EMBEDDED inside a larger string (e.g.
// "New Hot lead: {{$json[\"name\"]}}"). The leading '=' only ever marked
// "this whole parameter IS an expression" for the exact whole-value shape;
// inside an embedded template, the `{{ }}` delimiters alone already
// distinguish an expression from literal text.
const EMBEDDED_FIELD_REFERENCE = /\{\{\s*\$json(?:\[["']([^"']+)["']\]|\.([a-zA-Z0-9_]+))\s*\}\}/g;

// Detects ANY `{{ ... }}` occurrence, supported or not -- used only to
// reject unsupported syntax at generation/activation time (see
// hasUnsupportedTemplateSyntax below). Never used to decide runtime
// behavior: an unsupported occurrence is always left inert at runtime.
const ANY_MUSTACHE = /\{\{([\s\S]*?)\}\}/g;
const SUPPORTED_MUSTACHE_INNER = /^\s*\$json(?:\[["'][^"']+["']\]|\.[a-zA-Z0-9_]+)\s*$/;

export type TemplateResolution =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; field: string };

/**
 * The one shared, safe resolver for every handler that reads a
 * user-configured parameter that might reference execution data. Three
 * cases, checked in order:
 *
 *   1. The ENTIRE value is exactly `={{$json["field"]}}` / `={{$json.field}}`
 *      (the pre-existing narrow whole-value shape) -- resolves to the
 *      field's NATIVE type (number/boolean/object/etc.), never stringified.
 *   2. The value contains one or more `{{$json["field"]}}` occurrences
 *      EMBEDDED inside a larger string (no leading '=' per occurrence --
 *      that only marks a whole-value expression) -- every occurrence is
 *      replaced with its resolved value, stringified; any literal text
 *      around them is left untouched.
 *   3. Anything else -- a plain literal with no `{{` at all, or a `{{...}}`
 *      occurrence that is not this exact `$json[...]`/`$json.field` grammar
 *      -- is returned completely unchanged. This is deliberately narrow:
 *      no arithmetic, function calls, pipes, or general n8n/JS expression
 *      syntax is ever evaluated; unsupported syntax is simply inert text.
 *
 * A referenced field that is `undefined` in the current execution data is a
 * deterministic failure (`ok:false`) in both cases 1 and 2 -- callers must
 * fail the node rather than silently send a malformed record or a message
 * containing literal "undefined" text.
 */
export function resolveTemplateValue(raw: unknown, data: Record<string, unknown>): TemplateResolution {
  if (typeof raw !== 'string') return { ok: true, value: raw };

  const wholeValueMatch = raw.trim().match(JSON_FIELD_REFERENCE);
  if (wholeValueMatch) {
    const match = wholeValueMatch;
    const fieldName = (match[1] ?? match[2])!;
    const value = getNestedValue(data, fieldName);
    if (value === undefined) {
      return { ok: false, field: fieldName, reason: `Referenced field "${fieldName}" was not present in the execution data.` };
    }
    return { ok: true, value };
  }

  if (!raw.includes('{{')) return { ok: true, value: raw };

  let missingField: string | null = null;
  const interpolated = raw.replace(EMBEDDED_FIELD_REFERENCE, (full: string, bracketField?: string, dotField?: string) => {
    if (missingField) return full;
    const fieldName = (bracketField ?? dotField)!;
    const value = getNestedValue(data, fieldName);
    if (value === undefined) {
      missingField = fieldName;
      return full;
    }
    if (typeof value === 'string') return value;
    if (value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });

  if (missingField) {
    return { ok: false, field: missingField, reason: `Referenced field "${missingField}" was not present in the execution data.` };
  }

  return { ok: true, value: interpolated };
}

/** Resolves a template value to a plain string for a message-style parameter (subject/body/text) -- empty raw input resolves to an empty string, never a failure. */
export function resolveTemplateParamValue(raw: string, data: Record<string, unknown>): { ok: true; value: string } | { ok: false; reason: string } {
  if (!raw) return { ok: true, value: '' };
  const resolved = resolveTemplateValue(raw, data);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const v = resolved.value;
  if (v === undefined || v === null) return { ok: true, value: '' };
  return { ok: true, value: typeof v === 'string' ? v : String(v) };
}

// ─── Phase 9.9.9 -- Context-Aware Notification optional-field primitive ────
//
// Product problem this exists to fix: a lead-classification (or similar
// business-object) notification is only genuinely useful when it includes
// whatever real context fields the workflow's input actually carries --
// company, budget, desired start date, and so on. But those fields are
// OPTIONAL per individual execution (confirmed from real production
// payloads: one lead has budget_max but not budget_min, another has
// budget_min but not budget_max, another omits both) -- generation-time
// alone cannot know which fields a given future lead will or won't include,
// so the EXISTING strict resolver above (which fails the whole node closed
// on any missing reference -- exactly the right behavior for a REQUIRED
// field like an Airtable primary key) cannot be used for these fields
// without breaking notifications on every lead missing even one optional
// field. This is deliberately NOT a general conditional/expression engine:
// exactly one named-field presence test per block, no boolean composition,
// no nesting, no arithmetic -- and it is additive only. The existing
// `={{$json["field"]}}` / embedded `{{$json["field"]}}` grammar and its
// fail-closed missing-reference behavior are completely unchanged and are
// still what a REQUIRED field (e.g. a lead's name) should use.
//
// Syntax: `{{?field}}...{{/field}}` -- if $json["field"] resolves to a
// genuinely present, non-empty value, the block is replaced by its own
// inner content (itself then resolved normally, including any strict
// {{$json[...]}} references); if the field is missing/empty/null, the
// ENTIRE block is dropped. When the block occupies its own line (the
// intended authoring convention for an email body section), the whole
// line -- including its trailing newline -- disappears too, so a missing
// optional field never leaves an ugly blank section. When embedded inline
// (the intended convention for a concise Slack summary, where the
// separator belongs INSIDE the block, e.g. `{{?service}} | Service:
// {{$json["service"]}}{{/service}}`), only the block's own span is
// removed, never a surrounding separator that lives outside it.
const LINE_OPTIONAL_BLOCK = /^[ \t]*\{\{\?([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}[ \t]*\r?\n/gm;
const INLINE_OPTIONAL_BLOCK = /\{\{\?([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

function isPresentValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

/** Structurally strips well-formed optional blocks down to their inner content, regardless of field presence -- used both by the real resolver (with real presence checks) and by the generation-time guard (to detect any leftover, malformed `{{?`/`{{/` marker). */
function stripOptionalBlockMarkers(raw: string, resolve: (field: string) => boolean): string {
  const withLinesHandled = raw.replace(LINE_OPTIONAL_BLOCK, (_full, field: string, inner: string) =>
    resolve(field) ? `${inner}\n` : ''
  );
  return withLinesHandled.replace(INLINE_OPTIONAL_BLOCK, (_full, field: string, inner: string) =>
    resolve(field) ? inner : ''
  );
}

/** True when `raw` contains a `{{?field}}`/`{{/field}}` marker that is NOT part of a well-formed, correctly-paired optional block -- an unpaired open, an unpaired close, or a mismatched field name between open and close. */
export function hasMalformedOptionalBlockSyntax(raw: unknown): boolean {
  if (typeof raw !== 'string' || !(raw.includes('{{?') || raw.includes('{{/'))) return false;
  const stripped = stripOptionalBlockMarkers(raw, () => true);
  return /\{\{[?/]/.test(stripped);
}

/**
 * The notification-specific resolver: strips optional blocks (dropping
 * whichever ones reference a field missing from `data`), then resolves
 * whatever remains -- including any strict `{{$json[...]}}` references,
 * whether they were outside a block or inside one that survived -- through
 * the existing, UNCHANGED strict resolver. A required field referenced
 * outside any optional block still fails the node closed exactly as before;
 * only fields explicitly wrapped in `{{?field}}...{{/field}}` get the safe,
 * omit-if-missing treatment. Empty raw input resolves to an empty string,
 * never a failure -- same contract as resolveTemplateParamValue().
 */
export function resolveNotificationTemplate(raw: string, data: Record<string, unknown>): { ok: true; value: string } | { ok: false; reason: string } {
  if (!raw) return { ok: true, value: '' };
  if (!(raw.includes('{{?') || raw.includes('{{/'))) return resolveTemplateParamValue(raw, data);
  const withoutOptionalBlocks = stripOptionalBlockMarkers(raw, (field) => isPresentValue(getNestedValue(data, field)));
  return resolveTemplateParamValue(withoutOptionalBlocks, data);
}

/**
 * True when `raw` contains a `{{ ... }}` occurrence that is NOT the
 * supported `$json["field"]` / `$json.field` grammar -- used by the
 * generation/activation-time guard (lib/agent/template-expression-guard.ts)
 * to reject unsupported expression syntax before it is ever persisted or
 * activated. Never consulted at runtime: resolveTemplateValue() above
 * always leaves unsupported syntax safely inert instead.
 */
export function hasUnsupportedTemplateSyntax(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const matches = [...raw.matchAll(ANY_MUSTACHE)];
  return matches.some((m) => !SUPPORTED_MUSTACHE_INNER.test(m[1]));
}

/**
 * True when `value` (any JSON-serializable value -- a node's whole
 * "parameters" object, or just one "fields" map) contains a
 * `={{$json["<field>"]}}` / `{{$json["<field>"]}}` / `.field` reference to
 * exactly this field name, embedded or whole-value. Narrow and
 * deterministic (string-matches the exact grammar this module resolves),
 * shared by generation-time guards that need to know "does this node
 * already reference field X anywhere" without duplicating the regex.
 */
export function referencesJsonField(value: unknown, fieldName: string): boolean {
  if (!fieldName) return false;
  let text: string;
  try {
    text = JSON.stringify(value ?? {});
  } catch {
    return false;
  }
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\$json\\s*(?:\\[\\\\?["']${escaped}\\\\?["']\\]|\\.${escaped}\\b)`);
  return pattern.test(text);
}

/**
 * Phase 9.9.9 -- every field name a template string references, via EITHER
 * grammar this module supports: a `$json["field"]`/`$json.field` reference
 * (whole-value or embedded), or a `{{?field}}`/`{{/field}}` optional-block
 * marker. Used by generation-time content guards that need to know exactly
 * which business fields a notification actually surfaces -- e.g. to reject
 * one that references an internal/sensitive field name -- without
 * duplicating this module's grammar.
 */
export function extractReferencedFields(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const fields = new Set<string>();
  for (const m of raw.matchAll(/\$json(?:\[["']([^"']+)["']\]|\.([a-zA-Z0-9_]+))/g)) {
    const f = m[1] ?? m[2];
    if (f) fields.add(f);
  }
  for (const m of raw.matchAll(/\{\{[?/]([a-zA-Z0-9_]+)\}\}/g)) {
    fields.add(m[1]);
  }
  return [...fields];
}

/**
 * Resolves an object of destination-field -> template-value pairs (e.g. an
 * Airtable node's "fields" parameter) against the current execution data.
 * Strictly additive from the mapping alone -- the result contains ONLY the
 * keys named in `mapping`, nothing else is ever copied in from `data`, and
 * no metadata is ever injected. Fails closed on the FIRST unresolved
 * reference rather than building a partial/malformed record.
 */
export function resolveFieldMapping(
  mapping: Record<string, unknown>,
  data: Record<string, unknown>
): { ok: true; record: Record<string, unknown> } | { ok: false; reason: string; field: string } {
  const record: Record<string, unknown> = {};
  for (const [destField, rawValue] of Object.entries(mapping)) {
    const resolved = resolveTemplateValue(rawValue, data);
    if (!resolved.ok) {
      return { ok: false, field: destField, reason: `Field "${destField}": ${resolved.reason}` };
    }
    record[destField] = resolved.value;
  }
  return { ok: true, record };
}
