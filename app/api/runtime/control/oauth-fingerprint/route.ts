import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import { getUserPermissions } from '@/lib/runtime/rbac';
import { computeAllOAuthClientFingerprints, getRuntimeIdentity } from '@/lib/credentials/oauth-fingerprint';

export const dynamic = 'force-dynamic';

/**
 * GET — Incident 9.9.17K. Returns non-secret SHA-256 fingerprints (16 hex
 * chars, truncated -- a comparison aid, never a recoverable value) of every
 * registered OAuth provider's currently-configured client id/secret on
 * THIS runtime, plus which platform/environment this runtime is.
 *
 * Purpose: let an operator compare this endpoint's output (Vercel) against
 * the runtime-worker boot log's equivalent line (Railway, printed once at
 * startup via the same computeAllOAuthClientFingerprints()) to prove
 * whether both runtimes are presenting the SAME OAuth client identity to
 * the provider -- without either side ever exposing the client id/secret
 * itself. Admin-only: this is an operator diagnostic surface, not a
 * general user-facing one.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const perms = await getUserPermissions(user.id).catch(() => null);
  if (!perms) {
    return NextResponse.json({ error: 'Authorization service unavailable' }, { status: 503 });
  }
  if (!perms.includes('admin_runtime')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({
    runtime: getRuntimeIdentity(),
    fingerprints: computeAllOAuthClientFingerprints(),
  });
}
