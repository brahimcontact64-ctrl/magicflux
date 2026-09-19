import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { publishNewVersion, loadWorkflow } from '@/lib/workflow/lifecycle';
import { canDeployWorkflow } from '@/lib/billing/plan-limits';

type Ctx = { params: { id: string } };

/**
 * POST /api/workflows/[id]/publish
 * Body: { expectedUpdatedAt: string }
 *
 * Phase 9.9.17A -- Part G/H: the "Publish changes" action for a workflow
 * that is ALREADY active, distinct from POST .../lifecycle {action:
 * 'activate'} (which is for a workflow's FIRST activation and is allowed a
 * brief non-executable window that would be unacceptable here -- see
 * publishNewVersion()'s own doc comment in lib/workflow/lifecycle.ts).
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const expectedUpdatedAt = typeof body?.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : '';
  if (!expectedUpdatedAt) {
    return NextResponse.json({ error: 'expectedUpdatedAt is required -- pass back the value this page most recently loaded.' }, { status: 400 });
  }

  const owned = await loadWorkflow(user.id, params.id);
  if (!owned) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  const deployCheck = await canDeployWorkflow(user.id);
  if (!deployCheck.allowed) {
    return NextResponse.json({ error: 'PRO_REQUIRED', message: deployCheck.reason, redirect: '/pricing' }, { status: 403 });
  }

  const result = await publishNewVersion(user.id, params.id, expectedUpdatedAt);

  if (!result.success) {
    if (result.reason === 'not_executable') return NextResponse.json({ error: result.message }, { status: 422 });
    if (result.reason === 'validation_failed') return NextResponse.json({ error: 'Validation failed', errors: result.errors }, { status: 422 });
    if (result.reason === 'stale_draft') return NextResponse.json({ error: 'This workflow was changed elsewhere since you loaded it. Reload to see the latest version before publishing again.', latestUpdatedAt: result.latestUpdatedAt }, { status: 409 });
    return NextResponse.json({ error: result.message }, { status: 409 });
  }

  return NextResponse.json({
    success: true,
    alreadyUpToDate: result.alreadyUpToDate,
    version: result.version,
    deploymentVersionId: result.deploymentVersionId,
  });
}
