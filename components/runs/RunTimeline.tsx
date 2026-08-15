'use client';

import { cn } from '@/lib/utils';
import { NodeTypeIcon } from '@/components/execution/NodeTypeIcon';
import type { ExecutionStep } from '@/lib/execution/types';

// ─── Status color helpers ─────────────────────────────────────────────────────

const STEP_TRACK: Record<string, string> = {
  success:  'bg-emerald-500',
  failed:   'bg-red-500',
  running:  'bg-blue-400 animate-pulse',
  retrying: 'bg-yellow-400',
  cancelled:'bg-gray-400',
  skipped:  'bg-gray-300',
  queued:   'bg-gray-300',
};

const STEP_BADGE: Record<string, string> = {
  success:  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  failed:   'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  running:  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  retrying: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  cancelled:'bg-gray-100 text-gray-500',
  skipped:  'bg-gray-100 text-gray-400',
  queued:   'bg-gray-100 text-gray-400',
};

function formatDuration(ms: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  steps: ExecutionStep[];
  onSelectStep?: (step: ExecutionStep) => void;
  activeStepId?: string | null;
  className?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RunTimeline({ steps, onSelectStep, activeStepId, className }: Props) {
  if (steps.length === 0) {
    return (
      <div className={cn('rounded-md border border-dashed border-border/60 py-8 text-center', className)}>
        <p className="text-xs text-muted-foreground">No steps recorded.</p>
      </div>
    );
  }

  return (
    <ol className={cn('relative space-y-0', className)}>
      {steps.map((step, idx) => {
        const isLast = idx === steps.length - 1;
        const trackColor = STEP_TRACK[step.status] ?? STEP_TRACK.queued;
        const badgeColor = STEP_BADGE[step.status] ?? STEP_BADGE.queued;
        const isActive = activeStepId === step.id;

        return (
          <li key={step.id} className="relative flex gap-3 pb-0">
            {/* Vertical connector line */}
            {!isLast && (
              <div className="absolute left-[15px] top-7 bottom-0 w-px bg-border" />
            )}

            {/* Step dot */}
            <div className="flex flex-col items-center flex-shrink-0 pt-1">
              <div className={cn('h-[10px] w-[10px] rounded-full ring-2 ring-background flex-shrink-0', trackColor)} />
            </div>

            {/* Step card */}
            <button
              onClick={() => onSelectStep?.(step)}
              className={cn(
                'flex-1 flex items-center gap-2 rounded-md px-2.5 py-2 mb-1.5 text-left transition-colors',
                'border hover:bg-muted/40',
                isActive
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-border/50 bg-card',
                onSelectStep ? 'cursor-pointer' : 'cursor-default',
              )}
            >
              <NodeTypeIcon nodeType={step.node_type} size="sm" className="flex-shrink-0" />

              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground truncate">{step.node_name}</p>
                {step.error_message && (
                  <p className="text-[10px] text-destructive truncate">{step.error_message}</p>
                )}
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className={cn('rounded px-1 py-0.5 text-[9px] font-medium capitalize', badgeColor)}>
                  {step.status}
                </span>
                {step.duration_ms != null && (
                  <span className="text-[10px] text-muted-foreground">
                    {formatDuration(step.duration_ms)}
                  </span>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
