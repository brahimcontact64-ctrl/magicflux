'use client';

import { Zap, Clock, TrendingUp, Star, ChartBar as BarChart2 } from 'lucide-react';
import { PackageScore } from '@/lib/ai-engine/types';
import { cn } from '@/lib/utils';

interface PackageScoreCardProps {
  score: PackageScore;
  appliedCustomizations?: string[];
  className?: string;
}

const LABEL_COLORS: Record<string, string> = {
  Starter:      'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  Professional: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  Enterprise:   'bg-blue-500/10 text-blue-400 border-blue-500/30'
};

function ScoreBar({ value, max = 10, color }: { value: number; max?: number; color: string }) {
  const pct = Math.round((value / max) * 100);
  return (
    <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
      <div
        className={cn('h-full rounded-full transition-all duration-700', color)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function ScoreMetric({ icon: Icon, label, value, max, color, suffix = '' }: {
  icon: React.ElementType;
  label: string;
  value: number;
  max?: number;
  color: string;
  suffix?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className={cn('w-3 h-3', color)} />
          {label}
        </div>
        <span className={cn('text-xs font-semibold tabular-nums', color)}>
          {value}{suffix}{max ? `/${max}` : ''}
        </span>
      </div>
      <ScoreBar value={value} max={max || 100} color={color.replace('text-', 'bg-')} />
    </div>
  );
}

export function PackageScoreCard({ score, appliedCustomizations = [], className }: PackageScoreCardProps) {
  const labelColor = LABEL_COLORS[score.label] || LABEL_COLORS.Starter;

  return (
    <div className={cn('rounded-xl border border-border bg-card p-4 space-y-4', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center">
            <BarChart2 className="w-3.5 h-3.5 text-primary" />
          </div>
          <div>
            <p className="text-xs font-semibold">Package Score</p>
            <p className="text-xs text-muted-foreground">Automation quality analysis</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold tabular-nums">{score.automationScore}<span className="text-base text-muted-foreground">/10</span></p>
          <span className={cn('text-xs px-2 py-0.5 rounded-full border font-medium', labelColor)}>
            {score.label}
          </span>
        </div>
      </div>

      {/* Score Bars */}
      <div className="space-y-3">
        <ScoreMetric
          icon={Zap}
          label="Complexity"
          value={score.complexity}
          max={10}
          color="text-cyan-400"
        />
        <ScoreMetric
          icon={TrendingUp}
          label="Business Impact"
          value={score.businessImpact}
          max={10}
          color="text-emerald-400"
        />
        <ScoreMetric
          icon={Star}
          label="Automation Score"
          value={score.automationScore}
          max={10}
          color="text-amber-400"
        />
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2 pt-1 border-t border-border">
        <div className="text-center">
          <p className="text-sm font-semibold">{score.setupTime}m</p>
          <p className="text-xs text-muted-foreground">Setup time</p>
        </div>
        <div className="text-center border-x border-border">
          <p className="text-sm font-semibold">{score.timeToROI}</p>
          <p className="text-xs text-muted-foreground">Time to ROI</p>
        </div>
        <div className="text-center">
          <p className="text-sm font-semibold">{score.label}</p>
          <p className="text-xs text-muted-foreground">Tier</p>
        </div>
      </div>

      {/* Applied customizations */}
      {appliedCustomizations.length > 0 && (
        <div className="pt-1 border-t border-border">
          <p className="text-xs text-muted-foreground mb-1.5">Applied customizations:</p>
          <div className="flex flex-wrap gap-1">
            {appliedCustomizations.map((c, i) => (
              <span key={i} className="text-xs px-2 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20">
                + {c}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
