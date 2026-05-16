import { createServiceClient } from '@/lib/supabase-server';

export async function recordWorkflowFeedback(params: {
  userId: string | null;
  sessionId?: string;
  workflowId?: string;
  prompt: string;
  generatedWorkflow?: Record<string, unknown>;
  generatedPattern?: string;
  successRate?: number;
  runtimePerformance?: Record<string, unknown>;
  userEdits?: Record<string, unknown>;
  feedbackNotes?: string;
}): Promise<void> {
  const db = createServiceClient();

  const payload = {
    user_id: params.userId,
    session_id: params.sessionId ?? null,
    workflow_id: params.workflowId ?? null,
    prompt: params.prompt,
    generated_workflow: params.generatedWorkflow ?? {},
    generated_pattern: params.generatedPattern ?? null,
    success_rate: typeof params.successRate === 'number' ? params.successRate : null,
    runtime_performance: params.runtimePerformance ?? {},
    user_edits: params.userEdits ?? {},
    feedback_notes: params.feedbackNotes ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await db.from('workflow_feedback').insert(payload);
  if (error) {
    throw new Error(error.message);
  }
}
