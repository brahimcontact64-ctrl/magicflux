'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Zap, ArrowRight, Sparkles, Building2, Shield, Loader } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

async function startStripeCheckout(priceKey: string, setLoading: (v: boolean) => void) {
  setLoading(true);
  try {
    const res = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceKey }),
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      window.location.href = '/builder';
    }
  } catch {
    window.location.href = '/builder';
  } finally {
    setLoading(false);
  }
}

const PLANS = [
  {
    id: 'diy',
    name: 'DIY Builder',
    price: '$0',
    period: 'free forever',
    description: 'Generate and self-deploy automations with full package downloads.',
    badge: null,
    icon: Zap,
    iconColor: 'text-cyan-400',
    accent: 'border-border bg-card',
    featured: false,
    cta: 'Start Building Free',
    ctaHref: '/builder',
    ctaVariant: 'outline' as const,
    features: [
      'Unlimited AI-generated workflows',
      'All 9 industry templates',
      'Visual workflow canvas',
      'Complete package download (JSON + .env + guide)',
      'Credentials setup wizard',
      'Customization chat loop',
      'Community support'
    ]
  },
  {
    id: 'managed',
    name: 'Managed Setup',
    price: '$97',
    period: 'one-time per automation',
    description: 'We build, configure, and deploy your automation end-to-end.',
    badge: 'Most Popular',
    icon: Sparkles,
    iconColor: 'text-primary',
    accent: 'border-primary/40 bg-gradient-to-b from-primary/10 to-primary/5 shadow-xl shadow-primary/10',
    featured: true,
    cta: 'Request Managed Setup',
    ctaHref: '/builder',
    ctaVariant: 'default' as const,
    features: [
      'Everything in DIY Builder',
      'We set up your n8n instance',
      'Full credential configuration',
      'Integration with Gmail, Slack, Shopify, etc.',
      'Test with your real data',
      '48-hour delivery SLA',
      '30-day post-launch support',
      'Dedicated workflow engineer'
    ]
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    period: 'contact for pricing',
    description: 'White-label platform, custom templates, and dedicated infrastructure.',
    badge: null,
    icon: Building2,
    iconColor: 'text-blue-400',
    accent: 'border-border bg-card',
    featured: false,
    cta: 'Contact Sales',
    ctaHref: 'mailto:sales@magicflux.ai',
    ctaVariant: 'outline' as const,
    features: [
      'Everything in Managed Setup',
      'White-label automation builder',
      'Custom industry templates',
      'Multi-tenant SaaS architecture',
      'Direct n8n API deployment',
      'API access & webhooks',
      'Team workspaces & SSO',
      'SLA guarantee + dedicated account manager'
    ]
  }
];

const ADD_ONS = [
  { label: 'Custom Modifications', price: '$47', desc: 'Modify any existing workflow' },
  { label: 'Monthly Support', price: '$29/mo', desc: 'Ongoing maintenance & updates' },
  { label: 'Additional Automation', price: '$79', desc: 'Each additional managed setup' }
];

export function Pricing() {
  const [loadingStripe, setLoadingStripe] = useState(false);

  return (
    <section id="pricing" className="py-24 relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <p className="text-xs font-medium text-primary uppercase tracking-widest mb-3">Pricing</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            From self-serve to{' '}
            <span className="text-gradient">fully managed</span>
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Build it yourself for free, or let our team handle everything. No subscriptions required — pay only when you need us.
          </p>
          <div className="inline-flex items-center gap-2 mt-4 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium">
            <Shield className="w-3 h-3" />
            30-day money-back guarantee on all managed services
          </div>
        </div>

        {/* Plans Grid */}
        <div className="grid md:grid-cols-3 gap-6 items-start mb-12">
          {PLANS.map(plan => {
            const Icon = plan.icon;
            return (
              <div
                key={plan.id}
                className={cn(
                  'relative rounded-2xl border p-6 lg:p-8 flex flex-col transition-all duration-300 hover:-translate-y-1',
                  plan.accent
                )}
              >
                {plan.badge && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="px-3 py-1 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg shadow-primary/30">
                      {plan.badge}
                    </span>
                  </div>
                )}

                {/* Plan header */}
                <div className="mb-6">
                  <div className="flex items-center gap-2.5 mb-3">
                    <div className={cn(
                      'w-8 h-8 rounded-lg flex items-center justify-center',
                      plan.featured ? 'bg-primary/20' : 'bg-muted'
                    )}>
                      <Icon className={cn('w-4 h-4', plan.iconColor)} />
                    </div>
                    <h3 className="text-base font-semibold">{plan.name}</h3>
                  </div>
                  <div className="flex items-end gap-1 mb-2">
                    <span className="text-3xl font-bold">{plan.price}</span>
                    <span className="text-muted-foreground text-sm mb-1">/{plan.period}</span>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{plan.description}</p>
                </div>

                {/* CTA */}
                {plan.id === 'enterprise' ? (
                  <div className="mb-6">
                    <a href={plan.ctaHref}>
                      <Button variant={plan.ctaVariant} className="w-full gap-2">
                        {plan.cta}
                        <ArrowRight className="w-3.5 h-3.5" />
                      </Button>
                    </a>
                  </div>
                ) : plan.id === 'managed' ? (
                  <div className="mb-6">
                    <Button
                      onClick={() => startStripeCheckout('managed_setup', setLoadingStripe)}
                      disabled={loadingStripe}
                      className={cn('w-full gap-2 shadow-lg shadow-primary/20')}
                    >
                      {loadingStripe ? (
                        <Loader className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      {plan.cta}
                      {!loadingStripe && <ArrowRight className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                ) : (
                  <div className="mb-6">
                    <Link href={plan.ctaHref}>
                      <Button variant={plan.ctaVariant} className="w-full gap-2">
                        <Icon className="w-3.5 h-3.5" />
                        {plan.cta}
                        <ArrowRight className="w-3.5 h-3.5" />
                      </Button>
                    </Link>
                  </div>
                )}

                {/* Features */}
                <ul className="space-y-3 flex-1">
                  {plan.features.map(feature => (
                    <li key={feature} className="flex items-start gap-2.5 text-sm">
                      <Check className={cn(
                        'w-4 h-4 mt-0.5 flex-shrink-0',
                        plan.featured ? 'text-primary' : 'text-muted-foreground'
                      )} />
                      <span className="text-muted-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        {/* Add-ons row */}
        <div className="rounded-2xl border border-border bg-card p-6 mb-8">
          <p className="text-sm font-semibold mb-4">Managed Service Add-ons</p>
          <div className="grid sm:grid-cols-3 gap-4">
            {ADD_ONS.map(addon => (
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
        <div className="text-center space-y-1.5">
          <p className="text-sm text-muted-foreground">
            All plans include n8n-compatible JSON export &middot; Works with any n8n instance
          </p>
          <p className="text-xs text-muted-foreground">
            Questions?{' '}
            <a href="mailto:hello@magicflux.ai" className="text-primary hover:underline">
              Email us
            </a>
            {' '}· No credit card required for free plan
          </p>
        </div>
      </div>
    </section>
  );
}
