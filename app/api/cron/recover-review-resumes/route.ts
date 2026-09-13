import { NextRequest, NextResponse } from 'next/server';
import { recoverStuckReviewResumes } from '@/lib/runtime/review-resume';

/**
 * GET /api/cron/recover-review-resumes
 *
 * Phase 9.9.2A — background safety net for Human Review's crash window:
 * a decision can be durably persisted (pending -> resume_pending) and then
 * the process/network can fail before resumeExecution() is ever called or
 * completes. Most such cases self-heal the next time anyone (or this app)
 * hits POST /api/reviews/[id]/decide again on the same item -- but if
 * nobody ever does, this sweep finds it. Same Authorization: Bearer
 * <CRON_SECRET> pattern as every other cron route in this app (e.g.
 * /api/cron/dispatch-schedules), same optimistic-CAS claim pattern as
 * lib/runtime/retry-dispatcher.ts's dispatchDueRetries() -- safe to invoke
 * concurrently or overlapping with itself.
 *
 * Returns: { scanned, claimed, recovered, skipped, failed }
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

  const result = await recoverStuckReviewResumes();
  return NextResponse.json(result);
}
