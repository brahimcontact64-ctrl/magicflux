import type { MockNodeHandler } from '../plan-types';

export const airtableHandler: MockNodeHandler = async (node, _context) => {
  const start = Date.now();
  const { baseId, tableId, operation } = node.parameters;

  if (!baseId || !tableId) {
    return {
      nodeId:    node.id,
      nodeName:  node.name,
      status:    'error',
      output:    {},
      error:     'Missing required parameters: baseId and tableId',
      durationMs: Date.now() - start,
    };
  }

  const op = String(operation ?? 'list');
  let output: Record<string, unknown>;

  if (op === 'create') {
    output = {
      id:        `rec${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`,
      fields:    node.parameters.fields ?? {},
      createdTime: new Date().toISOString(),
    };
  } else if (op === 'list') {
    output = {
      records: [
        { id: 'recMOCK001', fields: { Name: 'Sample Record', Status: 'Active' } },
        { id: 'recMOCK002', fields: { Name: 'Another Record', Status: 'Done' } },
      ],
      offset: null,
    };
  } else {
    output = { ok: true, operation: op };
  }

  return {
    nodeId:    node.id,
    nodeName:  node.name,
    status:    'success',
    output,
    durationMs: Date.now() - start,
  };
};
