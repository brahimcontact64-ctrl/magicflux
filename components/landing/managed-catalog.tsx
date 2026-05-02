'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Sparkles, ArrowRight, Clock, Shield, Star, Building2, Chrome as Home, ShoppingBag, ChevronRight, Zap, Users, CircleCheck as CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase-client';
import { cn } from '@/lib/utils';

const MANAGED_AUTOMATIONS = [
  {
    id: 'tenant-maintenance',
    name: 'Tenant Maintenance System',
    industry: 'property-management',
    description: 'Full ticket intake, Airtable logging, manager alerts, and tenant confirmations — running in 48 hours.',
    deliveryTime: '48 hours',
    price: '$97',
    rating: 4.9,
    reviews: 23,
    includes: ['Gmail setup', 'Airtable base created', 'Webhook configured', 'Test run with dummy data'],
    icon: Building2,
    color: 'text-blue-400 bg-blue-500/10 border-blue-500/20'
  },
  {
    id: 'guest-messaging',
    name: 'Airbnb Guest Messaging',
    industry: 'airbnb',
    description: 'Automated welcome, pre-arrival instructions, and check-out review requests — personalized to your property.',
    deliveryTime: '48 hours',
    price: '$97',
    rating: 5.0,
    reviews: 18,
    includes: ['Gmail/SMTP configured', 'Property details personalized', 'Timing sequences set', 'Live test done'],
    icon: Home,
    color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20'
  },
  {
    id: 'abandoned-cart',
    name: 'Shopify Cart Recovery',
    industry: 'shopify',
    description: '3-email abandoned cart sequence with discount code — wired directly to your Shopify store and live in 24 hours.',
    deliveryTime: '24 hours',
    price: '$97',
    rating: 4.8,
    reviews: 31,
    includes: ['Shopify webhook configured', 'Email templates branded', 'Discount code created', 'End-to-end test'],
    icon: ShoppingBag,
    color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
  },
  {
    id: 'rent-reminder',
    name: 'Rent Reminder Automation',
    industry: 'property-management',
    description: 'Monthly tenant reminders sent automatically on the 1st, pulling from your Airtable tenant database.',
    deliveryTime: '48 hours',
    price: '$79',
    rating: 4.9,
    reviews: 14,
    includes: ['Airtable connected', 'Schedule configured', 'Email template personalized', 'First reminder tested'],
    icon: Building2,
    color: 'text-blue-400 bg-blue-500/10 border-blue-500/20'
  },
  {
    id: 'order-fulfillment',
    name: 'Order Fulfillment Alerts',
    industry: 'shopify',
    description: 'Instant order confirmations to customers + warehouse team alerts for every new Shopify order.',
    deliveryTime: '24 hours',
    price: '$79',
    rating: 5.0,
    reviews: 27,
    includes: ['Shopify webhook live', 'Customer emails branded', 'Warehouse alerts set', 'Full test run'],
    icon: ShoppingBag,
    color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
  },
  {
    id: 'cleaning-turnover',
    name: 'Cleaning Turnover Workflow',
    industry: 'airbnb',
    description: 'Automatic cleaner notifications after checkout, with Slack alerts and completion tracking.',
    deliveryTime: '48 hours',
    price: '$79',
    rating: 4.7,
    reviews: 11,
    includes: ['Cleaner emails configured', 'Optional Slack alerts', 'Timing set', 'Tested with dummy checkout'],
    icon: Home,
    color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20'
  }
];

interface RequestModalProps {
  automation: typeof MANAGED_AUTOMATIONS[number];
  onClose: () => void;
}

function RequestModal({ automation, onClose }: RequestModalProps) {
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success'>('idle');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus('loading');

    const desc = notes.trim() || `Managed setup request for ${automation.name}`;
    const { data } = await supabase.from('managed_requests').insert({
      user_id: (await supabase.auth.getUser()).data.user?.id ?? undefined,
      template_id: automation.id,
      template_name: automation.name,
      request_type: 'setup',
      description: desc,
      contact_email: email.trim(),
      status: 'open'
    }).select('id').maybeSingle();

    if (data?.id) {
      fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/notify-managed-request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          requestId: data.id,
          templateName: automation.name,
          requestType: 'setup',
          contactEmail: email.trim(),
          description: desc,
        }),
      }).catch(() => {});
    }

    setStatus('success');
  }

  const Icon = automation.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl shadow-black/40 overflow-hidden">
        <div className="px-5 py-4 border-b border-border bg-muted/20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={cn('w-9 h-9 rounded-xl border flex items-center justify-center', automation.color)}>
              <Icon className="w-4.5 h-4.5" />
            </div>
            <div>
              <p className="text-sm font-semibold">{automation.name}</p>
              <p className="text-xs text-muted-foreground">{automation.price} · {automation.deliveryTime} delivery</p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-muted/50">
            <ChevronRight className="w-4 h-4 rotate-180" />
          </button>
        </div>

        {status === 'success' ? (
          <div className="p-6 text-center space-y-4">
            <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-7 h-7 text-emerald-400" />
            </div>
            <div>
              <h3 className="font-semibold mb-1">Request Sent!</h3>
              <p className="text-sm text-muted-foreground">We'll review your request and reach out within a few hours to confirm scope and get started.</p>
            </div>
            <Button onClick={onClose} className="w-full">Done</Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">What's included</p>
              {automation.includes.map(item => (
                <div key={item} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                  {item}
                </div>
              ))}
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5">Your email *</label>
              <input
                type="email"
                required
                placeholder="you@company.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-border bg-background focus:outline-none focus:border-primary transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5">Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
              <textarea
                rows={2}
                placeholder="Any specific tools you use, requirements, or questions..."
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="w-full px-3 py-2.5 text-sm rounded-lg border border-border bg-background focus:outline-none focus:border-primary transition-colors resize-none"
              />
            </div>
            <Button type="submit" disabled={!email.trim() || status === 'loading'} className="w-full gap-2 shadow-lg shadow-primary/20">
              <Sparkles className="w-4 h-4" />
              Request for {automation.price}
            </Button>
            <p className="text-xs text-muted-foreground text-center">No payment upfront. We confirm scope first.</p>
          </form>
        )}
      </div>
    </div>
  );
}

export function ManagedCatalog() {
  const [activeModal, setActiveModal] = useState<string | null>(null);
  const activeAutomation = MANAGED_AUTOMATIONS.find(a => a.id === activeModal);

  return (
    <section id="managed" className="py-24 relative">
      <div className="absolute inset-0 dot-pattern opacity-30" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] rounded-full bg-primary/4 blur-[150px] pointer-events-none" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-4">
            <Sparkles className="w-3 h-3" />
            Done For You Service
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            We build and run{' '}
            <span className="text-gradient">your automations</span>
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Don't want to touch n8n yourself? Our team configures, tests, and deploys your workflow for you — usually within 48 hours. You just describe what you need.
          </p>
        </div>

        {/* Trust bar */}
        <div className="flex flex-wrap justify-center gap-8 mb-12 text-sm text-muted-foreground">
          {[
            { icon: Shield, label: '30-day money-back guarantee' },
            { icon: Clock, label: '48-hour delivery SLA' },
            { icon: Users, label: 'Dedicated workflow engineer' },
            { icon: Star, label: '4.9 average rating' }
          ].map(item => (
            <div key={item.label} className="flex items-center gap-2">
              <item.icon className="w-4 h-4 text-primary flex-shrink-0" />
              {item.label}
            </div>
          ))}
        </div>

        {/* Catalog Grid */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5 mb-12">
          {MANAGED_AUTOMATIONS.map(automation => {
            const Icon = automation.icon;
            return (
              <div
                key={automation.id}
                className="group rounded-2xl border border-border bg-card p-5 flex flex-col gap-4 hover:border-primary/30 hover:shadow-lg hover:shadow-black/10 hover:-translate-y-0.5 transition-all duration-200"
              >
                {/* Header */}
                <div className="flex items-start gap-3">
                  <div className={cn('w-10 h-10 rounded-xl border flex items-center justify-center flex-shrink-0', automation.color)}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold leading-snug group-hover:text-primary transition-colors">
                      {automation.name}
                    </h3>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="flex items-center gap-0.5">
                        {[...Array(5)].map((_, i) => (
                          <Star
                            key={i}
                            className={cn(
                              'w-3 h-3',
                              i < Math.floor(automation.rating)
                                ? 'text-amber-400 fill-amber-400'
                                : 'text-border'
                            )}
                          />
                        ))}
                      </div>
                      <span className="text-xs text-muted-foreground">({automation.reviews})</span>
                    </div>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground leading-relaxed">{automation.description}</p>

                {/* Includes */}
                <div className="space-y-1.5">
                  {automation.includes.slice(0, 3).map(item => (
                    <div key={item} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                      {item}
                    </div>
                  ))}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between pt-1 border-t border-border mt-auto">
                  <div>
                    <p className="text-lg font-bold text-primary">{automation.price}</p>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="w-3 h-3" />
                      {automation.deliveryTime}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => setActiveModal(automation.id)}
                    className="gap-1.5 h-8 text-xs shadow-md shadow-primary/10"
                  >
                    <Sparkles className="w-3 h-3" />
                    Get Set Up
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom CTA */}
        <div className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/8 to-primary/3 p-8 flex flex-col sm:flex-row items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-4 h-4 text-primary" />
              <p className="font-semibold">Need something custom?</p>
            </div>
            <p className="text-sm text-muted-foreground max-w-md">
              Describe any workflow and we'll give you a quote. We've built automations for property management, hospitality, e-commerce, and more.
            </p>
          </div>
          <Link href="/builder" className="flex-shrink-0">
            <Button className="gap-2 shadow-lg shadow-primary/20 whitespace-nowrap">
              <Sparkles className="w-4 h-4" />
              Build & Request Custom Setup
              <ArrowRight className="w-4 h-4" />
            </Button>
          </Link>
        </div>
      </div>

      {activeAutomation && (
        <RequestModal
          automation={activeAutomation}
          onClose={() => setActiveModal(null)}
        />
      )}
    </section>
  );
}
