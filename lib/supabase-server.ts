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
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;

  return { id: data.user.id, email: data.user.email ?? '' };
}

/**
 * Reads the user's plan from user_profiles.
 * Returns 'free' if the profile row does not exist yet.
 */
export async function getUserPlan(userId: string): Promise<string> {
  const db = createServiceClient();
  const { data } = await db
    .from('user_profiles')
    .select('plan')
    .eq('id', userId)
    .maybeSingle();
  return data?.plan ?? 'free';
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
  await db.from('user_profiles').upsert(
    { id: userId, plan, upgraded_at: new Date().toISOString() },
    { onConflict: 'id' }
  );
}
