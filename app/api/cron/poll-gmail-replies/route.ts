import { NextRequest, NextResponse } from 'next/server';
import { runGmailPollingBatch } from '@/lib/runtime/inbound-reply/gmail-polling-scheduler';

const CRON_BATCH_SIZE = 25;

/**
 * GET /api/cron/poll-gmail-replies
 *
 * Workflow #2 Phase D.6 -- DISABLED-FIRST: this route exists and is fully
 * testable, but is deliberately NOT added to vercel.json's cron list in
 * this phase, so nothing in production ever invokes it on a schedule.
 * Hitting it directly still requires the real CRON_SECRET (see below), so
 * leaving it unscheduled-but-deployed is itself the disabled-first
 * mechanism -- no separate feature flag is needed (same posture as every
 * route in this codebase: existing, correct code that simply isn't wired
 * into a trigger yet, mirroring the googledrive/followUpSend BLOCKLIST
 * precedent of "real but not yet reachable").
 *
 * When a future phase schedules this (after explicit authorization), it
 * polls up to CRON_BATCH_SIZE Gmail connections per invocation for new
 * inbound replies via the existing, live-certified pollGmailInboundReplies()
 * pipeline (Phase D.2/D.3) -- read-only against Gmail, never sends
 * anything. All discovery/orchestration logic lives in
 * gmail-polling-scheduler.ts; this route contains no business logic beyond
 * auth + invocation, matching reverify-credentials/route.ts's own shape.
 *
 * Authorization:
 *   Authorization: Bearer <CRON_SECRET>  (identical convention to every
 *   other cron route in this codebase)
 *
 * Takes no request body or query parameters -- candidate selection is
 * entirely database-driven (gmail-polling-scheduler.ts), so there is no
 * input surface through which a caller could redirect polling to an
 * arbitrary user or mailbox.
 *
 * Returns a structured summary only (counts + short, secret-free error
 * strings) -- never a token, credential, or message body.
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

  try {
    const summary = await runGmailPollingBatch(CRON_BATCH_SIZE);
    return NextResponse.json(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json({ error: `Gmail polling batch failed: ${msg}` }, { status: 500 });
  }
}
