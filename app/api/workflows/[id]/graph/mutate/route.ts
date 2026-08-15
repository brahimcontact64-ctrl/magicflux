import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { GraphMutationEngine } from '@/graph/mutation-engine';
import { assertWorkflowOwnership } from '@/lib/security/ownership';

type Ctx = { params: { id: string } };

export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    sessionId?: string;
    reason?: string;
    actor?: 'ai' | 'user' | 'system';
    action?:
      | { type: 'add_node'; node: { id: string; type: string; data?: Record<string, unknown> }; connectFrom?: string; connectTo?: string }
      | { type: 'remove_node'; nodeId: string }
      | { type: 'update_node'; nodeId: string; patch: Record<string, unknown> }
      | { type: 'add_edge'; edge: { id: string; source: string; target: string } }
      | { type: 'remove_edge'; edgeId: string }
      | { type: 'replace_provider'; from: string; to: string }
      | { type: 'insert_before'; targetNodeId: string; node: { id: string; type: string; data?: Record<string, unknown> } };
  };

  if (!body.action || !body.reason || !body.sessionId) {
    return NextResponse.json({ error: 'sessionId, reason, and action are required' }, { status: 400 });
  }

  try {
    await assertWorkflowOwnership(user.id, params.id);
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const mutationEngine = new GraphMutationEngine();
  const result = await mutationEngine.applyMutation({
    userId: user.id,
    workflowId: params.id,
    sessionId: body.sessionId,
    action: body.action,
    reason: body.reason,
    actor: body.actor,
  });

  return NextResponse.json({
    success: true,
    version: result.version,
    graph: result.graph,
    diff: result.diff,
  });
}
