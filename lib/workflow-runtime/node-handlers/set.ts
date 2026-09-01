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
 * Supports both shapes actually seen in the wild:
 *   - v3 "Edit Fields": { mode: 'manual', includeOtherFields, fields: { values: [{name, type?, value}] } }
 *   - legacy v1/v2 "Set": { keepOnlySet, values: { string: [...], number: [...], boolean: [...] } }
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
  const values = Array.isArray(fields) ? (fields as FieldAssignment[]) : [];
  const assigned: Record<string, unknown> = includeOtherFields ? { ...base } : {};

  for (const field of values) {
    const name = String(field.name ?? field.key ?? '').trim();
    if (!name) continue;

    let value = field.value;
    if (looksLikeUnresolvedExpression(value)) {
      logs.push(`Field "${name}": expression syntax is not evaluated — using the literal text as-is.`);
    }
    value = coerceByDeclaredType(value, field.type);
    assigned[name] = value;
  }

  return assigned;
}

function applyLegacyFields(
  base: Record<string, unknown>,
  values: Record<string, unknown>,
  keepOnlySet: boolean,
  logs: string[]
): Record<string, unknown> {
  const assigned: Record<string, unknown> = keepOnlySet ? {} : { ...base };
  const buckets: Array<[keyof typeof values, (v: unknown) => unknown]> = [
    ['string', (v) => v],
    ['number', (v) => coerceByDeclaredType(v, 'number')],
    ['boolean', (v) => coerceByDeclaredType(v, 'boolean')],
  ];

  for (const [bucketKey, coerce] of buckets) {
    const bucket = values[bucketKey];
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket as FieldAssignment[]) {
      const name = String(entry.name ?? entry.key ?? '').trim();
      if (!name) continue;
      let value = entry.value;
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

  if (params.fields !== undefined || params.mode !== undefined) {
    // v3 "Edit Fields" shape.
    const includeOtherFields = params.includeOtherFields !== false; // default true
    const fieldsContainer = asRecord(params.fields);
    result = applyV3Fields(base, fieldsContainer.values, includeOtherFields, logs);
  } else if (params.values !== undefined) {
    // legacy v1/v2 "Set" shape.
    const keepOnlySet = params.keepOnlySet === true;
    result = applyLegacyFields(base, asRecord(params.values), keepOnlySet, logs);
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
