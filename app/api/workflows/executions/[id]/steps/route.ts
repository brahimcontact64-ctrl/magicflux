import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { assertExecutionOwnership } from '@/lib/security/ownership';
import { redact } from '@/lib/security/redact';
import { classifyError } from '@/lib/security/safe-error';

type Ctx = { params: { id: string } };

/**
 * GET /api/workflows/executions/[id]/steps
 * Returns all steps for a given execution (user must own the execution)
 *
 * Phase 9.4.1: this used to have its own local, ad-hoc redact() with a
 * substring-matched SECRET_KEYS list (`lower.includes('pass')` would
 * false-positive on a harmless field like "passenger_count") -- replaced
 * with the shared, exact-match lib/security/redact.ts utility so there is
 * one redaction policy, not two that could drift. Also read-time
 * defense-in-depth: runtime/runtime-state.ts now sanitizes before writing
 * workflow_execution_steps, but this route redacts on every read
 * regardless, so any historical row written before that fix (or by a
 * future code path that forgets to sanitize) is still never returned raw.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await assertExecutionOwnership(user.id, params.id);
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const db = createServiceClient();

  const { data: steps, error } = await db
    .from('workflow_execution_steps')
    .select('*')
    .eq('execution_id', params.id)
    .order('created_at', { ascending: true });

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  const safeSteps = (steps ?? []).map((step) => ({
    ...step,
    input_data: redact(step.input_data),
    output_data: redact(step.output_data),
    logs: redact(step.logs),
    error_message: step.error_message,
  }));

  return NextResponse.json({ steps: safeSteps });
}
