import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

type Operator = 'equals' | 'notEquals' | 'contains' | 'greaterThan' | 'lessThan' | 'exists';

type ConditionRule = {
  field?: string;
  operator?: Operator;
  value?: unknown;
};

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    cur = asRecord(cur)[part];
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

export async function conditionHandler(
  node: EngineNode,
  inputData: unknown,
  _context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);
  const params = asRecord(node.parameters);

  // Pull condition rules from typical n8n IF node structure
  const conditions = (params.conditions ?? []) as ConditionRule[];

  if (!Array.isArray(conditions) || conditions.length === 0) {
    logs.push('Condition node: no conditions defined — passing through on true branch.');
    return {
      status: 'success',
      outputData: { ...data, _conditionResult: true },
      logs,
    };
  }

  const results = conditions.map((rule, idx) => {
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
