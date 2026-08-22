import { NextRequest, NextResponse } from 'next/server';
import { runSelfHeal } from '@/lib/runtime/self-healer';

/**
 * GET /api/cron/self-heal
 *
 * Vercel Cron entry point for the existing self-heal subsystem
 * (lib/runtime/self-healer.ts's runSelfHeal — orphan-execution recovery,
 * stuck-job recovery, expired-concurrency-reservation reclaim). Scheduled
 * every 5 minutes in vercel.json.
 *
 * A thin GET wrapper, not a new subsystem: Vercel Cron always issues a GET
 * request, but the existing POST /api/runtime/self-heal route (used by the
 * runtime control UI for on-demand manual triggers) only handles POST —
 * this route exists solely to bridge that gap, reusing runSelfHeal()
 * directly rather than duplicating its logic. Same CRON_SECRET
 * bearer-auth pattern as /api/cron/dispatch-schedules and
 * /api/cron/reverify-credentials.
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

  const report = await runSelfHeal({});
  return NextResponse.json({ success: true, report });
}
