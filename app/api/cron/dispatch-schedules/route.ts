import { NextRequest, NextResponse } from 'next/server';
import { pollDueSchedules } from '@/lib/runtime/scheduler';

/**
 * GET /api/cron/dispatch-schedules
 *
 * Scheduled every minute (see vercel.json crons — Vercel Cron's minimum
 * granularity). Fires every due, enabled workflow schedule exactly once.
 * Safe to invoke concurrently / overlap with itself (e.g. a slow previous
 * invocation still running when the next minute's fires) — pollDueSchedules()
 * claims each due schedule via an atomic compare-and-swap update, so a
 * schedule already claimed by an in-flight invocation is silently skipped
 * by any other, matching the same Authorization: Bearer <CRON_SECRET>
 * pattern already used by /api/cron/reverify-credentials.
 *
 * Returns:
 *   { fired, skipped, errors }
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

  const result = await pollDueSchedules();
  return NextResponse.json(result);
}
