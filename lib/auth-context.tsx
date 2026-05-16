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
  plan: string;
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

async function fetchPlan(userId: string): Promise<string> {
  if (ISOLATE_A) return 'free';

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('status, plan, plans!subscriptions_plan_id_fkey(slug)')
    .eq('user_id', userId)
    .maybeSingle();

  const subStatus = sub?.status as string | undefined;
  const subPlanSlug = (sub?.plans as { slug?: string } | null | undefined)?.slug;
  if (subStatus === 'active' && (subPlanSlug || sub?.plan)) {
    return subPlanSlug ?? String(sub?.plan);
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('plan')
    .eq('id', userId)
    .maybeSingle();

  return profile?.plan ?? 'free';
}

function toAuthUser(u: User, plan: string): AuthUser {
  return { id: u.id, email: u.email ?? '', plan };
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
    const plan = await fetchPlan(u.id);
    setAccessTokenCookie(s?.access_token ?? null);
    setUser(toAuthUser(u, plan));
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

    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) return;
    const plan = await fetchPlan(u.id);
    setUser(prev => (prev ? { ...prev, plan } : null));
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
