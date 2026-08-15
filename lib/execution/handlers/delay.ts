import type { MockNodeHandler } from '../plan-types';

const UNIT_MS: Record<string, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours:   3_600_000,
  days:    86_400_000,
};

export const delayHandler: MockNodeHandler = async (node, _context) => {
  const start = Date.now();
  const amount = Number(node.parameters.amount ?? 1);
  const unit   = String(node.parameters.unit ?? 'minutes');
  const ms     = (UNIT_MS[unit] ?? 60_000) * amount;

  return {
    nodeId:   node.id,
    nodeName: node.name,
    status:   'success',
    output: {
      waited:    amount,
      unit,
      totalMs:   ms,
      simulated: true,
      message:   `Mock delay: would wait ${amount} ${unit} (${ms} ms)`,
    },
    durationMs: Date.now() - start,
  };
};
