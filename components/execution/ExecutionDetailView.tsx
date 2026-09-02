'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  CalendarClock,
  GitBranch,
  Layers,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { fetchExecutionDetail } from '@/lib/execution/client';
import { ExecutionTimeline } from '@/components/execution/ExecutionTimeline';
import { ExecutionMetricsBar } from '@/components/execution/ExecutionMetricsBar';
import { StatusBadge } from '@/components/execution/StatusBadge';
import { DurationBadge, formatDuration } from '@/components/execution/DurationBadge';
import type { ExecutionDetail, ExecutionMetrics, ExecutionStatus } from '@/lib/execution/types';

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

// Phase 9.4.3 Step G: only these are genuinely final -- an execution in any
// other state can still change, so only these stop live polling.
const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set(['success', 'failed', 'cancelled']);

const POLL_INTERVAL_MS = 3000;

/**
 * Client-side wrapper around the execution detail view, adding the live
 * refresh the server-rendered page never had (a running/waiting/paused
 * execution previously required a manual browser reload to show any
 * progress). Polls the same ownership-checked GET /api/executions/[id]
 * route the initial server render already used -- no new API surface, no
 * cross-tenant risk beyond what that route already enforces.
 *
 * Stops polling once the execution reaches a terminal status, and also
 * pauses while the tab is hidden (Page Visibility API) so a background tab
 * doesn't keep polling indefinitely.
 */
export function ExecutionDetailView({ initialExecution }: { initialExecution: ExecutionDetail }) {
  const [execution, setExecution] = useState(initialExecution);
  const [refreshing, setRefreshing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const executionIdRef = useRef(initialExecution.id);
  // Read inside the polling loop instead of the closed-over `execution`
  // state, which would otherwise be stale until the next render -- this
  // lets a single self-scheduling loop (started once on mount) correctly
  // stop itself the moment a fetch reports a terminal status, with no
  // dependency-driven effect re-runs and no risk of two timers racing.
  const statusRef = useRef(initialExecution.status);
  useEffect(() => { statusRef.current = execution.status; }, [execution.status]);

  useEffect(() => {
    executionIdRef.current = initialExecution.id;
    setExecution(initialExecution);
    statusRef.current = initialExecution.status;
  }, [initialExecution]);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (cancelled || TERMINAL_STATUSES.has(statusRef.current)) return;

      if (document.visibilityState === 'visible') {
        try {
          setRefreshing(true);
          const res = await fetchExecutionDetail(executionIdRef.current);
          if (!cancelled) {
            statusRef.current = res.execution.status;
            setExecution(res.execution);
          }
        } catch {
          // Transient fetch failure -- keep showing the last known state
          // and try again on the next tick rather than surfacing an error
          // for a background refresh.
        } finally {
          if (!cancelled) setRefreshing(false);
        }
      }
      // Reschedule regardless of visibility (a hidden tab just skips the
      // fetch above but still checks again later, so it resumes promptly
      // once visible) unless the execution just became terminal or this
      // effect was torn down.
      if (!cancelled && !TERMINAL_STATUSES.has(statusRef.current)) {
        timerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }

    if (!TERMINAL_STATUSES.has(statusRef.current)) {
      timerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
    };
    // Intentionally runs once per mounted execution id -- see statusRef
    // above for how it observes status changes without re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialExecution.id]);

  const execMetrics: ExecutionMetrics = {
    total_executions: 1,
    success_count: execution.status === 'success' ? 1 : 0,
    failed_count: execution.status === 'failed' ? 1 : 0,
    running_count: execution.status === 'running' ? 1 : 0,
    success_rate: execution.status === 'success' ? 100 : 0,
    avg_duration_ms: execution.duration_ms,
    p95_duration_ms: null,
    last_execution_at: execution.started_at,
  };

  const totalNodes = execution.steps.length;
  const failedNodes = execution.steps.filter((s) => s.status === 'failed').length;
  const avgNodeMs =
    totalNodes > 0
      ? execution.steps.filter((s) => s.duration_ms !== null).reduce((acc, s) => acc + (s.duration_ms ?? 0), 0) /
          execution.steps.filter((s) => s.duration_ms !== null).length || null
      : null;

  const isLive = !TERMINAL_STATUSES.has(execution.status);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full">
      <div>
        <Button variant="ghost" size="sm" asChild className="gap-1.5 -ml-2 text-muted-foreground">
          <Link href="/executions">
            <ArrowLeft className="h-3.5 w-3.5" />
            All executions
          </Link>
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card px-6 py-5">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <StatusBadge status={execution.status} />
              <span className="text-xs text-muted-foreground px-2 py-0.5 rounded bg-muted font-medium">
                {execution.mode === 'test' ? 'Test run' : 'Live run'}
              </span>
              {isLive && (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground" aria-live="polite">
                  <RefreshCw className={refreshing ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
                  Live
                </span>
              )}
            </div>
            <h1 className="text-xl font-semibold text-foreground mt-2 truncate">{execution.workflow_name}</h1>
            <p className="text-sm text-muted-foreground font-mono mt-0.5">{execution.id}</p>
          </div>

          {execution.duration_ms !== null && (
            <div className="text-right flex-shrink-0">
              <p className="text-3xl font-bold text-foreground tabular-nums">{formatDuration(execution.duration_ms)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Total duration</p>
            </div>
          )}
        </div>

        <Separator className="my-4" />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="flex items-start gap-2">
            <CalendarClock className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Started</p>
              <p className="text-sm font-medium">{formatDateTime(execution.started_at)}</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <CalendarClock className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Finished</p>
              <p className="text-sm font-medium">{execution.completed_at ? formatDateTime(execution.completed_at) : (isLive ? 'In progress…' : '—')}</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Layers className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Nodes</p>
              <p className="text-sm font-medium">
                {totalNodes} total{failedNodes > 0 ? `, ${failedNodes} failed` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Avg node time</p>
              <DurationBadge ms={avgNodeMs ?? null} className="text-sm font-medium text-foreground" />
            </div>
          </div>
        </div>

        {execution.status === 'failed' && execution.error_message && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold text-red-700">Execution error</p>
                <p className="text-xs text-red-600 mt-0.5">{execution.error_message}</p>
              </div>
            </div>
          </div>
        )}

        {execution.status === 'waiting' && (
          <div className="mt-4 rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <CalendarClock className="h-4 w-4 text-yellow-600 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-yellow-700">
                This execution is waiting (e.g. a scheduled delay) and will continue automatically.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2">
          <h2 className="text-sm font-semibold text-foreground mb-4">Node execution timeline</h2>
          <ExecutionTimeline steps={execution.steps} executionError={execution.error_message} />
        </div>

        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-foreground">This execution</h2>
          <ExecutionMetricsBar metrics={execMetrics} windowDays={0} />

          {execution.input_data && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Input data</h3>
              <div className="rounded-lg border bg-muted/30 p-3 max-h-48 overflow-y-auto">
                <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all">
                  {JSON.stringify(execution.input_data, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {execution.output_data && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Output data</h3>
              <div className="rounded-lg border bg-muted/30 p-3 max-h-48 overflow-y-auto">
                <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all">
                  {JSON.stringify(execution.output_data, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
