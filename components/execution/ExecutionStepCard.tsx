'use client';

import { AlertCircle, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StatusBadge } from './StatusBadge';
import { DurationBadge } from './DurationBadge';
import { NodeTypeIcon } from './NodeTypeIcon';
import { useExecutionStore } from '@/store/execution-store';
import type { ExecutionStep } from '@/lib/execution/types';

interface Props {
  step: ExecutionStep;
  isLast?: boolean;
}

export function ExecutionStepCard({ step, isLast = false }: Props) {
  const openDrawer = useExecutionStore((s: ReturnType<typeof useExecutionStore.getState>) => s.openDrawer);

  const isFailed = step.status === 'failed';

  return (
    <div className="relative flex gap-3">
      {/* Vertical connector line */}
      {!isLast && (
        <div
          className="absolute left-[18px] top-[36px] w-0.5 bg-border"
          style={{ height: 'calc(100% - 8px)' }}
        />
      )}

      {/* Node icon column */}
      <div className="flex-shrink-0 pt-1">
        <NodeTypeIcon nodeType={step.node_type} size="md" />
      </div>

      {/* Card body */}
      <button
        onClick={() => openDrawer(step)}
        className={cn(
          'flex-1 text-left rounded-lg border px-4 py-3 mb-3 transition-all',
          'hover:shadow-md hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isFailed
            ? 'border-red-200 bg-red-50/50 hover:border-red-300'
            : 'border-border bg-card hover:border-primary/30'
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {/* Node name + type */}
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium text-sm text-foreground truncate">
                {step.node_name}
              </span>
              <span className="text-xs text-muted-foreground truncate hidden sm:block">
                {step.node_type.split('.').pop()}
              </span>
            </div>

            {/* Status + duration row */}
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={step.status} size="sm" />
              {step.duration_ms !== null && (
                <>
                  <span className="text-muted-foreground text-xs">·</span>
                  <DurationBadge ms={step.duration_ms} />
                </>
              )}
              {step.attempt > 1 && (
                <>
                  <span className="text-muted-foreground text-xs">·</span>
                  <span className="text-xs text-muted-foreground">
                    Attempt {step.attempt}
                  </span>
                </>
              )}
            </div>

            {/* Error message */}
            {isFailed && step.error_message && (
              <div className="mt-2 flex items-start gap-1.5 text-red-600">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span className="text-xs line-clamp-2">{step.error_message}</span>
              </div>
            )}
          </div>

          {/* Chevron */}
          <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
        </div>
      </button>
    </div>
  );
}
