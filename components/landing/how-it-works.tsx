'use client';

import Link from 'next/link';
import { MessageSquare, Cpu, Download, Sparkles, ArrowRight, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

const DIY_STEPS = [
  {
    step: '01',
    icon: MessageSquare,
    title: 'Describe Your Automation',
    description: 'Type what you want to automate in plain English — no technical knowledge required. Our AI understands business workflows naturally.',
    example: '"Send rent reminders to all tenants on the 1st of each month"',
    color: 'from-blue-500/20 to-blue-500/5',
    iconColor: 'text-blue-400'
  },
  {
    step: '02',
    icon: Cpu,
    title: 'AI Generates & Visualizes',
    description: 'The AI engine matches your intent, generates a complete workflow, and renders a live visual canvas showing every node and connection.',
    example: 'Live visual canvas + required integrations + package score',
    color: 'from-cyan-500/20 to-cyan-500/5',
    iconColor: 'text-cyan-400'
  },
  {
    step: '03',
    icon: Download,
    title: 'Connect & Activate',
    description: 'Connect the integrations your workflow needs, run a safe test, then activate — it runs live on MagicFlux. No export, no self-hosting, no separate instance to set up.',
    example: 'Integration setup · safe test run · one-click activation',
    color: 'from-emerald-500/20 to-emerald-500/5',
    iconColor: 'text-emerald-400'
  }
];

const MANAGED_STEPS = [
  {
    step: '01',
    icon: MessageSquare,
    title: 'Describe What You Need',
    description: 'Tell us your workflow in plain English via the builder or the managed catalog. Pick the automation that fits and submit your request.',
    example: '"Automate my Airbnb guest messaging"',
    color: 'from-blue-500/20 to-blue-500/5',
    iconColor: 'text-blue-400'
  },
  {
    step: '02',
    icon: Sparkles,
    title: 'We Configure Everything',
    description: 'Our team builds and configures your workflow on MagicFlux, connecting Gmail, Slack, Shopify — whatever integrations it needs. No technical work on your end.',
    example: 'Workflow build · credential configuration · integration testing',
    color: 'from-primary/20 to-primary/5',
    iconColor: 'text-primary'
  },
  {
    step: '03',
    icon: Zap,
    title: 'Live in 48 Hours',
    description: 'We run an end-to-end test with your real data, activate the workflow, and hand it off with documentation. You\'re live within 48 hours.',
    example: 'Delivery confirmation · test results · 30-day support',
    color: 'from-emerald-500/20 to-emerald-500/5',
    iconColor: 'text-emerald-400'
  }
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24 relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <p className="text-xs font-medium text-primary uppercase tracking-widest mb-3">How It Works</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Two ways to automate your{' '}
            <span className="text-gradient">business</span>
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Build it yourself in minutes — or let our team handle everything from setup to go-live.
          </p>
        </div>

        {/* Mode tabs */}
        <div className="grid md:grid-cols-2 gap-8 lg:gap-12">
          {/* DIY Path */}
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center">
                <Download className="w-4 h-4 text-cyan-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold">Self-Serve Builder</h3>
                <p className="text-xs text-muted-foreground">Free · Deploy yourself</p>
              </div>
            </div>

            <div className="space-y-4">
              {DIY_STEPS.map((step, index) => (
                <div key={step.step} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className={cn(
                      'w-9 h-9 rounded-xl border border-border bg-gradient-to-b flex items-center justify-center flex-shrink-0',
                      step.color
                    )}>
                      <step.icon className={cn('w-4 h-4', step.iconColor)} />
                    </div>
                    {index < DIY_STEPS.length - 1 && (
                      <div className="w-px flex-1 bg-border mt-1 min-h-[24px]" />
                    )}
                  </div>
                  <div className="pb-5">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-mono text-muted-foreground">{step.step}</span>
                      <h4 className="text-sm font-semibold">{step.title}</h4>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed mb-2">{step.description}</p>
                    <div className="rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5">
                      <p className="text-xs text-muted-foreground font-mono">{step.example}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <Link href="/builder" className="inline-flex items-center gap-2 text-sm text-primary hover:underline font-medium mt-2">
              Start building free
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {/* Managed Path */}
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h3 className="text-base font-semibold">Managed Service</h3>
                <p className="text-xs text-muted-foreground">From $79 · We handle everything</p>
              </div>
            </div>

            <div className="space-y-4">
              {MANAGED_STEPS.map((step, index) => (
                <div key={step.step} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className={cn(
                      'w-9 h-9 rounded-xl border border-border bg-gradient-to-b flex items-center justify-center flex-shrink-0',
                      step.color
                    )}>
                      <step.icon className={cn('w-4 h-4', step.iconColor)} />
                    </div>
                    {index < MANAGED_STEPS.length - 1 && (
                      <div className="w-px flex-1 bg-border mt-1 min-h-[24px]" />
                    )}
                  </div>
                  <div className="pb-5">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-mono text-muted-foreground">{step.step}</span>
                      <h4 className="text-sm font-semibold">{step.title}</h4>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed mb-2">{step.description}</p>
                    <div className="rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5">
                      <p className="text-xs text-muted-foreground font-mono">{step.example}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <a href="#managed" className="inline-flex items-center gap-2 text-sm text-primary hover:underline font-medium mt-2">
              Browse managed catalog
              <ArrowRight className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>

        {/* Bottom note */}
        <div className="mt-14 text-center">
          <p className="text-sm text-muted-foreground">
            {/* Phase 9.5 Step L: rewrote -- see hero.tsx/footer.tsx for the
                same "powered by n8n" correction. */}
            Generated, connected, and run entirely on MagicFlux &middot; No separate instance to set up
          </p>
        </div>
      </div>
    </section>
  );
}
