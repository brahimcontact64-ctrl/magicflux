'use client';

import Link from 'next/link';
import { Zap, ChartBar as BarChart2, FileCode2, Users, Settings, Store, ShieldAlert, ArrowLeft, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';

const ADMIN_MODULES = [
  {
    id: 'analytics',
    icon: BarChart2,
    title: 'Analytics',
    description: 'View automation generation stats, popular templates, and user activity',
    status: 'planned',
    color: 'text-blue-400',
    bg: 'bg-blue-500/10'
  },
  {
    id: 'templates',
    icon: FileCode2,
    title: 'Template Manager',
    description: 'Create, edit, and manage automation templates across all industries',
    status: 'planned',
    color: 'text-cyan-400',
    bg: 'bg-cyan-500/10'
  },
  {
    id: 'waitlist',
    icon: Users,
    title: 'Waitlist Manager',
    description: 'View and export waitlist signups, send announcements',
    status: 'planned',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10'
  },
  {
    id: 'marketplace',
    icon: Store,
    title: 'Template Marketplace',
    description: 'Manage public marketplace templates, pricing, and community submissions',
    status: 'planned',
    color: 'text-amber-400',
    bg: 'bg-amber-500/10'
  },
  {
    id: 'integrations',
    icon: Settings,
    title: 'Integrations',
    description: 'Configure n8n API connections, OpenAI settings, and webhook endpoints',
    status: 'planned',
    color: 'text-violet-400',
    bg: 'bg-violet-500/10'
  },
  {
    id: 'industries',
    icon: Store,
    title: 'Industry Manager',
    description: 'Add new industries, manage vertical templates, and configure routing',
    status: 'planned',
    color: 'text-rose-400',
    bg: 'bg-rose-500/10'
  }
];

const ROADMAP_ITEMS = [
  { label: 'Connect OpenAI GPT-4 for real AI matching', quarter: 'Q2 2025' },
  { label: 'n8n Cloud API integration for auto-deployment', quarter: 'Q2 2025' },
  { label: 'Template marketplace with community submissions', quarter: 'Q3 2025' },
  { label: 'Multi-agent workflow generation', quarter: 'Q3 2025' },
  { label: 'White-label enterprise builder', quarter: 'Q4 2025' },
  { label: 'Real-time workflow monitoring dashboard', quarter: 'Q4 2025' }
];

export default function AdminPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="h-14 border-b border-border bg-card/50 flex items-center px-6 gap-4">
        <Link href="/" className="flex items-center gap-2 group">
          <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center group-hover:scale-105 transition-transform">
            <Zap className="w-3.5 h-3.5 text-primary-foreground" fill="currentColor" />
          </div>
          <span className="font-semibold text-sm">AutoBuilder<span className="text-primary">AI</span></span>
        </Link>
        <div className="w-px h-4 bg-border" />
        <span className="text-xs text-muted-foreground px-2 py-0.5 rounded-md bg-muted border border-border">Admin</span>
        <div className="flex-1" />
        <ThemeToggle />
        <Link href="/">
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </Button>
        </Link>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-10">
        {/* Warning Banner */}
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-amber-500/30 bg-amber-500/10 mb-8">
          <ShieldAlert className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-400">Admin Panel — Development Mode</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              This admin structure is prepared for future functionality. All modules below are planned and will be implemented as the platform grows.
            </p>
          </div>
        </div>

        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-2">Platform Administration</h1>
          <p className="text-muted-foreground text-sm">
            Manage templates, view analytics, and configure platform settings.
          </p>
        </div>

        {/* Live modules */}
        <div className="mb-6">
          <Link href="/admin/requests">
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-5 flex items-center gap-4 hover:bg-primary/10 hover:-translate-y-0.5 transition-all duration-200 cursor-pointer">
              <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center flex-shrink-0">
                <Inbox className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <h3 className="text-sm font-semibold">Managed Requests</h3>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-primary/20 text-primary border border-primary/30 font-medium">Live</span>
                </div>
                <p className="text-xs text-muted-foreground">View and manage incoming managed service requests — update status, contact customers</p>
              </div>
              <ArrowLeft className="w-4 h-4 text-primary rotate-180 flex-shrink-0" />
            </div>
          </Link>
        </div>

        {/* Planned Modules Grid */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-12">
          {ADMIN_MODULES.map(module => (
            <div
              key={module.id}
              className="rounded-xl border border-border bg-card p-5 opacity-60 cursor-not-allowed select-none"
            >
              <div className={`w-9 h-9 rounded-lg ${module.bg} flex items-center justify-center mb-3`}>
                <module.icon className={`w-4.5 h-4.5 ${module.color}`} />
              </div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold">{module.title}</h3>
                <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border">
                  Planned
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{module.description}</p>
            </div>
          ))}
        </div>

        {/* Tech Integration Roadmap */}
        <div className="rounded-xl border border-border bg-card p-6 mb-8">
          <h2 className="text-base font-semibold mb-1">Integration Roadmap</h2>
          <p className="text-xs text-muted-foreground mb-5">
            Architecture is prepared for these future integrations. The mock generation layer will be replaced with real AI and n8n APIs.
          </p>

          <div className="space-y-3">
            {ROADMAP_ITEMS.map((item, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-border flex-shrink-0" />
                <span className="text-muted-foreground flex-1">{item.label}</span>
                <span className="text-xs text-muted-foreground font-mono">{item.quarter}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Architecture Notes */}
        <div className="rounded-xl border border-border bg-muted/20 p-5">
          <h3 className="text-sm font-semibold mb-3">Architecture Notes for Developers</h3>
          <div className="space-y-2 text-xs text-muted-foreground font-mono">
            {[
              '📁 lib/templates.ts → Replace with DB-driven template registry',
              '📁 lib/generator.ts → Replace matchTemplate() with OpenAI call',
              '📁 app/api/ → Add n8n deployment endpoint when API key available',
              '📁 lib/supabase.ts → Extend with template & user schemas',
              '📁 components/builder/ → OutputPanel ready for real-time streaming',
              '📁 app/admin/ → Wire up Supabase admin queries'
            ].map((note, i) => (
              <p key={i} className="leading-relaxed">{note}</p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
