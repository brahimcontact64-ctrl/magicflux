import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function getParam(node: EngineNode, keys: string[]): string {
  const params = node.parameters ?? {};
  for (const key of keys) {
    const val = params[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return '';
}

function parseWaitUntil(node: EngineNode): Date | null {
  const params = asRecord(node.parameters);

  // date-based wait
  const dateStr = getParam(node, ['waitUntil', 'resumeAt', 'date', 'dateTime']);
  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d;
  }

  // duration-based wait (seconds)
  const durationSec = Number(params.amount ?? params.duration ?? params.seconds ?? 0);
  if (durationSec > 0) {
    return new Date(Date.now() + durationSec * 1000);
  }

  return null;
}

export async function waitHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];

  if (context.mode === 'test') {
    logs.push('Wait node skipped in test mode — execution continues immediately.');
    return { status: 'simulated_success', outputData: inputData, logs };
  }

  const waitUntil = parseWaitUntil(node);

  if (!waitUntil) {
    logs.push('Wait node: no wait time specified — continuing.');
    return { status: 'success', outputData: inputData, logs };
  }

  const now = new Date();
  if (waitUntil <= now) {
    logs.push(`Wait node: scheduled time ${waitUntil.toISOString()} already passed — continuing.`);
    return { status: 'success', outputData: inputData, logs };
  }

  logs.push(`Wait node: pausing execution until ${waitUntil.toISOString()}.`);
  return {
    status: 'waiting',
    outputData: inputData,
    logs,
    nextRunAt: waitUntil,
  };
}
