import { NextRequest, NextResponse } from 'next/server';
import { dispatchDueRetries } from '@/lib/runtime/retry-dispatcher';

/**
 * GET /api/cron/dispatch-retries
 *
 * Phase 8.8. Scheduled every minute (see vercel.json), matching
 * /api/cron/dispatch-schedules's cadence. Fires every due, claimable
 * workflow_executions_v2 row in status='waiting' — the previously-missing
 * consumer for the execution-level retry/Wait-node scheduling that
 * runtime/workflow-engine.ts already writes (next_run_at, retry_count).
 *
 * Same CRON_SECRET bearer-auth pattern as every other cron route. No
 * business logic here — dispatchDueRetries() owns claiming, concurrency
 * reservation, and enqueueing; this route only authenticates and reports
 * the aggregate counts (never raw execution data — no user/workflow IDs,
 * no error messages, no input/output data).
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: 'CRON_SECRET environment variable is not configured' },
      { status: 500 }
    );
  }

  const authHeader = req.headers.get('authorization') ?? '';
  const providedSecret = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  if (!providedSecret || providedSecret !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await dispatchDueRetries();
  return NextResponse.json({ success: true, result });
}
