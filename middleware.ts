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
      user_metadata?: Record<string, unknown>;
    };
  };

  const appRole = adminPayload.user?.app_metadata?.role;
  const userRole = adminPayload.user?.user_metadata?.role;
  let isAdmin = appRole === 'admin' || userRole === 'admin';

  if (!isAdmin) {
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/user_profiles?select=role&id=eq.${user.id}&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: 'no-store',
      }
    );

    if (profileRes.ok) {
      const profiles = (await profileRes.json()) as Array<{ role?: string }>;
      isAdmin = profiles[0]?.role === 'admin';
    }
  }

  if (!isAdmin) {
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}
