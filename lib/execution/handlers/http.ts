import type { MockNodeHandler } from '../plan-types';

export const httpHandler: MockNodeHandler = async (node, _context) => {
  const start = Date.now();
  const { url, method } = node.parameters;

  if (!url || String(url).trim() === '') {
    return {
      nodeId:    node.id,
      nodeName:  node.name,
      status:    'error',
      output:    {},
      error:     'Missing required parameter: url',
      durationMs: Date.now() - start,
    };
  }

  // Parse headers / body defensively — they may be JSON strings or objects.
  let parsedHeaders: Record<string, unknown> = {};
  let parsedBody: unknown = null;
  try {
    const h = node.parameters.headers;
    if (typeof h === 'string' && h.trim()) parsedHeaders = JSON.parse(h) as Record<string, unknown>;
    else if (typeof h === 'object' && h !== null) parsedHeaders = h as Record<string, unknown>;
  } catch { /* ignore malformed headers */ }

  try {
    const b = node.parameters.body;
    if (typeof b === 'string' && b.trim()) parsedBody = JSON.parse(b);
    else if (typeof b === 'object') parsedBody = b;
  } catch { /* ignore malformed body */ }

  return {
    nodeId:   node.id,
    nodeName: node.name,
    status:   'success',
    output: {
      statusCode: 200,
      statusText: 'OK',
      url:        String(url),
      method:     String(method ?? 'GET'),
      requestHeaders: parsedHeaders,
      requestBody:    parsedBody,
      body: { mock: true, message: 'Mock HTTP response', url: String(url) },
      headers: { 'content-type': 'application/json' },
    },
    durationMs: Date.now() - start,
  };
};
