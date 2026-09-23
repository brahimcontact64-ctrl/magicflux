/**
 * Phase 9.9.21 -- Part 3: derives a workflow's expected webhook-trigger
 * payload fields from its ACTUAL workflow_json, so the Connection Guide
 * never hardcodes Workflow #1's fields (name/email/budget/urgency/
 * purchase_intent) globally -- another workflow with a different shape
 * gets documentation for its own fields instead.
 *
 * The webhook_trigger block itself (lib/blocks/index.ts) carries no payload
 * schema at all -- it only configures httpMethod/path. What a workflow
 * actually "expects" is entirely implicit in which `$json["field"]`
 * references its downstream nodes make, plus which fields an AI Classifier
 * node was told to look at (params.inputFields). This is a best-effort,
 * UI/documentation-only heuristic scan, deliberately independent from (and
 * safe to diverge slightly from) the runtime's own strict resolution
 * grammar in lib/workflow-runtime/node-handlers/json-field-reference.ts --
 * a false positive/negative here only affects what a setup guide shows a
 * human, never what the runtime actually executes.
 */

export type TriggerField = {
  name: string;
  /** false when the field is only ever referenced inside a `{{?field}}...{{/field}}` optional block, or only named by an AI Classifier's inputFields (informational, not a hard runtime dependency). */
  required: boolean;
  /** Where this field name was discovered -- for debugging/tests, not shown verbatim in the UI. */
  source: 'template' | 'optional-block' | 'classifier';
};

const STRICT_JSON_FIELD = /\$json(?:\[["']([^"']+)["']\]|\.([a-zA-Z0-9_]+))/g;
const OPTIONAL_BLOCK_FIELD = /\{\{\?([a-zA-Z0-9_]+)\}\}/g;
// Matches an entire `{{?field}}...{{/field}}` span (markers AND inner
// content) so any `$json[...]` reference living INSIDE an optional block
// is never also counted as required -- a field guarded by {{?field}} is
// required nowhere just because its own guarded reference mentions it.
const OPTIONAL_BLOCK_SPAN = /\{\{\?([a-zA-Z0-9_]+)\}\}[\s\S]*?\{\{\/\1\}\}/g;

/** Every string leaf inside an arbitrary JSON-ish value (a node's `parameters` object, typically). */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
}

/**
 * Derives the set of top-level input fields a workflow's webhook trigger is
 * expected to receive, split into required vs optional, from the workflow's
 * OWN JSON -- never a global/hardcoded field list.
 */
export function deriveTriggerFields(workflowJson: unknown): TriggerField[] {
  const wf = (workflowJson ?? {}) as { nodes?: unknown };
  const nodes = Array.isArray(wf.nodes) ? (wf.nodes as Array<Record<string, unknown>>) : [];

  const optionalNames = new Set<string>();
  const requiredNames = new Set<string>();
  const classifierNames = new Set<string>();

  for (const node of nodes) {
    const type = String(node.type ?? '').toLowerCase();
    const params = (node.parameters ?? {}) as Record<string, unknown>;

    // AI Classifier declares the fields it reads explicitly, even when a
    // downstream template never re-references them by name.
    if (type.includes('aiclassifier') && Array.isArray(params.inputFields)) {
      for (const f of params.inputFields) {
        const name = String(f ?? '').trim();
        if (name) classifierNames.add(name);
      }
    }

    const strings: string[] = [];
    collectStrings(params, strings);

    for (const raw of strings) {
      for (const m of raw.matchAll(OPTIONAL_BLOCK_FIELD)) {
        optionalNames.add(m[1]);
      }
      // Strip optional-block spans (markers + inner content) before the
      // required scan, so a $json[...] reference used only to fill in an
      // optional block's own inner text is never miscounted as required.
      const withoutOptionalBlocks = raw.replace(OPTIONAL_BLOCK_SPAN, '');
      for (const m of withoutOptionalBlocks.matchAll(STRICT_JSON_FIELD)) {
        const name = m[1] ?? m[2];
        if (name) requiredNames.add(name);
      }
    }
  }

  // A field referenced both strictly (outside any optional block) AND
  // inside an optional block elsewhere is genuinely required somewhere in
  // the workflow -- required wins over optional/classifier-only.
  const fields = new Map<string, TriggerField>();
  for (const name of classifierNames) fields.set(name, { name, required: false, source: 'classifier' });
  for (const name of optionalNames) fields.set(name, { name, required: false, source: 'optional-block' });
  for (const name of requiredNames) fields.set(name, { name, required: true, source: 'template' });

  return [...fields.values()].sort((a, b) => (a.required === b.required ? a.name.localeCompare(b.name) : a.required ? -1 : 1));
}

const EXAMPLE_VALUES: Record<string, unknown> = {
  name: 'Jane Doe',
  email: 'jane@example.com',
  phone: '+1-555-0100',
  budget: 50000,
  urgency: 'high',
  purchase_intent: 'ready to buy',
  message: 'Interested in your product',
  company: 'Acme Inc',
};

function exampleValueFor(fieldName: string): unknown {
  const key = fieldName.toLowerCase();
  if (key in EXAMPLE_VALUES) return EXAMPLE_VALUES[key];
  if (key.includes('email')) return 'jane@example.com';
  if (key.includes('phone')) return '+1-555-0100';
  if (key.includes('name')) return 'Jane Doe';
  if (key.includes('budget') || key.includes('amount') || key.includes('price')) return 50000;
  if (key.includes('date') || key.includes('time')) return new Date().toISOString();
  return 'example value';
}

/** A realistic sample payload for the "example request" shown in the Connection Guide -- built from the workflow's OWN derived fields, never a generic placeholder like `{"example":"value"}`. */
export function buildSamplePayload(fields: TriggerField[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    payload[field.name] = exampleValueFor(field.name);
  }
  return payload;
}
