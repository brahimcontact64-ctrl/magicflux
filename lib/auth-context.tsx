'use client';

import {
  createContext, useContext, useEffect, useState, useCallback,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase-client';

const ISOLATE_A = process.env.NEXT_PUBLIC_MF_BUILD_ISOLATE_A === '1';

export interface AuthUser {
  id: string;
  email: string;
  /** Real, un-expanded paid-tier slug ('free' | 'pro' | 'business') from the
      canonical server-side resolver (lib/billing/plan-limits.ts). Stays
      'free' for a Beta user even though Beta grants them expanded
      capabilities -- use this ONLY for the honest "did they actually pay"
      cosmetic badge (e.g. the Crown icon), never to gate a capability. */
  plan: string;
  /** Display name from the same resolver, e.g. "Free (Beta)" while Beta Mode
      is active, or "Pro" for a real paid subscriber. Safe to show verbatim. */
  planName: string;
  /** Whether this account can activate/deploy a live workflow RIGHT NOW,
      per the canonical, Beta-aware resolver. This is the ONLY field UI
      should gate deploy-capability messaging/blocking on -- `plan`/`isPro`
      checks derived from it are cosmetic-only and must never imply a
      capability the user doesn't actually have. */
  deployEnabled: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshPlan: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  session: null,
  loading: true,
  signOut: async () => {},
  refreshPlan: async () => {},
});

function setAccessTokenCookie(token: string | null) {
  if (typeof document === 'undefined') return;

  if (!token) {
    document.cookie = 'mf_access_token=; Path=/; Max-Age=0; SameSite=Lax';
    return;
  }

  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `mf_access_token=${encodeURIComponent(token)}; Path=/; Max-Age=604800; SameSite=Lax${secure}`;
}

type Entitlement = { plan: string; planName: string; deployEnabled: boolean };

// Fails closed (no deploy) on any error -- this is a display concern only;
// real enforcement always happens server-side against the same resolver
// (see lib/billing/plan-limits.ts), so a transient failure here can only
// under-display capability, never grant one.
const FAIL_CLOSED_ENTITLEMENT: Entitlement = { plan: 'free', planName: 'Free', deployEnabled: false };

/**
 * Phase 9.9.20 -- this previously ran its OWN independent, non-Beta-aware
 * query directly against `subscriptions`/`user_profiles`, completely
 * bypassing the canonical server-side resolver (resolveUserPlan() in
 * lib/billing/plan-limits.ts) and its Beta-mode expansion. A brand-new
 * account with zero subscription rows resolved here to the literal string
 * 'free', which every isPro-style client check then read as "not entitled" --
 * even though the server's resolver, and every real enforcement route, had
 * already granted that same account full Beta capability. Now calls
 * /api/billing/usage, the existing endpoint that already wraps
 * resolveUserPlan() -- the client reads the exact same effective
 * entitlement the server enforces, instead of recomputing a second,
 * divergent one.
 */
async function fetchEntitlement(accessToken: string): Promise<Entitlement> {
  if (ISOLATE_A) return FAIL_CLOSED_ENTITLEMENT;

  try {
    const res = await fetch('/api/billing/usage', {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
    if (!res.ok) return FAIL_CLOSED_ENTITLEMENT;

    const data = (await res.json()) as { plan_slug?: string; plan_name?: string; deploy_enabled?: boolean };
    return {
      plan: data.plan_slug ?? 'free',
      planName: data.plan_name ?? 'Free',
      deployEnabled: Boolean(data.deploy_enabled),
    };
  } catch {
    return FAIL_CLOSED_ENTITLEMENT;
  }
}

function toAuthUser(u: User, entitlement: Entitlement): AuthUser {
  return { id: u.id, email: u.email ?? '', ...entitlement };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const hydrate = useCallback(async (u: User | null, s: Session | null) => {
    if (!u) {
      setAccessTokenCookie(null);
      setUser(null);
      setSession(null);
      setLoading(false);
      return;
    }
    const entitlement = s?.access_token ? await fetchEntitlement(s.access_token) : FAIL_CLOSED_ENTITLEMENT;
    setAccessTokenCookie(s?.access_token ?? null);
    setUser(toAuthUser(u, entitlement));
    setSession(s);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (ISOLATE_A) {
      setUser(null);
      setSession(null);
      setLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      hydrate(s?.user ?? null, s ?? null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, s) => {
      (async () => { await hydrate(s?.user ?? null, s ?? null); })();
    });

    return () => subscription.unsubscribe();
  }, [hydrate]);

  const signOut = useCallback(async () => {
    if (ISOLATE_A) {
      setAccessTokenCookie(null);
      setUser(null);
      setSession(null);
      return;
    }

    await supabase.auth.signOut();
    setAccessTokenCookie(null);
    setUser(null);
    setSession(null);
  }, []);

  const refreshPlan = useCallback(async () => {
    if (ISOLATE_A) return;

    const { data: { session: s } } = await supabase.auth.getSession();
    if (!s?.user || !s.access_token) return;
    const entitlement = await fetchEntitlement(s.access_token);
    setUser(prev => (prev ? { ...prev, ...entitlement } : null));
  }, []);

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut, refreshPlan }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
