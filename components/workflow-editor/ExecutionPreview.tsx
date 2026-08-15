'use client';

import { useMemo } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  GitBranch,
  Play,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NodeTypeIcon } from '@/components/execution/NodeTypeIcon';
import { cn } from '@/lib/utils';

import { compileWorkflow } from '@/lib/execution/compiler';
import type { WorkflowExecutionPlan, PlanStep } from '@/lib/execution/plan-types';
import type { WorkflowJson } from '@/lib/workflow-editor/types';
import { getNodeDef } from '@/lib/node-registry';

// ─── Props ────────────────────────────────────────────────────────────────────

interface ExecutionPreviewProps {
  workflow: WorkflowJson;
  onClose: () => void;
}

// ─── Step row ────────────────────────────────────────────────────────────────

function StepRow({ step, isLast }: { step: PlanStep; isLast: boolean }) {
  const def = getNodeDef(step.node.type);
  const label = def?.label ?? step.node.type.split('.').pop() ?? step.node.type;

  return (
    <div className="flex items-start gap-3">
      {/* Step number + connector line */}
      <div className="flex flex-col items-center flex-shrink-0">
        <div className="flex items-center justify-center w-6 h-6 rounded-full bg-muted border border-border text-[10px] font-bold text-muted-foreground">
          {step.stepIndex}
        </div>
        {!isLast && <div className="w-px flex-1 min-h-[20px] bg-border mt-1" />}
      </div>

      {/* Node info */}
      <div className="flex-1 pb-3 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <NodeTypeIcon nodeType={step.node.type} size="sm" className="flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground truncate">{step.node.name}</p>
            <p className="text-[10px] text-muted-foreground">{label}</p>
          </div>
          {def?.isTrigger && (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 ml-auto flex-shrink-0">
              Trigger
            </Badge>
          )}
        </div>

        {/* Depends on */}
        {step.dependsOn.length > 0 && (
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Runs after:{' '}
            <span className="font-mono">{step.dependsOn.join(', ')}</span>
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ExecutionPreview({ workflow, onClose }: ExecutionPreviewProps) {
  const plan: WorkflowExecutionPlan = useMemo(
    () => compileWorkflow({ nodes: workflow.nodes, connections: workflow.connections }),
    [workflow],
  );

  return (
    <div className="absolute inset-0 z-20 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-xl shadow-xl flex flex-col max-h-full">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0">
          <Play className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm text-foreground flex-1">Execution Preview</span>
          <span className="text-xs text-muted-foreground">{plan.steps.length} steps</span>
          <Button
            variant="ghost" size="sm"
            onClick={onClose}
            className="h-6 w-6 p-0"
            aria-label="Close preview"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Status banner */}
        <div
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-xs flex-shrink-0',
            plan.valid
              ? 'bg-emerald-500/5 border-b border-emerald-500/20 text-emerald-700 dark:text-emerald-400'
              : 'bg-destructive/5 border-b border-destructive/20 text-destructive',
          )}
        >
          {plan.valid
            ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
            : <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          }
          <span className="font-medium">
            {plan.valid ? 'Plan is valid — ready to execute' : `Plan has ${plan.errors.length} error${plan.errors.length !== 1 ? 's' : ''}`}
          </span>
        </div>

        {/* Errors */}
        {plan.errors.length > 0 && (
          <div className="px-4 py-2 space-y-1 border-b border-border bg-destructive/5 flex-shrink-0">
            {plan.errors.map((err, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[11px] text-destructive">
                <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                {err}
              </div>
            ))}
          </div>
        )}

        {/* Warnings */}
        {plan.warnings.length > 0 && (
          <div className="px-4 py-2 space-y-1 border-b border-border bg-amber-500/5 flex-shrink-0">
            {plan.warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                {w}
              </div>
            ))}
          </div>
        )}

        {/* Step list */}
        <div className="flex-1 overflow-y-auto px-4 pt-4 pb-2">
          {plan.steps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <CircleDot className="h-8 w-8 text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">No executable steps found.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Add at least one trigger and one action node.
              </p>
            </div>
          ) : (
            plan.steps.map((step, idx) => (
              <StepRow key={step.node.id} step={step} isLast={idx === plan.steps.length - 1} />
            ))
          )}

          {/* Cycle warning */}
          {plan.cycleNodeNames.length > 0 && (
            <div className="flex items-center gap-2 mt-2 p-2 rounded-lg bg-destructive/5 border border-destructive/20">
              <GitBranch className="h-3.5 w-3.5 text-destructive flex-shrink-0" />
              <p className="text-[11px] text-destructive">
                Cycle detected: {plan.cycleNodeNames.join(' → ')}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex items-center justify-between flex-shrink-0">
          <p className="text-[10px] text-muted-foreground">
            Execution is simulated — no real APIs are called.
          </p>
          <Button size="sm" variant="outline" onClick={onClose} className="h-7 text-xs px-3">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
