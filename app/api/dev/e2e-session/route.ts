import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient, upgradePlan } from '@/lib/supabase-server';

const ISOLATE_B = process.env.MF_BUILD_ISOLATE_B === '1';

const E2E_SESSION_TTL_MINUTES = 45;

type E2ETestUser = {
  id: string;
  email: string;
  cleanup_after: string;
};

function devOnlyGuard(): NextResponse | null {
  // DEV ONLY - never use in production.
  const isProductionBuild = process.env.NEXT_PHASE === 'phase-production-build';
  const isProductionRuntime = process.env.NODE_ENV === 'production';

  if (isProductionBuild || isProductionRuntime) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return null;
}

function createAnonClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
  });
}

async function cleanupE2EUserById(userId: string): Promise<void> {
  const db = createServiceClient();

  await db.from('deploy_rate_limits').delete().eq('user_id', userId);
  await db.from('subscriptions').delete().eq('user_id', userId);
  await db.from('user_profiles').delete().eq('id', userId);
  await db.auth.admin.deleteUser(userId);
}

async function cleanupExpiredE2EUsers(): Promise<void> {
  const db = createServiceClient();
  const now = new Date().toISOString();

  const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const expired = (data?.users ?? []).filter((user) => {
    const appMeta = user.app_metadata as Record<string, unknown> | undefined;
    const cleanupAfter = typeof appMeta?.e2e_cleanup_after === 'string' ? appMeta.e2e_cleanup_after : null;
    const isE2E = appMeta?.e2e_disposable === true;

    return isE2E && cleanupAfter !== null && cleanupAfter <= now;
  });

  for (const user of expired) {
    await cleanupE2EUserById(user.id);
  }
}

export async function POST() {
  if (ISOLATE_B) {
    return NextResponse.json({ error: 'Temporarily disabled by MF_BUILD_ISOLATE_B' }, { status: 404 });
  }

  const denied = devOnlyGuard();
  if (denied) return denied;

  try {
    console.time('e2e-session:cleanupExpiredE2EUsers');
    await cleanupExpiredE2EUsers();
    console.timeEnd('e2e-session:cleanupExpiredE2EUsers');

    const db = createServiceClient();
    const anon = createAnonClient();

    const nonce = randomUUID().slice(0, 8);
    const email = `e2e-${Date.now()}-${nonce}@magicflux.local`;
    const password = `MF-${randomUUID()}!a1`;
    const cleanupAfter = new Date(Date.now() + E2E_SESSION_TTL_MINUTES * 60_000).toISOString();

    console.time('e2e-session:auth.createUser');
    const created = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        role: 'admin',
        e2e_disposable: true,
        e2e_cleanup_after: cleanupAfter,
      },
      user_metadata: {
        role: 'admin',
        e2e_disposable: true,
      },
    });
    console.timeEnd('e2e-session:auth.createUser');

    if (created.error || !created.data.user?.id) {
      return NextResponse.json(
        { error: `Failed to create E2E user: ${created.error?.message ?? 'unknown'}` },
        { status: 500 }
      );
    }

    const userId = created.data.user.id;

    console.time('e2e-session:user_profiles.upsert');
    await db.from('user_profiles').upsert(
      {
        id: userId,
        email,
        role: 'admin',
        plan: 'pro',
        onboarding_complete: true,
        upgraded_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );
    console.timeEnd('e2e-session:user_profiles.upsert');

    console.time('e2e-session:upgradePlan');
    await upgradePlan(userId, 'pro');
    console.timeEnd('e2e-session:upgradePlan');

    console.time('e2e-session:auth.signInWithPassword');
    const signedIn = await anon.auth.signInWithPassword({ email, password });
    console.timeEnd('e2e-session:auth.signInWithPassword');

    if (signedIn.error || !signedIn.data.session) {
      await cleanupE2EUserById(userId);
      return NextResponse.json(
        { error: `Failed to create auth session: ${signedIn.error?.message ?? 'unknown'}` },
        { status: 500 }
      );
    }

    const session = signedIn.data.session;

    return NextResponse.json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      test_user: {
        id: userId,
        email,
        cleanup_after: cleanupAfter,
      } satisfies E2ETestUser,
    });
  } catch (error) {
    console.error('e2e-session:POST error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown E2E session error' },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  if (ISOLATE_B) {
    return NextResponse.json({ error: 'Temporarily disabled by MF_BUILD_ISOLATE_B' }, { status: 404 });
  }

  const denied = devOnlyGuard();
  if (denied) return denied;

  try {
    const body = (await req.json().catch(() => ({}))) as { user_id?: string };
    if (!body.user_id) {
      return NextResponse.json({ error: 'user_id is required' }, { status: 400 });
    }

    await cleanupE2EUserById(body.user_id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Cleanup failed' },
      { status: 500 }
    );
  }
}
