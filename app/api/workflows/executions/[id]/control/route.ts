import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { ExecutionManager } from '@/runtime/execution-manager';
import { assertExecutionOwnership } from '@/lib/security/ownership';

type Ctx = { params: { id: string } };

type ControlAction = 'pause' | 'cancel' | 'resume' | 'rewind';

export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: ControlAction;
    reason?: string;
    snapshotVersion?: number;
  };

  const action = body.action;
  if (!action || !['pause', 'cancel', 'resume', 'rewind'].includes(action)) {
    return NextResponse.json({ error: 'action must be pause, cancel, resume, or rewind' }, { status: 400 });
  }

  try {
    await assertExecutionOwnership(user.id, params.id);
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const executionManager = new ExecutionManager();

  if (action === 'pause') {
    await executionManager.requestPause(params.id, user.id, body.reason);
    return NextResponse.json({ success: true, action: 'pause' });
  }

  if (action === 'cancel') {
    await executionManager.requestCancel(params.id, user.id, body.reason);
    return NextResponse.json({ success: true, action: 'cancel' });
  }

  const execution = await executionManager.getExecution(params.id, user.id);
  if (!execution) {
    return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
  }

  const db = createServiceClient();

  // If this execution was started against a frozen deployment_versions
  // snapshot, resume/rewind with THAT exact snapshot — not whatever
  // workflow_json is live now (see resume/route.ts for the same fix).
  let workflowJsonForResume: unknown = null;
  if (execution.deployment_version_id) {
    const { data: version } = await db
      .from('deployment_versions')
      .select('workflow_data')
      .eq('id', execution.deployment_version_id)
      .maybeSingle();
    workflowJsonForResume = version?.workflow_data ?? null;
  }
  if (!workflowJsonForResume) {
    const { data: workflow } = await db
      .from('workflows')
      .select('workflow_json')
      .eq('id', execution.workflow_id)
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();
    workflowJsonForResume = workflow?.workflow_json ?? null;
  }

  if (!workflowJsonForResume) {
    return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
  }

  if (action === 'rewind') {
    if (!Number.isFinite(body.snapshotVersion)) {
      return NextResponse.json({ error: 'snapshotVersion is required for rewind' }, { status: 400 });
    }

    const rewound = await executionManager.rewindExecution({
      executionId: execution.id,
      userId: user.id,
      workflowId: execution.workflow_id,
      workflowJson: workflowJsonForResume,
      mode: execution.mode,
      toSnapshotVersion: Number(body.snapshotVersion),
      reason: body.reason,
    });

    return NextResponse.json({ success: true, action: 'rewind', execution: rewound });
  }

  const resumed = await executionManager.resumeExecution({
    executionId: execution.id,
    userId: user.id,
    workflowId: execution.workflow_id,
    workflowJson: workflowJsonForResume,
    mode: execution.mode,
    inputData: execution.input_data,
    retryCount: execution.retry_count,
    maxRetries: execution.max_retries,
  });

  return NextResponse.json({ success: true, action: 'resume', execution: resumed });
}
