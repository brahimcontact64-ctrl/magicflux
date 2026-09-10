import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

type Operator = 'equals' | 'notEquals' | 'contains' | 'greaterThan' | 'lessThan' | 'exists';

type ConditionRule = {
  field?: string;
  operator?: Operator;
  value?: unknown;
};

/**
 * Phase 9.8.2 -- n8n-native IF-node condition rule, as actually generated
 * by lib/agent/executor.ts's generateWorkflowJson() (which explicitly
 * instructs the model to "use real n8n node types"). Distinct shape from
 * the legacy ConditionRule above: keyed by type bucket (number/string/
 * boolean/dateTime), each entry is {value1, operation, value2} rather than
 * {field, operator, value}.
 */
type N8nConditionRule = { value1?: unknown; value2?: unknown; operation?: string };
type N8nConditionsShape = {
  number?: N8nConditionRule[];
  string?: N8nConditionRule[];
  boolean?: N8nConditionRule[];
  dateTime?: N8nConditionRule[];
};

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

// Phase 9.8.2 -- the AI generator is not deterministic about field-name
// casing convention (e.g. it may write `orderAmount` in one generation and
// `order_amount` in another for the identical semantic field named by the
// user's own prompt words). A webhook trigger has no fixed input schema --
// the incoming payload's key casing is whatever the real caller sends --
// so an exact-key lookup alone would make branching depend on a casing
// coincidence between the generated condition and the caller's payload.
// This normalizes to a canonical form (lowercase, alphanumeric only) ONLY
// as a fallback after an exact match fails. It never merges genuinely
// different field names -- "orderAmount" and "order_amount" normalize to
// the same string because they ARE the same identifier, just formatted
// differently; "orderAmount" and "totalAmount" do not collide.
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findCaseInsensitiveKey(obj: Record<string, unknown>, field: string): string | undefined {
  const target = normalizeKey(field);
  return Object.keys(obj).find((k) => normalizeKey(k) === target);
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
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

function evaluateCondition(rule: ConditionRule, data: Record<string, unknown>): boolean {
  const { field = '', operator = 'exists', value } = rule;
  const actual = getNestedValue(data, field);

  switch (operator) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'equals':
      return String(actual) === String(value);
    case 'notEquals':
      return String(actual) !== String(value);
    case 'contains':
      return typeof actual === 'string' && actual.includes(String(value));
    case 'greaterThan':
      return Number(actual) > Number(value);
    case 'lessThan':
      return Number(actual) < Number(value);
    default:
      return false;
  }
}

// Phase 9.8.2 -- deliberately narrow, not a general n8n expression
// evaluator (the runtime's own documented policy -- see set.ts's header
// comment -- is that `={{ ... }}` expressions are never interpreted).
// This recognizes exactly one well-defined, extremely common shape: a
// direct top-level reference to the incoming data, e.g.
// `={{$json["orderAmount"]}}` or `={{$json.orderAmount}}`. Anything else
// (nested paths, function calls, arithmetic, string concatenation) is left
// unresolved on purpose -- resolveFieldReference() returns the original
// string, which will simply fail to match value2 as expected rather than
// silently guessing at a more complex expression's meaning.
const JSON_FIELD_REFERENCE = /^=\{\{\s*\$json(?:\[["']([^"']+)["']\]|\.([a-zA-Z0-9_]+))\s*\}\}$/;

function resolveFieldReference(value: unknown, data: Record<string, unknown>): unknown {
  if (typeof value !== 'string') return value;
  const match = value.trim().match(JSON_FIELD_REFERENCE);
  if (!match) return value;
  const fieldName = match[1] ?? match[2];
  return getNestedValue(data, fieldName);
}

function isN8nConditionsShape(value: unknown): value is N8nConditionsShape {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return ['number', 'string', 'boolean', 'dateTime'].some((key) => Array.isArray(v[key]));
}

function evaluateN8nRule(rule: N8nConditionRule, data: Record<string, unknown>, logs: string[], typeBucket: string): boolean {
  const left = resolveFieldReference(rule.value1, data);
  const right = resolveFieldReference(rule.value2, data);
  const operation = String(rule.operation ?? 'equal');

  let result: boolean;
  switch (operation) {
    case 'larger':
    case 'greaterThan':
      result = Number(left) > Number(right);
      break;
    case 'largerEqual':
      result = Number(left) >= Number(right);
      break;
    case 'smaller':
    case 'lessThan':
      result = Number(left) < Number(right);
      break;
    case 'smallerEqual':
      result = Number(left) <= Number(right);
      break;
    case 'notEqual':
      result = String(left) !== String(right);
      break;
    case 'contains':
      result = typeof left === 'string' && left.includes(String(right));
      break;
    case 'notContains':
      result = typeof left === 'string' && !left.includes(String(right));
      break;
    case 'startsWith':
      result = typeof left === 'string' && left.startsWith(String(right));
      break;
    case 'endsWith':
      result = typeof left === 'string' && left.endsWith(String(right));
      break;
    case 'isEmpty':
      result = left === undefined || left === null || left === '';
      break;
    case 'isNotEmpty':
      result = !(left === undefined || left === null || left === '');
      break;
    case 'equal':
    default:
      result = String(left) === String(right);
      break;
  }

  logs.push(`Condition[${typeBucket}]: ${JSON.stringify(rule.value1)} ${operation} ${JSON.stringify(rule.value2)} (resolved: ${JSON.stringify(left)} vs ${JSON.stringify(right)}) → ${result ? 'TRUE' : 'FALSE'}`);
  return result;
}

export async function conditionHandler(
  node: EngineNode,
  inputData: unknown,
  _context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);
  const params = asRecord(node.parameters);
  const conditions = params.conditions;

  // Phase 9.8.2 -- n8n-native shape, exactly what generateWorkflowJson()
  // actually produces for a real n8n-nodes-base.if node. Checked first
  // since this is now the expected/common case.
  if (isN8nConditionsShape(conditions)) {
    const combinator = String(params.combinator ?? params.combineOperation ?? 'and').toLowerCase();
    const allRules = (['number', 'string', 'boolean', 'dateTime'] as const).flatMap((bucket) =>
      (conditions[bucket] ?? []).map((rule) => ({ rule, bucket }))
    );

    if (allRules.length === 0) {
      logs.push('Condition node: n8n conditions object present but empty — passing through on true branch.');
      return { status: 'success', outputData: { ...data, _conditionResult: true }, logs };
    }

    const results = allRules.map(({ rule, bucket }) => evaluateN8nRule(rule, data, logs, bucket));
    const passed = combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
    logs.push(`Overall condition result (${combinator.toUpperCase()}): ${passed ? 'TRUE (branch 0)' : 'FALSE (branch 1)'}`);

    return {
      status: 'success',
      outputData: { ...data, _conditionResult: passed, _conditionBranch: passed ? 0 : 1 },
      logs,
    };
  }

  // Legacy custom shape: a flat array of {field, operator, value}.
  if (Array.isArray(conditions) && conditions.length > 0) {
    const rules = conditions as ConditionRule[];
    const results = rules.map((rule, idx) => {
      const result = evaluateCondition(rule, data);
      logs.push(
        `Condition[${idx}]: ${rule.field ?? '?'} ${rule.operator ?? 'exists'} ${String(rule.value ?? '')} → ${result ? 'TRUE' : 'FALSE'}`
      );
      return result;
    });

    const allPass = results.every(Boolean);
    logs.push(`Overall condition result: ${allPass ? 'TRUE (branch 0)' : 'FALSE (branch 1)'}`);

    return {
      status: 'success',
      outputData: { ...data, _conditionResult: allPass, _conditionBranch: allPass ? 0 : 1 },
      logs,
    };
  }

  logs.push('Condition node: no conditions defined — passing through on true branch.');
  return {
    status: 'success',
    outputData: { ...data, _conditionResult: true },
    logs,
  };
}
