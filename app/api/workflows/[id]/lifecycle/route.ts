import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import {
  activateWorkflow,
  pauseWorkflow,
  resumeWorkflow,
  deactivateWorkflow,
  archiveWorkflow,
} from '@/lib/workflow/lifecycle';

type Ctx = { params: { id: string } };

const ACTIONS = ['activate', 'pause', 'resume', 'deactivate', 'archive'] as const;
type Action = (typeof ACTIONS)[number];

/**
 * POST /api/workflows/[id]/lifecycle
 * Body: { action: 'activate' | 'pause' | 'resume' | 'deactivate' | 'archive' }
 *
 * Thin ownership-checked wrapper around lib/workflow/lifecycle.ts. Every
 * lifecycle function there already scopes its update by .eq('user_id', ...),
 * so a cross-tenant request affects zero rows and is reported as 404 here
 * rather than silently succeeding against nothing.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = body?.action as Action | undefined;
  if (!action || !ACTIONS.includes(action)) {
    return NextResponse.json({ error: `Invalid action. Must be one of: ${ACTIONS.join(', ')}` }, { status: 400 });
  }

  if (action === 'activate') {
    const result = await activateWorkflow(user.id, params.id);
    if (!result.success) {
      const status = result.errors.includes('Workflow not found') ? 404 : 422;
      return NextResponse.json({ success: false, status: result.status, errors: result.errors }, { status });
    }
    return NextResponse.json({ success: true, status: result.status, version: result.version, deploymentVersionId: result.deploymentVersionId });
  }

  const handlers: Record<Exclude<Action, 'activate'>, (userId: string, workflowId: string) => Promise<{ success: boolean; error?: string }>> = {
    pause: pauseWorkflow,
    resume: resumeWorkflow,
    deactivate: deactivateWorkflow,
    archive: archiveWorkflow,
  };

  const result = await handlers[action as Exclude<Action, 'activate'>](user.id, params.id);
  if (!result.success) {
    const status = result.error === 'Workflow not found' ? 404 : 422;
    return NextResponse.json({ success: false, error: result.error }, { status });
  }

  return NextResponse.json({ success: true });
}
