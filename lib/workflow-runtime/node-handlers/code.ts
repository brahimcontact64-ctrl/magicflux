import vm from 'node:vm';
import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

const DENIED_CODE_PATTERNS = [
  /require\s*\(/i,
  /import\s+/i,
  /process\./i,
  /globalThis/i,
  /window\./i,
  /document\./i,
  /child_process/i,
  /\bfs\b\s*\./i,
  /fetch\s*\(/i,
  /axios\./i,
  /eval\s*\(/i,
  /Function\s*\(/i,
  /XMLHttpRequest/i,
  /net\./i,
  /http\./i,
  /https\./i,
];

function isUnsafeCode(code: string): boolean {
  return DENIED_CODE_PATTERNS.some((p) => p.test(code));
}

function getParam(node: EngineNode, keys: string[]): string {
  const params = node.parameters ?? {};
  for (const key of keys) {
    const val = params[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return '';
}

export async function codeHandler(
  node: EngineNode,
  inputData: unknown,
  _context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const code = getParam(node, ['jsCode', 'code', 'functionCode']);

  if (!code) {
    logs.push('No code provided — input passed through.');
    return { status: 'success', outputData: inputData, logs };
  }

  if (isUnsafeCode(code) || code.length > 4000) {
    logs.push(
      isUnsafeCode(code)
        ? 'Unsafe code pattern detected — execution blocked for security.'
        : 'Code too long (>4000 chars) — execution blocked.'
    );
    return {
      status: 'failed',
      outputData: null,
      logs,
      error: 'Code execution blocked: unsafe or oversized code.',
    };
  }

  try {
    const sandbox = { input: inputData, output: inputData };
    const script = new vm.Script(
      `'use strict';\n(() => { ${code}\n; return typeof output === 'undefined' ? input : output; })()`
    );
    const result = script.runInNewContext(sandbox, { timeout: 2000 });
    logs.push('Code executed in sandbox successfully.');
    return { status: 'success', outputData: result, logs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(`Code execution failed: ${msg}`);
    return { status: 'failed', outputData: null, logs, error: msg };
  }
}
