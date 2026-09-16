import { NextRequest, NextResponse } from 'next/server';
import { recoverStuckAcknowledgmentResumes } from '@/lib/runtime/acknowledgment-resume';

/**
 * GET /api/cron/recover-acknowledgment-resumes
 *
 * Phase 9.9.12 — background safety net for the SLA acknowledgment
 * primitive's crash window, mirroring
 * /api/cron/recover-review-resumes exactly: a terminal decision
 * (acknowledged/timed_out) can be durably persisted and then the
 * process/network can fail before resumeExecution() is ever called or
 * completes. Most such cases self-heal the next time anyone hits the
 * decide/ack routes again on the same item -- but if nobody ever does
 * (e.g. a timeout that nobody manually re-triggers), this sweep finds it.
 * Same Authorization: Bearer <CRON_SECRET> pattern as every other cron
 * route in this app, same optimistic-CAS claim pattern as
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

  const result = await recoverStuckAcknowledgmentResumes();
  return NextResponse.json(result);
}
