'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Zap, ArrowRight, Crown, Building2, Loader, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Plan = {
  slug: 'free' | 'pro' | 'business';
  name: string;
  price_monthly: number;
  integrations_limit: number;
  workflows_limit: number;
  executions_limit: number;
  deploy_enabled: boolean;
};

function fmtLimit(v: number) {
  return v === -1 ? 'Unlimited' : String(v);
}

function priceLabel(cents: number) {
  return cents === 0 ? '$0' : `$${Math.round(cents / 100)}`;
}

const PLAN_META: Record<Plan['slug'], { icon: typeof Zap; iconColor: string; featured: boolean; cta: string; ctaHref: string }> = {
  free: { icon: Zap, iconColor: 'text-cyan-400', featured: false, cta: 'Start Building Free', ctaHref: '/signup' },
  pro: { icon: Crown, iconColor: 'text-primary', featured: true, cta: 'Upgrade to Pro', ctaHref: '/pricing' },
  business: { icon: Building2, iconColor: 'text-blue-400', featured: false, cta: 'Upgrade to Business', ctaHref: '/pricing' },
};

const ADD_ONS = [
  { label: 'Managed Setup', price: '$97', desc: 'We build & deploy one automation for you, one time' },
  { label: 'Custom Modifications', price: '$47', desc: 'Modify any existing workflow' },
  { label: 'Additional Automation', price: '$79', desc: 'Each additional managed setup' },
];

/**
 * Phase 9.3.2 Step H — the landing page's primary pricing surface now
 * fetches from /api/billing/plans, the same source of truth /pricing and
 * the entitlement gate itself use, rather than hardcoding Free/Pro/
 * Business numbers a second time (the exact kind of drift the Phase 9.3
 * audit found between this page and the real product). Managed Setup is
 * demoted to a clearly-separate, secondary "optional add-on" section --
 * it is a real one-time service that can stay, but it is not what
 * MagicFlux costs, and this page no longer claims "no subscriptions
 * required."
 */
export function Pricing() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [managedLoading, setManagedLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/billing/plans')
      .then((res) => res.json())
      .then((data: { plans?: Plan[] }) => {
        if (!cancelled) setPlans((data.plans ?? []).slice().sort((a, b) => a.price_monthly - b.price_monthly));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function startManagedSetupCheckout() {
    setManagedLoading(true);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceKey: 'managed_setup' }),
      });
      const data = await res.json();
      window.location.href = data.url || '/builder';
    } catch {
      window.location.href = '/builder';
    } finally {
      setManagedLoading(false);
    }
  }

  return (
    <section id="pricing" className="py-24 relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <p className="text-xs font-medium text-primary uppercase tracking-widest mb-3">Pricing</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Simple, <span className="text-gradient">predictable</span> pricing
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Start free. Upgrade when you're ready to activate live workflows.
          </p>
        </div>

        {/* Free / Pro / Business — the real MagicFlux plans */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-12">
            <Loader className="w-4 h-4 animate-spin" />
            Loading plans…
          </div>
        ) : (
          <div className="grid md:grid-cols-3 gap-6 items-start mb-16">
            {plans.map((plan) => {
              const meta = PLAN_META[plan.slug];
              const Icon = meta.icon;
              return (
                <div
                  key={plan.slug}
                  className={cn(
                    'relative rounded-2xl border p-6 lg:p-8 flex flex-col transition-all duration-300 hover:-translate-y-1',
                    meta.featured
                      ? 'border-primary/40 bg-gradient-to-b from-primary/10 to-primary/5 shadow-xl shadow-primary/10'
                      : 'border-border bg-card',
                  )}
                >
                  {meta.featured && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <span className="px-3 py-1 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg shadow-primary/30">
                        Most Popular
                      </span>
                    </div>
                  )}

                  <div className="mb-6">
                    <div className="flex items-center gap-2.5 mb-3">
                      <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', meta.featured ? 'bg-primary/20' : 'bg-muted')}>
                        <Icon className={cn('w-4 h-4', meta.iconColor)} />
                      </div>
                      <h3 className="text-base font-semibold">{plan.name}</h3>
                    </div>
                    <div className="flex items-end gap-1 mb-2">
                      <span className="text-3xl font-bold">{priceLabel(plan.price_monthly)}</span>
                      <span className="text-muted-foreground text-sm mb-1">/month</span>
                    </div>
                  </div>

                  <div className="mb-6">
                    <Link href={meta.ctaHref}>
                      <Button variant={meta.featured ? 'default' : 'outline'} className="w-full gap-2">
                        <Icon className="w-3.5 h-3.5" />
                        {meta.cta}
                        <ArrowRight className="w-3.5 h-3.5" />
                      </Button>
                    </Link>
                  </div>

                  <ul className="space-y-3 flex-1">
                    {[
                      `${fmtLimit(plan.integrations_limit)} integrations`,
                      `${fmtLimit(plan.workflows_limit)} workflows`,
                      `${fmtLimit(plan.executions_limit)} executions per month`,
                      plan.deploy_enabled ? 'Live workflow activation' : 'Workflow generation only (no live activation)',
                    ].map((feature) => (
                      <li key={feature} className="flex items-start gap-2.5 text-sm">
                        <Check className={cn('w-4 h-4 mt-0.5 flex-shrink-0', meta.featured ? 'text-primary' : 'text-muted-foreground')} />
                        <span className="text-muted-foreground">{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}

        {/* Managed Setup — clearly separate optional service, not a MagicFlux plan */}
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
            <div>
              <p className="text-sm font-semibold flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary" /> Prefer we build it for you?
              </p>
              <p className="text-xs text-muted-foreground mt-1 max-w-md">
                Optional, separate from your MagicFlux plan — our team builds and deploys one automation for you, one time.
                Available on any plan, including Free.
              </p>
            </div>
            <Button onClick={startManagedSetupCheckout} disabled={managedLoading} variant="outline" className="gap-2 whitespace-nowrap">
              {managedLoading ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              Request Managed Setup — $97
            </Button>
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            {ADD_ONS.map((addon) => (
              <div key={addon.label} className="flex items-center justify-between p-3 rounded-xl border border-border bg-muted/20">
                <div>
                  <p className="text-sm font-medium">{addon.label}</p>
                  <p className="text-xs text-muted-foreground">{addon.desc}</p>
                </div>
                <span className="text-sm font-semibold text-primary ml-3 whitespace-nowrap">{addon.price}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom note */}
        <div className="text-center space-y-1.5 mt-8">
          <p className="text-sm text-muted-foreground">
            {/* Phase 9.5 Step L: workflow export is real (see
                components/builder/output-panel.tsx), but every plan runs
                the workflow live on MagicFlux itself -- it doesn't require
                a separate n8n instance the way this line implied. */}
            Every plan runs your workflow live on MagicFlux &middot; Export the JSON anytime
          </p>
          <p className="text-xs text-muted-foreground">
            Questions?{' '}
            <a href="mailto:hello@magicflux.ai" className="text-primary hover:underline">
              Email us
            </a>
            {' '}· No credit card required for the Free plan
          </p>
        </div>
      </div>
    </section>
  );
}
