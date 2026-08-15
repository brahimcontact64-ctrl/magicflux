import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { verifyStaleCredentials } from '@/lib/credentials/stale-verifier';
import { assertTrustedUserId } from '@/lib/credentials/storage';

const CRON_BATCH_SIZE = 50;

/**
 * GET /api/cron/reverify-credentials
 *
 * Scheduled daily at 03:00 UTC (see vercel.json crons).
 * Re-verifies credentials for up to CRON_BATCH_SIZE users whose providers
 * are stale (not verified in the last 7 days).
 *
 * Authorization:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Returns:
 *   { processedUsers, reverifiedProviders, errors }
 */
export async function GET(req: NextRequest) {
  // ── Authorization ────────────────────────────────────────────────────────────
  // Vercel sends the CRON_SECRET as a Bearer token when invoking cron routes.
  // Reject any request that does not carry the correct secret.
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

  // ── Fetch next batch of users to process ──────────────────────────────────
  /*
   * SECURITY JUSTIFICATION:
   * Service role required because:
   * - This is a cron/maintenance route; no user JWT exists.
   * - We query distinct user_ids from integration_credentials to build the
   *   batch; the userId values are DB-sourced, not client-supplied.
   * - assertTrustedUserId() is called on each userId inside verifyStaleCredentials.
   */
  const db = createServiceClient();

  // Select the CRON_BATCH_SIZE users with the stalest (or absent) verification
  // records, ordered so NULLs (never-verified) come first, then oldest verified_at.
  // The raw SQL LEFT JOIN is required because PostgREST does not support
  // cross-table ordering via the JS client.
  const staleMs = 7 * 24 * 60 * 60 * 1000;
  const staleThreshold = new Date(Date.now() - staleMs).toISOString();

  const { data: userRows, error: userError } = await db.rpc(
    'get_stale_credential_users',
    { p_threshold: staleThreshold, p_limit: CRON_BATCH_SIZE }
  );

  if (userError) {
    return NextResponse.json(
      { error: `Failed to fetch stale users: ${userError.message}` },
      { status: 500 }
    );
  }

  const uniqueUserIds = (userRows ?? []).map((r: { user_id: string }) => String(r.user_id));

  if (uniqueUserIds.length === 0) {
    return NextResponse.json({ processedUsers: 0, reverifiedProviders: 0, errors: [] });
  }

  // ── Process each user ─────────────────────────────────────────────────────
  let reverifiedProviders = 0;
  const errors: string[] = [];

  for (const userId of uniqueUserIds) {
    try {
      assertTrustedUserId(userId);
      const results = await verifyStaleCredentials(userId);
      reverifiedProviders += results.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`user ${userId.slice(0, 8)}…: ${msg}`);
    }
  }

  return NextResponse.json({
    processedUsers: uniqueUserIds.length,
    reverifiedProviders,
    errors,
  });
}
