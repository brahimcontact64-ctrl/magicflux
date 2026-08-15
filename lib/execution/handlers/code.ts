import type { MockNodeHandler } from '../plan-types';

export const codeHandler: MockNodeHandler = async (node, _context) => {
  const start = Date.now();
  const { code, language } = node.parameters;

  if (!code || String(code).trim() === '') {
    return {
      nodeId:    node.id,
      nodeName:  node.name,
      status:    'error',
      output:    {},
      error:     'Missing required parameter: code',
      durationMs: Date.now() - start,
    };
  }

  return {
    nodeId:   node.id,
    nodeName: node.name,
    status:   'success',
    output: {
      language: language ?? 'javaScript',
      result:   [{ json: { processed: true, mock: true } }],
      simulated: true,
      message:  `Code node executed in mock mode (${String(language ?? 'javaScript')})`,
    },
    durationMs: Date.now() - start,
  };
};
