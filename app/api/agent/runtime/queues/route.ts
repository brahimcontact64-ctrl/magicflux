import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, getBearerToken, getUserFromAccessToken } from '@/lib/supabase-server';
import { classifyError } from '@/lib/security/safe-error';

async function getUserId(req: NextRequest): Promise<string | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const user = await getUserFromAccessToken(token);
  return user?.id ?? null;
}

export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = createServiceClient();
  const sessionId = req.nextUrl.searchParams.get('sessionId')?.trim() || undefined;

  let query = db
    .from('runtime_queue_jobs')
    .select('queue_name, task_type, status, attempts, max_attempts, delay_ms, correlation_id, job_id, workflow_id, queued_at, started_at, completed_at, error_message, result')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(500);

  if (sessionId) query = query.eq('session_id', sessionId);

  const { data, error } = await query;
  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  const rows = data ?? [];
  const byStatus = rows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row.status ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const avgWaitMs = (() => {
    const waits = rows
      .filter((r) => r.queued_at && r.started_at)
      .map((r) => {
        const queued = new Date(String(r.queued_at)).getTime();
        const started = new Date(String(r.started_at)).getTime();
        return Math.max(0, started - queued);
      });
    if (waits.length === 0) return 0;
    return Math.round(waits.reduce((sum, n) => sum + n, 0) / waits.length);
  })();

  return NextResponse.json({
    success: true,
    queues: rows,
    metrics: {
      total: rows.length,
      byStatus,
      avgWaitMs,
      failed: byStatus.failed ?? 0,
    },
  });
}
