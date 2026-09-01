import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import {
  activateWorkflow,
  loadWorkflow,
  pauseWorkflow,
  resumeWorkflow,
  deactivateWorkflow,
  archiveWorkflow,
} from '@/lib/workflow/lifecycle';
import { canDeployWorkflow } from '@/lib/billing/plan-limits';

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
    // Phase 9.1.5 — this route is now the single, canonical activation path
    // for every normal-user workflow (the old /api/workflows/deploy ->
    // external-n8n path is no longer the primary journey). Capability
    // ("can this workflow technically execute?") is checked separately by
    // activateWorkflow() itself; this is the entitlement gate ("does this
    // account's plan permit activation?").
    //
    // Ownership/existence is checked FIRST, before the entitlement check:
    // canDeployWorkflow() is a pure account-level check with no knowledge of
    // a specific workflow, so checking it before confirming the caller owns
    // this workflow would leak "you'd need Pro for this" (403) for a
    // workflow that isn't even theirs, instead of the existing IDOR-safe
    // "not found" (404) every other action here already preserves.
    const owned = await loadWorkflow(user.id, params.id);
    if (!owned) {
      return NextResponse.json({ success: false, status: 'error', errors: ['Workflow not found'] }, { status: 404 });
    }

    const deployCheck = await canDeployWorkflow(user.id);
    if (!deployCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'PRO_REQUIRED', message: deployCheck.reason, redirect: '/pricing' },
        { status: 403 }
      );
    }

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
