'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Building2, Chrome as Home, ShoppingBag, ArrowRight, Clock, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { INDUSTRIES } from '@/lib/templates';
import { cn } from '@/lib/utils';

const INDUSTRY_ICONS: Record<string, React.ElementType> = {
  Building2,
  Home,
  ShoppingBag
};

const INDUSTRY_COLORS: Record<string, { bg: string; border: string; badge: string; icon: string }> = {
  'property-management': {
    bg: 'from-blue-500/10 to-blue-500/5',
    border: 'border-blue-500/20',
    badge: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    icon: 'bg-blue-500/20 text-blue-400'
  },
  'airbnb': {
    bg: 'from-cyan-500/10 to-cyan-500/5',
    border: 'border-cyan-500/20',
    badge: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
    icon: 'bg-cyan-500/20 text-cyan-400'
  },
  'shopify': {
    bg: 'from-emerald-500/10 to-emerald-500/5',
    border: 'border-emerald-500/20',
    badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    icon: 'bg-emerald-500/20 text-emerald-400'
  }
};

export function IndustryTemplates() {
  const [activeIndustry, setActiveIndustry] = useState('property-management');
  const activeData = INDUSTRIES.find(i => i.id === activeIndustry)!;
  const colors = INDUSTRY_COLORS[activeIndustry];
  const Icon = INDUSTRY_ICONS[activeData.icon];

  return (
    <section id="templates" className="py-24 relative">
      {/* Background */}
      <div className="absolute inset-0 dot-pattern opacity-20" />
      <div className="absolute inset-0 bg-gradient-to-b from-background via-transparent to-background" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-12">
          <p className="text-xs font-medium text-primary uppercase tracking-widest mb-3">Industry Templates</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Ready-to-deploy automations for{' '}
            <span className="text-gradient">your industry</span>
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Choose your vertical and generate a workflow tailored to your exact operations.
          </p>
        </div>

        {/* Industry Selector Tabs */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center mb-10">
          {INDUSTRIES.map(industry => {
            const IIcon = INDUSTRY_ICONS[industry.icon];
            const iColors = INDUSTRY_COLORS[industry.id];
            return (
              <button
                key={industry.id}
                onClick={() => setActiveIndustry(industry.id)}
                className={cn(
                  'flex items-center gap-3 px-5 py-3 rounded-xl border transition-all duration-200 text-left',
                  activeIndustry === industry.id
                    ? `bg-gradient-to-r ${iColors.bg} ${iColors.border} shadow-lg`
                    : 'border-border bg-card hover:border-border/80 hover:bg-muted/50'
                )}
              >
                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', iColors.icon)}>
                  <IIcon className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-sm font-medium">{industry.name}</p>
                  <p className="text-xs text-muted-foreground">{industry.templates.length} templates</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Templates Grid */}
        <div className="grid md:grid-cols-3 gap-5">
          {activeData.templates.map((template, index) => (
            <div
              key={template.id}
              className={cn(
                'rounded-2xl border bg-gradient-to-b p-6 card-hover group transition-all duration-300',
                colors.bg,
                colors.border
              )}
              style={{ animationDelay: `${index * 100}ms` }}
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-base leading-tight mb-1">{template.name}</h3>
                  <div className="flex items-center gap-2">
                    <span className={cn('text-xs px-2 py-0.5 rounded-full border capitalize', colors.badge)}>
                      {template.complexity}
                    </span>
                  </div>
                </div>
                <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0', colors.icon)}>
                  <Zap className="w-4 h-4" />
                </div>
              </div>

              {/* Description */}
              <p className="text-sm text-muted-foreground leading-relaxed mb-4">{template.description}</p>

              {/* Meta */}
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-5">
                <span className="flex items-center gap-1.5">
                  <Clock className="w-3 h-3" />
                  {template.estimatedSetupTime} setup
                </span>
                <span>{template.nodeCount} nodes</span>
              </div>

              {/* Tags */}
              <div className="flex flex-wrap gap-1.5 mb-5">
                {template.tags.slice(0, 3).map(tag => (
                  <span key={tag} className="text-xs px-2 py-0.5 rounded-md bg-muted/50 text-muted-foreground border border-border/50">
                    {tag}
                  </span>
                ))}
              </div>

              {/* CTA */}
              <Link href={`/builder?template=${template.id}`}>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-2 group-hover:border-primary/50 group-hover:text-primary transition-colors"
                >
                  Generate This Automation
                  <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              </Link>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="text-center mt-10">
          <Link href="/builder">
            <Button variant="outline" size="lg" className="gap-2">
              Browse All Templates
              <ArrowRight className="w-4 h-4" />
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}
