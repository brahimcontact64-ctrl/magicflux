import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { patchWorkflowNode, asConfigRecord } from '@/lib/workflow/node-config-save';
import { WAIT_FOR_ACKNOWLEDGMENT_NODE_TYPE, CREATE_ACKNOWLEDGMENT_CHALLENGE_NODE_TYPE } from '@/lib/workflow-runtime/node-capabilities';

type Ctx = { params: { id: string } };

// Phase 9.9.16 -- Part H: sanity bounds only, never a business rule. V1 SLA
// is elapsed wall-clock time, not business hours (the runtime handlers
// compute `deadline = Date.now() + slaMinutes * 60_000` unconditionally --
// see lib/workflow-runtime/node-handlers/wait-for-acknowledgment.ts). 1
// minute floor rejects an effectively-zero SLA that could never realistically
// be met; 7-day ceiling rejects a value that is almost certainly a unit
// mistake (e.g. minutes typed where hours were meant) rather than a real
// business ceiling -- a business that genuinely needs longer must still be
// able to say so explicitly; this only catches obvious accidents.
const MIN_SLA_MINUTES = 1;
const MAX_SLA_MINUTES = 7 * 24 * 60;

const SLA_NODE_TYPES = new Set([WAIT_FOR_ACKNOWLEDGMENT_NODE_TYPE.toLowerCase(), CREATE_ACKNOWLEDGMENT_CHALLENGE_NODE_TYPE.toLowerCase()]);

/**
 * PATCH /api/workflows/[id]/sla-config
 * Body: { nodeId, expectedUpdatedAt, slaMinutes?, escalationLevel? }
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const { nodeId, expectedUpdatedAt, slaMinutes, escalationLevel } = body as Record<string, unknown>;
  if (typeof nodeId !== 'string' || !nodeId.trim()) return NextResponse.json({ error: 'nodeId is required' }, { status: 400 });
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt.trim()) {
    return NextResponse.json({ error: 'expectedUpdatedAt is required -- pass back the value this editor most recently loaded.' }, { status: 400 });
  }

  if (slaMinutes !== undefined) {
    if (typeof slaMinutes !== 'number' || !Number.isFinite(slaMinutes) || slaMinutes < MIN_SLA_MINUTES || slaMinutes > MAX_SLA_MINUTES) {
      return NextResponse.json({ error: `slaMinutes must be a number between ${MIN_SLA_MINUTES} and ${MAX_SLA_MINUTES} (this business's own elapsed-time SLA -- V1 uses wall-clock elapsed time, not business hours).` }, { status: 400 });
    }
  }
  if (escalationLevel !== undefined) {
    if (typeof escalationLevel !== 'number' || !Number.isInteger(escalationLevel) || escalationLevel < 0) {
      return NextResponse.json({ error: 'escalationLevel must be a non-negative integer' }, { status: 400 });
    }
  }

  const result = await patchWorkflowNode({
    userId: user.id,
    workflowId: params.id,
    nodeId,
    expectedUpdatedAt,
    mutate: (node) => {
      if (!SLA_NODE_TYPES.has(String(node.type ?? '').toLowerCase())) {
        return { ok: false, error: `Node "${nodeId}" is not an SLA/acknowledgment node.` };
      }
      const existingParams = asConfigRecord(node.parameters);
      const nextParams: Record<string, unknown> = { ...existingParams };
      if (slaMinutes !== undefined) nextParams.slaMinutes = slaMinutes;
      if (escalationLevel !== undefined) nextParams.escalationLevel = escalationLevel;
      return { ok: true, node: { ...node, parameters: nextParams } };
    },
  });

  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.status === 409 ? { latestUpdatedAt: result.latestUpdatedAt } : {}) }, { status: result.status });
  return NextResponse.json({ ok: true, node: result.node, updatedAt: result.updatedAt });
}
