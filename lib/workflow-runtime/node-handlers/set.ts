import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

/**
 * Set / Edit Fields handler — n8n-nodes-base.set.
 *
 * Deterministic, in-process field assignment — no external API call, no
 * credentials. Phase 9.1.6: previously fell through to the
 * UNSUPPORTED_NODE_TYPE fallback (lib/blocks' set_fields block always
 * emitted an empty fields.values, so this never surfaced in practice — but
 * a manually edited or future-generated workflow with real assignments
 * would have silently failed live activation).
 *
 * The current planner/generator is not deterministic about which real-world
 * n8n Set-node parameter shape it emits from one generation to the next --
 * three distinct shapes have each been observed live in production for the
 * exact same kind of "assign a field" step. Every one is supported:
 *   - flat: { fields: [{name, type?, value}] } -- fields itself is the array
 *   - typed buckets under "fields" (what n8n's own Set node v1/v2 actually
 *     calls "fields" in some versions, and what generation has produced for
 *     the real Founder workflow): { fields: { string: [...], number: [...],
 *     boolean: [...], dateTime: [...] } }
 *   - v3 "Edit Fields": { mode: 'manual', includeOtherFields, fields: { values: [{name, type?, value}] } }
 *   - legacy v1/v2 "Set": { keepOnlySet, values: { string: [...], number: [...], boolean: [...], dateTime: [...] } }
 *
 * Values are treated as LITERALS — no n8n expression syntax (`={{ ... }}`)
 * is evaluated. A value that looks like an unresolved expression is passed
 * through as-is with a warning log rather than silently misinterpreted as
 * a literal string, so the gap is visible instead of hidden.
 */

type FieldAssignment = { name?: unknown; key?: unknown; type?: unknown; value?: unknown };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function looksLikeUnresolvedExpression(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith('={{');
}

function coerceByDeclaredType(value: unknown, type: unknown): unknown {
  switch (String(type ?? '').toLowerCase()) {
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return value.toLowerCase() === 'true';
      return Boolean(value);
    case 'array':
      return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    case 'object':
      return typeof value === 'object' && value !== null ? value : {};
    default:
      return value;
  }
}

function applyV3Fields(
  base: Record<string, unknown>,
  fields: unknown,
  includeOtherFields: boolean,
  logs: string[]
): Record<string, unknown> {
  const values = Array.isArray(fields) ? (fields as unknown[]) : [];
  const assigned: Record<string, unknown> = includeOtherFields ? { ...base } : {};

  for (const [idx, entry] of values.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      logs.push(`Field assignment[${idx}]: not a valid {name, value} object — skipped.`);
      continue;
    }

    const field = entry as FieldAssignment;
    const name = String(field.name ?? field.key ?? '').trim();
    if (!name) {
      logs.push(`Field assignment[${idx}]: missing a field name — skipped.`);
      continue;
    }

    let value = field.value;
    if (looksLikeUnresolvedExpression(value)) {
      logs.push(`Field "${name}": expression syntax is not evaluated — using the literal text as-is.`);
    }
    value = coerceByDeclaredType(value, field.type);
    assigned[name] = value;
  }

  return assigned;
}

const TYPED_BUCKET_KEYS = ['string', 'number', 'boolean', 'dateTime'] as const;

/** True for an object keyed by one or more of the typed n8n buckets (string/number/boolean/dateTime), each an array. */
function hasTypedBuckets(value: Record<string, unknown>): boolean {
  return TYPED_BUCKET_KEYS.some((key) => Array.isArray(value[key]));
}

/** Applies a typed-bucket assignment object -- {string:[...], number:[...], boolean:[...], dateTime:[...]}. Used for both the legacy `values` container and the (equally real) `fields` container that carries this same shape. */
function applyTypedBucketFields(
  base: Record<string, unknown>,
  buckets: Record<string, unknown>,
  keepOnlySet: boolean,
  logs: string[]
): Record<string, unknown> {
  const assigned: Record<string, unknown> = keepOnlySet ? {} : { ...base };
  const coercers: Array<[(typeof TYPED_BUCKET_KEYS)[number], (v: unknown) => unknown]> = [
    ['string', (v) => v],
    ['number', (v) => coerceByDeclaredType(v, 'number')],
    ['boolean', (v) => coerceByDeclaredType(v, 'boolean')],
    // Dates are treated as literals, consistent with this handler's
    // no-expression-evaluation policy -- no date parsing/formatting is
    // invented here.
    ['dateTime', (v) => v],
  ];

  for (const [bucketKey, coerce] of coercers) {
    const bucket = buckets[bucketKey];
    if (!Array.isArray(bucket)) continue;
    for (const [idx, entry] of bucket.entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        logs.push(`Field assignment[${bucketKey}][${idx}]: not a valid {name, value} object — skipped.`);
        continue;
      }
      const field = entry as FieldAssignment;
      const name = String(field.name ?? field.key ?? '').trim();
      if (!name) {
        logs.push(`Field assignment[${bucketKey}][${idx}]: missing a field name — skipped.`);
        continue;
      }
      let value = field.value;
      if (looksLikeUnresolvedExpression(value)) {
        logs.push(`Field "${name}": expression syntax is not evaluated — using the literal text as-is.`);
      }
      assigned[name] = coerce(value);
    }
  }

  return assigned;
}

export async function setHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const params = asRecord(node.parameters);
  const base = asRecord(inputData);

  let result: Record<string, unknown>;
  const includeOtherFields = params.includeOtherFields !== false; // default true
  const keepOnlySet = params.keepOnlySet === true;

  if (Array.isArray(params.fields)) {
    // Phase 9.8.3 -- flat shape: parameters.fields = [{name, value, type?}]
    // directly, rather than wrapped in {values: [...]}.
    result = applyV3Fields(base, params.fields, includeOtherFields, logs);
  } else if (params.fields && typeof params.fields === 'object') {
    const fieldsObj = params.fields as Record<string, unknown>;
    if (Array.isArray(fieldsObj.values)) {
      // v3 "Edit Fields" shape: fields = { values: [...] }.
      result = applyV3Fields(base, fieldsObj.values, includeOtherFields, logs);
    } else if (hasTypedBuckets(fieldsObj)) {
      // Phase 9.8.3 -- the shape the exact Founder workflow actually uses in
      // production: fields = { string: [...], number: [...], boolean: [...] }
      // -- structurally identical to the legacy `values` container, just
      // nested under the key "fields" instead. Previously fell into the
      // branch below expecting fields.values (undefined for this shape) and
      // silently applied nothing -- the node ran and reported success, but
      // never wrote its field.
      result = applyTypedBucketFields(base, fieldsObj, keepOnlySet, logs);
    } else {
      logs.push('Set node: "fields" object has neither values[...] nor a recognized typed bucket — passing data through unchanged.');
      result = { ...base };
    }
  } else if (params.mode !== undefined) {
    logs.push('Set node: no field assignments configured — passing data through unchanged.');
    result = { ...base };
  } else if (params.values !== undefined && typeof params.values === 'object' && !Array.isArray(params.values)) {
    // legacy v1/v2 "Set" shape: values = { string: [...], number: [...], boolean: [...] }.
    result = applyTypedBucketFields(base, params.values as Record<string, unknown>, keepOnlySet, logs);
  } else {
    logs.push('Set node: no field assignments configured — passing data through unchanged.');
    result = { ...base };
  }

  if (context.mode === 'test') {
    logs.push('Set node: field assignment applied (test mode).');
    return { status: 'simulated_success', outputData: result, logs };
  }

  logs.push('Set node: field assignment applied.');
  return { status: 'success', outputData: result, logs };
}
