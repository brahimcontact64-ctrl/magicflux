import type { MockNodeHandler } from '../plan-types';

export const emailHandler: MockNodeHandler = async (node, _context) => {
  const start = Date.now();
  const { to, subject } = node.parameters;

  if (!to || String(to).trim() === '') {
    return {
      nodeId:    node.id,
      nodeName:  node.name,
      status:    'error',
      output:    {},
      error:     'Missing required parameter: recipient (to)',
      durationMs: Date.now() - start,
    };
  }

  return {
    nodeId:   node.id,
    nodeName: node.name,
    status:   'success',
    output: {
      messageId: `mock-${crypto.randomUUID()}`,
      accepted:  [to],
      rejected:  [],
      subject:   subject ?? '(no subject)',
      timestamp: new Date().toISOString(),
    },
    durationMs: Date.now() - start,
  };
};
