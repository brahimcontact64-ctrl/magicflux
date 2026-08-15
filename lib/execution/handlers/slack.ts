import type { MockNodeHandler } from '../plan-types';

export const slackHandler: MockNodeHandler = async (node, _context) => {
  const start = Date.now();
  const { channel, message } = node.parameters;

  if (!channel || String(channel).trim() === '') {
    return {
      nodeId:    node.id,
      nodeName:  node.name,
      status:    'error',
      output:    {},
      error:     'Missing required parameter: channel',
      durationMs: Date.now() - start,
    };
  }

  return {
    nodeId:   node.id,
    nodeName: node.name,
    status:   'success',
    output: {
      ok:        true,
      channel:   String(channel),
      ts:        `${Date.now()}.000000`,
      message: {
        text:     message ?? '',
        username: node.parameters.username ?? 'MagicFlux Bot',
        type:     'message',
      },
    },
    durationMs: Date.now() - start,
  };
};
