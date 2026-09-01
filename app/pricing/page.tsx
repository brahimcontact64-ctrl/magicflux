'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Check, Crown, Rocket, Building2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Navbar } from '@/components/landing/navbar';
import { Footer } from '@/components/landing/footer';
import { Button } from '@/components/ui/button';
import { PlanBadge } from '@/components/app/plan-badge';
import { useAuth } from '@/lib/auth-context';

type Plan = {
  slug: 'free' | 'pro' | 'business';
  name: string;
  price_monthly: number;
  integrations_limit: number;
  workflows_limit: number;
  executions_limit: number;
  deploy_enabled: boolean;
};

type Usage = {
  plan_name: string;
};

function fmtLimit(v: number) {
  return v === -1 ? 'Unlimited' : String(v);
}

function priceLabel(cents: number) {
  if (cents === 0) return '$0';
  return `$${Math.round(cents / 100)}`;
}

export default function PricingPage() {
  const { session } = useAuth();
  const searchParams = useSearchParams();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [currentPlan, setCurrentPlan] = useState<'free' | 'pro' | 'business' | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState<'pro' | 'business' | null>(null);

  useEffect(() => {
    if (searchParams.get('checkout') === 'cancelled') {
      toast.info('Checkout cancelled — no charge was made.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCheckout(plan: 'pro' | 'business') {
    if (!session) {
      window.location.href = `/login?next=/pricing`;
      return;
    }
    setCheckingOut(plan);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ plan }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        toast.error(data.error ?? 'Could not start checkout');
        setCheckingOut(null);
        return;
      }
      window.location.href = data.url;
    } catch {
      toast.error('Could not start checkout');
      setCheckingOut(null);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [plansRes, usageRes] = await Promise.all([
          fetch('/api/billing/plans', { cache: 'no-store' }),
          fetch('/api/billing/usage', { cache: 'no-store' }),
        ]);

        const plansPayload = (await plansRes.json().catch(() => ({}))) as { plans?: Plan[] };
        if (!cancelled) {
          setPlans((plansPayload.plans ?? []) as Plan[]);
        }

        if (usageRes.ok) {
          const usagePayload = (await usageRes.json().catch(() => ({}))) as Usage;
          const normalized = String(usagePayload.plan_name ?? '').toLowerCase();
          if (normalized === 'free' || normalized === 'pro' || normalized === 'business') {
            if (!cancelled) setCurrentPlan(normalized);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedPlans = useMemo(() => {
    return [...plans].sort((a, b) => a.price_monthly - b.price_monthly);
  }, [plans]);

  return (
    <div className='min-h-screen bg-gradient-to-b from-slate-50 via-white to-slate-100'>
      <Navbar />
      <main className='mx-auto max-w-7xl px-4 pb-16 pt-10 sm:px-6 lg:px-8'>
        <div className='mb-8 flex items-center justify-between'>
          <h1 className='text-3xl font-semibold tracking-tight sm:text-4xl'>MagicFlux Pricing</h1>
          <Link href='/dashboard'>
            <Button variant='outline' size='sm'>Back to Dashboard</Button>
          </Link>
        </div>

        {loading ? (
          <div className='flex items-center gap-2 text-sm text-muted-foreground'>
            <Loader2 className='h-4 w-4 animate-spin' />
            Loading plan details...
          </div>
        ) : (
          <div className='grid gap-6 lg:grid-cols-3'>
            {sortedPlans.map((plan) => {
              const isCurrent = currentPlan === plan.slug;
              const highlighted = plan.slug === 'pro';

              return (
                <div
                  key={plan.slug}
                  className={[
                    'rounded-2xl border bg-white/80 p-6 backdrop-blur',
                    highlighted ? 'border-blue-500 ring-1 ring-blue-200 shadow-xl shadow-blue-500/10' : 'border-slate-200',
                  ].join(' ')}
                >
                  <div className='mb-3 flex items-center gap-2'>
                    {plan.slug === 'free' && <Rocket className='h-4 w-4 text-slate-500' />}
                    {plan.slug === 'pro' && <Crown className='h-4 w-4 text-blue-600' />}
                    {plan.slug === 'business' && <Building2 className='h-4 w-4 text-emerald-600' />}
                    <PlanBadge plan={plan.slug} />
                  </div>

                  <p className='text-4xl font-semibold text-slate-900'>
                    {priceLabel(plan.price_monthly)}
                    <span className='mb-1 text-base text-slate-500'>/mo</span>
                  </p>

                  <ul className='mt-6 space-y-3 text-sm text-slate-700'>
                    <li className='flex items-start gap-2'>
                      <Check className='mt-0.5 h-4 w-4 text-emerald-600' />
                      <span>{fmtLimit(plan.integrations_limit)} integrations</span>
                    </li>
                    <li className='flex items-start gap-2'>
                      <Check className='mt-0.5 h-4 w-4 text-emerald-600' />
                      <span>{fmtLimit(plan.workflows_limit)} workflows</span>
                    </li>
                    <li className='flex items-start gap-2'>
                      <Check className='mt-0.5 h-4 w-4 text-emerald-600' />
                      <span>{fmtLimit(plan.executions_limit)} executions per month</span>
                    </li>
                    <li className='flex items-start gap-2'>
                      <Check className='mt-0.5 h-4 w-4 text-emerald-600' />
                      <span>{plan.deploy_enabled ? 'Live deploy enabled' : 'Live deploy disabled'}</span>
                    </li>
                  </ul>

                  <div className='mt-8'>
                    {isCurrent ? (
                      <Button className='w-full' variant='outline' disabled>Current Plan</Button>
                    ) : plan.slug === 'free' ? (
                      <Link href='/signup' className='block'>
                        <Button className='w-full' variant='outline'>Start Free</Button>
                      </Link>
                    ) : (
                      <Button
                        className='w-full gap-2'
                        variant={highlighted ? 'default' : 'outline'}
                        disabled={checkingOut !== null}
                        onClick={() => handleCheckout(plan.slug as 'pro' | 'business')}
                      >
                        {checkingOut === plan.slug && <Loader2 className='h-4 w-4 animate-spin' />}
                        {checkingOut === plan.slug ? 'Redirecting to checkout…' : `Upgrade to ${plan.name}`}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
