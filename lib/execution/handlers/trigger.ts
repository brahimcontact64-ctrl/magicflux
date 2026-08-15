import type { MockNodeHandler } from '../plan-types';

export const triggerHandler: MockNodeHandler = async (node, _context) => {
  const start = Date.now();
  return {
    nodeId:    node.id,
    nodeName:  node.name,
    status:    'success',
    output: {
      triggerType: node.type.toLowerCase().includes('webhook') ? 'webhook' : 'schedule',
      body:        { message: 'Trigger fired (mock)' },
      headers:     { 'content-type': 'application/json' },
      query:       {},
      timestamp:   new Date().toISOString(),
    },
    durationMs: Date.now() - start,
  };
};
