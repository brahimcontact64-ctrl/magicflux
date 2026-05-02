'use client';

import { Building2, Chrome as Home, ShoppingBag, ChevronRight } from 'lucide-react';
import { INDUSTRIES, AutomationTemplate, Industry } from '@/lib/templates';
import { cn } from '@/lib/utils';

const ICONS: Record<string, React.ElementType> = { Building2, Home, ShoppingBag };

const INDUSTRY_COLORS: Record<Industry, { active: string; icon: string; dot: string }> = {
  'property-management': {
    active: 'border-blue-500/40 bg-blue-500/10',
    icon: 'bg-blue-500/20 text-blue-400',
    dot: 'bg-blue-400'
  },
  'airbnb': {
    active: 'border-cyan-500/40 bg-cyan-500/10',
    icon: 'bg-cyan-500/20 text-cyan-400',
    dot: 'bg-cyan-400'
  },
  'shopify': {
    active: 'border-emerald-500/40 bg-emerald-500/10',
    icon: 'bg-emerald-500/20 text-emerald-400',
    dot: 'bg-emerald-400'
  }
};

interface IndustrySelectorProps {
  selectedIndustry: Industry | null;
  selectedTemplate: AutomationTemplate | null;
  onSelectIndustry: (industry: Industry) => void;
  onSelectTemplate: (template: AutomationTemplate) => void;
}

export function IndustrySelector({
  selectedIndustry,
  selectedTemplate,
  onSelectIndustry,
  onSelectTemplate
}: IndustrySelectorProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1 mb-3">
        Quick Templates
      </p>

      {INDUSTRIES.map(industry => {
        const Icon = ICONS[industry.icon];
        const colors = INDUSTRY_COLORS[industry.id];
        const isActiveIndustry = selectedIndustry === industry.id;

        return (
          <div key={industry.id} className="space-y-1">
            {/* Industry Header */}
            <button
              onClick={() => onSelectIndustry(industry.id)}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-all duration-150',
                isActiveIndustry ? colors.active : 'border-transparent hover:bg-muted/50'
              )}
            >
              <div className={cn('w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0', colors.icon)}>
                <Icon className="w-3.5 h-3.5" />
              </div>
              <span className="text-sm font-medium flex-1 truncate">{industry.name}</span>
              <ChevronRight className={cn('w-3.5 h-3.5 text-muted-foreground transition-transform', isActiveIndustry && 'rotate-90')} />
            </button>

            {/* Templates (shown when industry is selected) */}
            {isActiveIndustry && (
              <div className="ml-3 space-y-0.5 border-l border-border pl-3">
                {industry.templates.map(template => (
                  <button
                    key={template.id}
                    onClick={() => onSelectTemplate(template)}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-all text-xs',
                      selectedTemplate?.id === template.id
                        ? 'bg-primary/15 text-primary font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    )}
                  >
                    <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', selectedTemplate?.id === template.id ? colors.dot : 'bg-border')} />
                    <span className="truncate">{template.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
