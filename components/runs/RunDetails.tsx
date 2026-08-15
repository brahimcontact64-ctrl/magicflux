'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Clock, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fetchExecutionDetail, retryExecution } from '@/lib/execution/client';
import { RunTimeline } from './RunTimeline';
import type { ExecutionDetail, ExecutionStep } from '@/lib/execution/types';

const RETRYABLE_STATUSES = new Set(['failed', 'cancelled', 'paused']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ─── Step detail drawer ───────────────────────────────────────────────────────

function StepDetail({ step, onClose }: { step: ExecutionStep; onClose: () => void }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-foreground">{step.node_name}</p>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      {step.error_message && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-2.5 py-2">
          <p className="text-[11px] text-destructive">{step.error_message}</p>
        </div>
      )}

      {step.logs.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Logs</p>
          <div className="rounded-md bg-muted/40 px-2.5 py-1.5 space-y-0.5">
            {step.logs.map((line, i) => (
              <p key={i} className="font-mono text-[10px] text-foreground/80">{line}</p>
            ))}
          </div>
        </div>
      )}

      {step.output_data && (
        <div className="space-y-0.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Output</p>
          <pre className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[10px] font-mono overflow-x-auto max-h-32 text-foreground/80">
            {JSON.stringify(step.output_data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  executionId: string;
  onBack?: () => void;
  className?: string;
}

// ─── Status icon ─────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: string }) {
  if (status === 'success') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === 'failed') return <XCircle className="h-4 w-4 text-red-500" />;
  return <Clock className="h-4 w-4 text-muted-foreground" />;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RunDetails({ executionId, onBack, className }: Props) {
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<ExecutionStep | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchExecutionDetail(executionId);
      setDetail(result.execution);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load run details');
    } finally {
      setLoading(false);
    }
  }, [executionId]);

  useEffect(() => { load(); }, [load]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await retryExecution(executionId);
      await load();
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : 'Failed to retry run');
    } finally {
      setRetrying(false);
    }
  }, [executionId, load]);

  if (loading) {
    return (
      <div className={cn('flex items-center justify-center py-12', className)}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className={cn('space-y-3', className)}>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="h-7 text-xs">
            <ArrowLeft className="mr-1.5 h-3 w-3" /> Back
          </Button>
        )}
        <p className="text-xs text-destructive">{error ?? 'Run not found.'}</p>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Header */}
      <div className="flex items-start gap-3">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="h-7 text-xs mt-0.5 flex-shrink-0">
            <ArrowLeft className="mr-1 h-3 w-3" /> Back
          </Button>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <StatusIcon status={detail.status} />
            <p className="text-sm font-semibold text-foreground capitalize">{detail.status}</p>
            <span className="text-xs text-muted-foreground">
              · {detail.mode} · {formatDuration(detail.duration_ms)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{formatDate(detail.started_at)}</p>
        </div>
        {RETRYABLE_STATUSES.has(detail.status) && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRetry}
            disabled={retrying}
            className="h-7 text-xs flex-shrink-0"
          >
            {retrying ? (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="mr-1.5 h-3 w-3" />
            )}
            Retry
          </Button>
        )}
      </div>

      {/* Error summary */}
      {detail.error_message && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
          <p className="text-xs text-destructive">{detail.error_message}</p>
        </div>
      )}

      {retryError && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
          <p className="text-xs text-destructive">Retry failed: {retryError}</p>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Steps', value: detail.step_count },
          { label: 'Failed', value: detail.failed_step_count },
          { label: 'Retries', value: detail.retry_count },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-center">
            <p className="text-lg font-semibold text-foreground">{value}</p>
            <p className="text-[10px] text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      {/* Step detail (when selected) */}
      {activeStep && (
        <StepDetail step={activeStep} onClose={() => setActiveStep(null)} />
      )}

      {/* Timeline */}
      {detail.steps.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Execution Timeline</p>
          <RunTimeline
            steps={detail.steps}
            onSelectStep={setActiveStep}
            activeStepId={activeStep?.id ?? null}
          />
        </div>
      )}
    </div>
  );
}
