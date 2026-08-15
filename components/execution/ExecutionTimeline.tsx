'use client';

import { AlertCircle } from 'lucide-react';
import { ExecutionStepCard } from './ExecutionStepCard';
import { NodeDetailDrawer } from './NodeDetailDrawer';
import type { ExecutionStep } from '@/lib/execution/types';

interface Props {
  steps: ExecutionStep[];
  executionError?: string | null;
}

export function ExecutionTimeline({ steps, executionError }: Props) {
  if (steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="rounded-full bg-muted p-4 mb-4">
          <AlertCircle className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">No steps recorded</p>
        <p className="text-xs text-muted-foreground mt-1">
          This execution has not started or produced no node data yet.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-0 pl-1">
        {steps.map((step, i) => (
          <ExecutionStepCard
            key={step.id}
            step={step}
            isLast={i === steps.length - 1}
          />
        ))}
      </div>

      {executionError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-700">Execution failed</p>
              <p className="text-xs text-red-600 mt-0.5">{executionError}</p>
            </div>
          </div>
        </div>
      )}

      {/* Global drawer — lives here so it's portal'd above everything */}
      <NodeDetailDrawer />
    </>
  );
}
