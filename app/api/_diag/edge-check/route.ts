import { NextRequest, NextResponse } from 'next/server';

// TEMPORARY diagnostic route — Phase 9.6.1 investigation only. Reproduces
// middleware.ts's exact token/app_metadata.role check in an Edge route
// handler, but reports only boolean/presence-level facts (never the token,
// any header value, or any response body) to isolate why a token that
// verifies fine via direct curl calls still gets redirected to /login by
// middleware.ts. Requires the caller to already hold a valid mf_access_token
// cookie -- an unauthenticated caller learns nothing beyond "no token".
// Delete before concluding Phase 9.6.1.
export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const token = req.cookies.get('mf_access_token')?.value;
  if (!token) {
    return NextResponse.json({ hasToken: false });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const report: Record<string, unknown> = {
    hasToken: true,
    hasSupabaseUrl: !!supabaseUrl,
    hasAnonKey: !!supabaseAnonKey,
    hasServiceRoleKey: !!serviceRoleKey,
  };

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return NextResponse.json(report);
  }

  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    report.userFetchOk = userRes.ok;
    report.userFetchStatus = userRes.status;

    let userId: string | undefined;
    if (userRes.ok) {
      const userBody = (await userRes.json().catch(() => null)) as { id?: string } | null;
      userId = userBody?.id;
      report.gotUserId = !!userId;
    }

    if (userId) {
      const adminRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
        cache: 'no-store',
      });
      report.adminFetchOk = adminRes.ok;
      report.adminFetchStatus = adminRes.status;
      if (adminRes.ok) {
        const adminBody = (await adminRes.json().catch(() => null)) as { user?: { app_metadata?: Record<string, unknown> } } | null;
        report.isAdmin = adminBody?.user?.app_metadata?.role === 'admin';
      }
    }

    return NextResponse.json(report);
  } catch (e) {
    report.threw = true;
    report.errorName = e instanceof Error ? e.name : 'unknown';
    return NextResponse.json(report);
  }
}
