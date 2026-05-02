'use client';

import {
  createContext, useContext, useEffect, useState, useCallback,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase-client';

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

async function fetchPlan(userId: string): Promise<string> {
  const { data } = await supabase
    .from('user_profiles')
    .select('plan')
    .eq('id', userId)
    .maybeSingle();
  return data?.plan ?? 'free';
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
      setUser(null);
      setSession(null);
      setLoading(false);
      return;
    }
    const plan = await fetchPlan(u.id);
    setUser(toAuthUser(u, plan));
    setSession(s);
    setLoading(false);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      hydrate(s?.user ?? null, s ?? null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, s) => {
      (async () => { await hydrate(s?.user ?? null, s ?? null); })();
    });

    return () => subscription.unsubscribe();
  }, [hydrate]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
  }, []);

  const refreshPlan = useCallback(async () => {
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
