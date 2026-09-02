import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { assertExecutionOwnership } from '@/lib/security/ownership';
import { redact } from '@/lib/security/redact';
import type { ExecutionDetail, ExecutionStep } from '@/lib/execution/types';

type Ctx = { params: { id: string } };

// Phase 9.4.3: this route had its own private redact()/REDACT_KEYS,
// substring-matched (`key.toLowerCase().includes(k)` -- exactly the
// over-redaction risk Phase 9.4.1 consolidated away elsewhere, e.g. a
// harmless field like "passenger_count" would have matched "pass") and
// with only a depth cap instead of real circular-reference detection.
// Replaced with the one shared, exact-match utility.

/**
 * GET /api/executions/[id]
 *
 * Returns the execution record plus all of its node steps (final state per node,
 * ordered by the node's first started_at — i.e., timeline order).
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Ownership assertion — throws if execution doesn't belong to user
  try {
    await assertExecutionOwnership(user.id, params.id);
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const db = createServiceClient();

  // ── 1. Fetch the execution header ───────────────────────────────────────────
  const { data: execRow, error: execErr } = await db
    .from('v_execution_summaries')
    .select(
      'id, workflow_id, workflow_name, status, mode, started_at, completed_at, ' +
      'duration_ms, step_count, failed_step_count, error_message, retry_count'
    )
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (execErr || !execRow) {
    return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
  }

  // Cast through unknown — Supabase TS client cannot infer the shape of ad-hoc views
  type SummaryRow = Record<string, unknown>;
  const exec = execRow as unknown as SummaryRow;

  // Fetch full input/output from the raw table (not in summary view)
  const { data: rawExec } = await db
    .from('workflow_executions_v2')
    .select('input_data, output_data')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  // ── 2. Fetch steps (final state per node, timeline order) ──────────────────
  // Use the v_execution_steps_final view: rn=1 gives the latest row per node.
  // Then order by min_started_at so nodes appear in execution order.
  const { data: stepRows, error: stepsErr } = await db
    .from('v_execution_steps_final')
    .select(
      'id, execution_id, workflow_id, node_id, node_name, node_type, ' +
      'status, attempt, input_data, output_data, logs, error_message, ' +
      'started_at, completed_at, duration_ms, min_started_at'
    )
    .eq('execution_id', params.id)
    .eq('user_id', user.id)
    .eq('rn', 1)
    .order('min_started_at', { ascending: true, nullsFirst: false });

  if (stepsErr) {
    return NextResponse.json({ error: 'Failed to load steps' }, { status: 500 });
  }

  type StepRow = Record<string, unknown>;
  const steps: ExecutionStep[] = ((stepRows ?? []) as unknown as StepRow[]).map(r => ({
    id:            String(r.id),
    execution_id:  String(r.execution_id),
    workflow_id:   String(r.workflow_id ?? ''),
    node_id:       String(r.node_id),
    node_name:     String(r.node_name ?? ''),
    node_type:     String(r.node_type ?? ''),
    status:        r.status as ExecutionStep['status'],
    attempt:       Number(r.attempt ?? 1),
    input_data:    redact(r.input_data) as Record<string, unknown> | null,
    output_data:   redact(r.output_data) as Record<string, unknown> | null,
    logs:          Array.isArray(r.logs) ? (r.logs as string[]) : [],
    error_message: (r.error_message as string) ?? null,
    started_at:    (r.started_at as string) ?? null,
    completed_at:  (r.completed_at as string) ?? null,
    duration_ms:   r.duration_ms != null ? Number(r.duration_ms) : null,
    min_started_at:(r.min_started_at as string) ?? null,
  }));

  const execution: ExecutionDetail = {
    id:                 String(exec.id),
    workflow_id:        String(exec.workflow_id ?? ''),
    workflow_name:      String(exec.workflow_name ?? 'Unknown'),
    status:             exec.status as ExecutionDetail['status'],
    mode:               (exec.mode ?? 'live') as ExecutionDetail['mode'],
    started_at:         (exec.started_at as string) ?? null,
    completed_at:       (exec.completed_at as string) ?? null,
    duration_ms:        exec.duration_ms != null ? Number(exec.duration_ms) : null,
    step_count:         Number(exec.step_count ?? 0),
    failed_step_count:  Number(exec.failed_step_count ?? 0),
    error_message:      (exec.error_message as string) ?? null,
    retry_count:        Number(exec.retry_count ?? 0),
    input_data:         redact(rawExec?.input_data) as Record<string, unknown> | null,
    output_data:        redact(rawExec?.output_data) as Record<string, unknown> | null,
    steps,
  };

  return NextResponse.json({ execution });
}
