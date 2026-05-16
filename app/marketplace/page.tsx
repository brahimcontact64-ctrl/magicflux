'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Zap, ArrowLeft, Search, Building2, Chrome as Home, ShoppingBag, ChevronRight, Clock, ChartBar as BarChart2, Star, Filter, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { AUTOMATION_TEMPLATES, INDUSTRIES, AutomationTemplate, Industry, Complexity } from '@/lib/templates';
import { cn } from '@/lib/utils';

const INDUSTRY_ICONS: Record<string, React.ElementType> = {
  Building2,
  Home,
  ShoppingBag
};

const COMPLEXITY_CONFIG: Record<Complexity, { label: string; color: string; dot: string }> = {
  beginner:     { label: 'Beginner',     color: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10', dot: 'bg-emerald-400' },
  intermediate: { label: 'Intermediate', color: 'text-amber-400 border-amber-500/30 bg-amber-500/10',       dot: 'bg-amber-400'   },
  advanced:     { label: 'Advanced',     color: 'text-rose-400 border-rose-500/30 bg-rose-500/10',           dot: 'bg-rose-400'    }
};

const INDUSTRY_ACCENT: Record<Industry, string> = {
  'property-management': 'from-blue-500/10 to-blue-600/5 border-blue-500/20',
  'airbnb':              'from-cyan-500/10 to-cyan-600/5 border-cyan-500/20',
  'shopify':             'from-emerald-500/10 to-emerald-600/5 border-emerald-500/20'
};

const INDUSTRY_DOT: Record<Industry, string> = {
  'property-management': 'bg-blue-400',
  'airbnb':              'bg-cyan-400',
  'shopify':             'bg-emerald-400'
};

function TemplateCard({ template }: { template: AutomationTemplate }) {
  const complexity = COMPLEXITY_CONFIG[template.complexity];
  const accentGradient = INDUSTRY_ACCENT[template.industry];

  return (
    <div className={cn(
      'group relative rounded-xl border bg-gradient-to-br p-5 flex flex-col gap-4 transition-all duration-200 hover:shadow-lg hover:shadow-black/10 hover:-translate-y-0.5',
      accentGradient
    )}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <h3 className="font-semibold text-sm leading-snug group-hover:text-primary transition-colors">
            {template.name}
          </h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2">
            {template.description}
          </p>
        </div>
        <span className={cn(
          'flex-shrink-0 text-xs px-2 py-0.5 rounded-full border font-medium',
          complexity.color
        )}>
          {complexity.label}
        </span>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Zap className="w-3 h-3" />
          {template.nodeCount} nodes
        </span>
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {template.estimatedSetupTime}
        </span>
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1.5">
        {template.tags.slice(0, 3).map(tag => (
          <span key={tag} className="text-xs px-2 py-0.5 rounded-md bg-background/60 border border-border text-muted-foreground">
            {tag}
          </span>
        ))}
      </div>

      {/* Action */}
      <Link href={`/builder?template=${template.id}`} className="block mt-auto">
        <Button size="sm" className="w-full gap-2 h-8 text-xs font-medium group-hover:shadow-md group-hover:shadow-primary/10 transition-all">
          <Zap className="w-3 h-3" />
          Use Template
          <ChevronRight className="w-3 h-3 ml-auto" />
        </Button>
      </Link>
    </div>
  );
}

function IndustrySection({ industry }: { industry: typeof INDUSTRIES[number] }) {
  const Icon = INDUSTRY_ICONS[industry.icon] || Building2;
  const dotColor = INDUSTRY_DOT[industry.id];

  return (
    <section>
      {/* Section Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 rounded-xl border border-border bg-card flex items-center justify-center flex-shrink-0">
          <Icon className="w-4.5 h-4.5 text-muted-foreground" />
        </div>
        <div>
          <h2 className="font-semibold text-base">{industry.name}</h2>
          <p className="text-xs text-muted-foreground">{industry.description}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className={cn('w-2 h-2 rounded-full', dotColor)} />
          <span className="text-xs text-muted-foreground">{industry.templates.length} automations</span>
        </div>
      </div>

      {/* Template Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {industry.templates.map(template => (
          <TemplateCard key={template.id} template={template} />
        ))}
      </div>
    </section>
  );
}

export default function MarketplacePage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterComplexity, setFilterComplexity] = useState<Complexity | 'all'>('all');
  const [filterIndustry, setFilterIndustry] = useState<Industry | 'all'>('all');

  const filteredIndustries = INDUSTRIES.map(ind => ({
    ...ind,
    templates: ind.templates.filter(t => {
      const matchesSearch = !searchQuery ||
        t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.tags.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchesComplexity = filterComplexity === 'all' || t.complexity === filterComplexity;
      return matchesSearch && matchesComplexity;
    })
  })).filter(ind => {
    if (filterIndustry !== 'all' && ind.id !== filterIndustry) return false;
    return ind.templates.length > 0;
  });

  const totalVisible = filteredIndustries.reduce((sum, i) => sum + i.templates.length, 0);

  return (
    <div className="min-h-screen bg-background">
      {/* Top Nav */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 group mr-2">
            <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center group-hover:scale-105 transition-transform">
              <Zap className="w-3.5 h-3.5 text-primary-foreground" fill="currentColor" />
            </div>
            <span className="font-semibold text-sm hidden sm:block">
              MagicFlux
            </span>
          </Link>

          <div className="w-px h-4 bg-border" />

          <Link href="/" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="hidden sm:block">Back</span>
          </Link>

          <div className="flex-1" />

          <ThemeToggle />

          <Link href="/builder">
            <Button size="sm" className="gap-1.5 text-xs font-medium">
              <Zap className="w-3 h-3" />
              Open Builder
            </Button>
          </Link>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Page Header */}
        <div className="mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-4">
            <Star className="w-3 h-3" />
            Template Marketplace
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
            Generated Workflow
            <span className="text-gradient"> Templates</span>
          </h1>
          <p className="text-muted-foreground max-w-2xl leading-relaxed">
            Browse {AUTOMATION_TEMPLATES.length} battle-tested n8n workflow templates across {INDUSTRIES.length} industries. Select any template to instantly generate your complete automation package.
          </p>
        </div>

        {/* Stats Bar */}
        <div className="grid grid-cols-3 sm:grid-cols-3 gap-4 mb-8 max-w-sm">
          <div className="text-center p-3 rounded-xl border border-border bg-card/50">
            <p className="text-xl font-bold text-gradient">{AUTOMATION_TEMPLATES.length}</p>
            <p className="text-xs text-muted-foreground">Templates</p>
          </div>
          <div className="text-center p-3 rounded-xl border border-border bg-card/50">
            <p className="text-xl font-bold text-gradient">{INDUSTRIES.length}</p>
            <p className="text-xs text-muted-foreground">Industries</p>
          </div>
          <div className="text-center p-3 rounded-xl border border-border bg-card/50">
            <p className="text-xl font-bold text-gradient">Free</p>
            <p className="text-xs text-muted-foreground">Forever</p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-8">
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search templates..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border border-border bg-card focus:outline-none focus:border-primary transition-colors"
            />
          </div>

          {/* Industry filter */}
          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            {(['all', ...INDUSTRIES.map(i => i.id)] as (Industry | 'all')[]).map(id => (
              <button
                key={id}
                onClick={() => setFilterIndustry(id)}
                className={cn(
                  'text-xs px-2.5 py-1 rounded-full border transition-all',
                  filterIndustry === id
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/20'
                )}
              >
                {id === 'all' ? 'All Industries' : INDUSTRIES.find(i => i.id === id)?.name || id}
              </button>
            ))}
          </div>

          {/* Complexity filter */}
          <div className="flex items-center gap-2 flex-wrap">
            {(['all', 'beginner', 'intermediate', 'advanced'] as (Complexity | 'all')[]).map(c => (
              <button
                key={c}
                onClick={() => setFilterComplexity(c)}
                className={cn(
                  'text-xs px-2.5 py-1 rounded-full border transition-all capitalize',
                  filterComplexity === c
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/20'
                )}
              >
                {c === 'all' ? 'All Levels' : c}
              </button>
            ))}
          </div>
        </div>

        {/* Results count */}
        {(searchQuery || filterComplexity !== 'all' || filterIndustry !== 'all') && (
          <p className="text-xs text-muted-foreground mb-6">
            Showing {totalVisible} template{totalVisible !== 1 ? 's' : ''}
            {searchQuery ? ` matching "${searchQuery}"` : ''}
          </p>
        )}

        {/* Industry Sections */}
        {filteredIndustries.length > 0 ? (
          <div className="space-y-12">
            {filteredIndustries.map(industry => (
              <IndustrySection key={industry.id} industry={industry} />
            ))}
          </div>
        ) : (
          <div className="text-center py-20 text-muted-foreground">
            <BarChart2 className="w-10 h-10 mx-auto mb-4 opacity-20" />
            <p className="font-medium">No templates found</p>
            <p className="text-sm mt-1">Try adjusting your search or filters</p>
          </div>
        )}

        {/* Bottom CTA */}
        <div className="mt-16 rounded-2xl border border-border bg-gradient-to-br from-primary/5 to-primary/10 p-8 text-center">
          <h3 className="text-xl font-semibold mb-2">Don't see what you need?</h3>
          <p className="text-muted-foreground text-sm mb-6 max-w-md mx-auto">
            Describe any workflow in plain English and our AI will generate a custom n8n automation package for you.
          </p>
          <Link href="/builder">
            <Button className="gap-2 font-medium shadow-lg shadow-primary/20">
              <Zap className="w-4 h-4" fill="currentColor" />
              Build Custom Automation
              <ExternalLink className="w-3.5 h-3.5" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
