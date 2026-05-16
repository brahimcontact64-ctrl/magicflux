import { NextRequest, NextResponse } from 'next/server';

import { recordWorkflowFeedback } from '@/lib/automation';
import { getUserFromRequest } from '@/lib/supabase-server';

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    sessionId?: string;
    workflowId?: string;
    prompt?: string;
    generatedWorkflow?: Record<string, unknown>;
    generatedPattern?: string;
    successRate?: number;
    runtimePerformance?: Record<string, unknown>;
    userEdits?: Record<string, unknown>;
    feedbackNotes?: string;
  };

  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }

  try {
    await recordWorkflowFeedback({
      userId: user.id,
      sessionId: body.sessionId,
      workflowId: body.workflowId,
      prompt,
      generatedWorkflow: body.generatedWorkflow,
      generatedPattern: body.generatedPattern,
      successRate: body.successRate,
      runtimePerformance: body.runtimePerformance,
      userEdits: body.userEdits,
      feedbackNotes: body.feedbackNotes,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save workflow feedback';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
