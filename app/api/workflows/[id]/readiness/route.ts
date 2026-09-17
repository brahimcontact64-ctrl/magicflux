import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase-server';
import { loadWorkflow } from '@/lib/workflow/lifecycle';
import { checkWorkflowReadiness } from '@/lib/workflow/readiness';

type Ctx = { params: { id: string } };

/**
 * GET /api/workflows/[id]/readiness
 * Phase 9.9.16 -- Part M. Read-only; never mutates workflow status.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const workflow = await loadWorkflow(user.id, params.id);
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  const summary = await checkWorkflowReadiness(user.id, workflow.workflow_json);
  return NextResponse.json(summary);
}
