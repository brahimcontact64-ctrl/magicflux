import type { MockNodeHandler } from '../plan-types';

function evaluate(
  field: string,
  operation: string,
  value: string,
  context: Record<string, unknown>,
): boolean {
  // If field looks like a template expression, resolve it from context variables.
  const resolved = field.startsWith('{{') ? String(context[field] ?? '') : field;

  switch (operation) {
    case 'equals':      return resolved === value;
    case 'notEquals':   return resolved !== value;
    case 'contains':    return resolved.includes(value);
    case 'notContains': return !resolved.includes(value);
    case 'greaterThan': return Number(resolved) > Number(value);
    case 'lessThan':    return Number(resolved) < Number(value);
    case 'isEmpty':     return resolved.trim() === '';
    case 'isNotEmpty':  return resolved.trim() !== '';
    default:            return false;
  }
}

export const conditionHandler: MockNodeHandler = async (node, context) => {
  const start = Date.now();
  const field     = String(node.parameters.field ?? '');
  const operation = String(node.parameters.operation ?? 'equals');
  const value     = String(node.parameters.value ?? '');

  if (!field) {
    return {
      nodeId:    node.id,
      nodeName:  node.name,
      status:    'error',
      output:    {},
      error:     'Missing required parameter: field / expression',
      durationMs: Date.now() - start,
    };
  }

  const result = evaluate(field, operation, value, context.variables);

  return {
    nodeId:         node.id,
    nodeName:       node.name,
    status:         'success',
    conditionResult: result,
    output: {
      result,
      branch:     result ? 0 : 1,
      branchName: result ? 'true' : 'false',
      evaluated: { field, operation, value, resolved: result },
    },
    durationMs: Date.now() - start,
  };
};
