import { NextRequest, NextResponse } from 'next/server';

export const config = {
  matcher: ['/admin/:path*'],
};

export async function middleware(req: NextRequest) {
  const loginUrl = new URL('/login', req.url);
  const token = req.cookies.get('mf_access_token')?.value;

  if (!token) {
    return NextResponse.redirect(loginUrl);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return NextResponse.redirect(loginUrl);
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
  });

  if (!userRes.ok) {
    return NextResponse.redirect(loginUrl);
  }

  const user = (await userRes.json()) as { id?: string };
  if (!user.id) {
    return NextResponse.redirect(loginUrl);
  }

  const adminRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    cache: 'no-store',
  });

  if (!adminRes.ok) {
    return NextResponse.redirect(loginUrl);
  }

  const adminPayload = (await adminRes.json()) as {
    user?: {
      app_metadata?: Record<string, unknown>;
    };
  };

  // Phase 9.6 P0 fix — this previously also trusted user_metadata.role and
  // a (schema-absent) user_profiles.role as admin signals. user_metadata
  // is writable by any authenticated user on their own account via the
  // standard, unrestricted PUT /auth/v1/user endpoint (confirmed live: a
  // disposable test account successfully self-set user_metadata.role to
  // 'admin' with no privileged access at all), which made this gate
  // self-escalatable. app_metadata is only ever writable via the
  // service-role/Admin API, never by the user's own session — it's the
  // only source that was ever actually admin-only. See
  // lib/supabase-server.ts's isAdminUser(), fixed identically.
  const appRole = adminPayload.user?.app_metadata?.role;
  const isAdmin = appRole === 'admin';

  if (!isAdmin) {
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}
