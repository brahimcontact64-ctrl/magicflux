import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** Service-role client — bypasses RLS. Use only in server-side API routes. */
export function createServiceClient() {
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });
}

/**
 * Validates the Bearer JWT from an API request.
 * Returns the authenticated user or null.
 * Never trust a client-supplied userId — always derive from the verified JWT.
 */
export async function getUserFromRequest(
  req: Request
): Promise<{ id: string; email: string } | null> {
  const authHeader = req.headers.get('authorization');
  let token: string | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    const cookieHeader = req.headers.get('cookie') ?? '';
    const tokenPair = cookieHeader
      .split(';')
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('mf_access_token='));

    if (tokenPair) {
      const raw = tokenPair.slice('mf_access_token='.length);
      token = decodeURIComponent(raw);
    }
  }

  if (!token) return null;

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;

  return { id: data.user.id, email: data.user.email ?? '' };
}

/** Validates a Supabase access token and returns user identity, or null. */
export async function getUserFromAccessToken(
  token: string
): Promise<{ id: string; email: string } | null> {
  if (!token) return null;

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;

  return { id: data.user.id, email: data.user.email ?? '' };
}

/** Reads Bearer token from authorization header. */
export function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

/**
 * Admin check:
 * - Preferred source: auth user app_metadata.role === 'admin'
 * - Fallback source: auth user user_metadata.role === 'admin'
 */
export async function isAdminUser(userId: string): Promise<boolean> {
  const db = createServiceClient();
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error || !data.user) return false;

  const appRole = (data.user.app_metadata as Record<string, unknown> | undefined)?.role;
  const userRole = (data.user.user_metadata as Record<string, unknown> | undefined)?.role;

  if (appRole === 'admin' || userRole === 'admin') return true;

  const { data: profile } = await db
    .from('user_profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  return profile?.role === 'admin';
}

/**
 * @deprecated Phase 9.3.1: this is a second, independent "get user's plan"
 * implementation that trusts the raw, unverified `subscriptions.plan` text
 * column (and falls back to `user_profiles.plan`) rather than the real
 * FK-joined `plans` row -- the same loose semantics the client-only
 * display badge (lib/auth-context.tsx's fetchPlan()) uses, which is fine
 * for a UI badge but not for a security-sensitive entitlement decision.
 * Its last caller (app/api/n8n/orchestrate/route.ts) has been switched to
 * the canonical resolver in lib/billing/plan-limits.ts
 * (getUserPlan()/canDeployWorkflow()). Kept only for compatibility in case
 * something outside this audit's search still imports it; do not add new
 * callers -- use lib/billing/plan-limits.ts instead.
 *
 * Reads the user's plan from subscriptions + plans.
 * Falls back to user_profiles.plan for backward compatibility.
 */
export async function getUserPlan(userId: string): Promise<string> {
  const db = createServiceClient();

  const { data: sub } = await db
    .from('subscriptions')
    .select('status, plan, plan_id, plans!subscriptions_plan_id_fkey(slug)')
    .eq('user_id', userId)
    .maybeSingle();

  const subStatus = sub?.status as string | undefined;
  const subPlanSlug = (sub?.plans as { slug?: string } | null | undefined)?.slug;
  if (subStatus === 'active' && (subPlanSlug || sub?.plan)) {
    return subPlanSlug ?? String(sub?.plan);
  }

  const { data: profile } = await db
    .from('user_profiles')
    .select('plan')
    .eq('id', userId)
    .maybeSingle();

  return profile?.plan ?? 'free';
}

/**
 * Checks and increments the deploy rate limit for a user.
 * Allows max 5 deploys per 60-second window.
 * Returns true if allowed, false if rate-limited.
 */
export async function checkDeployRateLimit(userId: string): Promise<boolean> {
  const db = createServiceClient();
  const windowMs = 60 * 1000;
  const maxDeploys = 5;

  const { data } = await db
    .from('deploy_rate_limits')
    .select('window_start, deploy_count')
    .eq('user_id', userId)
    .maybeSingle();

  const now = new Date();

  if (!data) {
    await db.from('deploy_rate_limits').insert({
      user_id: userId,
      window_start: now.toISOString(),
      deploy_count: 1,
    });
    return true;
  }

  const elapsed = now.getTime() - new Date(data.window_start).getTime();

  if (elapsed > windowMs) {
    await db
      .from('deploy_rate_limits')
      .update({ window_start: now.toISOString(), deploy_count: 1 })
      .eq('user_id', userId);
    return true;
  }

  if (data.deploy_count >= maxDeploys) return false;

  await db
    .from('deploy_rate_limits')
    .update({ deploy_count: data.deploy_count + 1 })
    .eq('user_id', userId);

  return true;
}

/** Upgrades a user's plan. Called after confirmed PayPal payment. */
export async function upgradePlan(userId: string, plan: string): Promise<void> {
  const db = createServiceClient();

  const { data: planRow } = await db
    .from('plans')
    .select('id, slug')
    .eq('slug', plan)
    .maybeSingle();

  await db.from('user_profiles').upsert(
    { id: userId, plan, upgraded_at: new Date().toISOString() },
    { onConflict: 'id' }
  );

  await db.from('subscriptions').upsert(
    {
      user_id: userId,
      plan: planRow?.slug ?? plan,
      plan_id: planRow?.id ?? null,
      status: 'active',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
}
