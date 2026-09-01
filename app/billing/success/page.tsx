'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Zap, Crown, CircleCheck as CheckCircle2, Loader as Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';

type State = 'polling' | 'confirmed' | 'timeout';

const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 15; // ~30s -- webhooks typically land in well under this

/**
 * Phase 9.3.2 Step I — Stripe checkout success landing page.
 *
 * This page NEVER grants entitlement. `?session_id=`/`?plan=` are purely
 * UI hints for what to display while waiting; the only thing that ever
 * writes to `subscriptions` is the signed webhook
 * (app/api/billing/webhook/route.ts), which usually lands within a couple
 * of seconds of Stripe redirecting the browser here but is not guaranteed
 * to have landed yet. This page polls the canonical resolver
 * (refreshPlan(), which reads the real server-side entitlement) until it
 * reflects the upgrade, rather than trusting the redirect itself.
 */
export default function BillingSuccessPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, refreshPlan } = useAuth();
  const [state, setState] = useState<State>('polling');
  const attemptsRef = useRef(0);
  const cancelledRef = useRef(false);

  const expectedPlan = (searchParams.get('plan') ?? 'pro').toLowerCase();
  const userPlanRef = useRef(user?.plan);
  userPlanRef.current = user?.plan;

  useEffect(() => {
    cancelledRef.current = false;

    async function poll() {
      while (!cancelledRef.current && attemptsRef.current < MAX_ATTEMPTS) {
        if (userPlanRef.current && userPlanRef.current !== 'free') {
          setState('confirmed');
          return;
        }
        attemptsRef.current += 1;
        await refreshPlan(); // reads the real, canonical server-side entitlement
        if (cancelledRef.current) return;
        if (userPlanRef.current && userPlanRef.current !== 'free') {
          setState('confirmed');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (!cancelledRef.current) setState('timeout');
    }

    poll();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <Link href="/" className="inline-flex items-center gap-2 group">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center group-hover:scale-105 transition-transform">
            <Zap className="w-5 h-5 text-primary-foreground" fill="currentColor" />
          </div>
        </Link>

        {state === 'polling' && (
          <div className="space-y-4">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Payment received — activating your subscription…</h1>
              <p className="text-sm text-muted-foreground mt-1">This usually takes a few seconds.</p>
            </div>
          </div>
        )}

        {state === 'confirmed' && (
          <div className="space-y-6">
            <div className="w-20 h-20 rounded-full bg-amber-500/15 flex items-center justify-center mx-auto">
              <Crown className="w-10 h-10 text-amber-400" />
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-bold">You're now on {user?.plan === 'business' ? 'Business' : 'Pro'}</h1>
              <p className="text-muted-foreground text-sm">
                Your subscription is active — you can now activate live workflows.
              </p>
            </div>
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-left space-y-2">
              <p className="text-sm font-semibold text-amber-400 flex items-center gap-2">
                <Crown className="w-4 h-4" /> What's unlocked
              </p>
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                {['Live workflow activation', 'Higher workflow and integration limits', 'Higher monthly execution limit'].map((item) => (
                  <li key={item} className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <Button onClick={() => router.push('/builder')} className="w-full gap-2">
              <Zap className="w-4 h-4" />
              Start building
            </Button>
          </div>
        )}

        {state === 'timeout' && (
          <div className="space-y-6">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto">
              <Loader2 className="w-8 h-8 text-muted-foreground" />
            </div>
            <div className="space-y-2">
              <h1 className="text-xl font-bold">Still confirming your payment</h1>
              <p className="text-sm text-muted-foreground">
                Your payment for {expectedPlan === 'business' ? 'Business' : 'Pro'} went through, but activation is taking
                longer than usual. This should resolve on its own shortly — reloading often helps.
              </p>
            </div>
            <Button onClick={() => window.location.reload()} className="w-full gap-2">
              Refresh
            </Button>
            <Button variant="outline" onClick={() => router.push('/builder')} className="w-full gap-2">
              Continue to builder
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
