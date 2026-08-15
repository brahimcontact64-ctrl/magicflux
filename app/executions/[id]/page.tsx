import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import Link from 'next/link';
import {
  ArrowLeft,
  CalendarClock,
  GitBranch,
  Layers,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { getUserFromRequest } from '@/lib/supabase-server';
import { fetchExecutionDetail } from '@/lib/execution/client';
import { ExecutionTimeline } from '@/components/execution/ExecutionTimeline';
import { ExecutionMetricsBar } from '@/components/execution/ExecutionMetricsBar';
import { StatusBadge } from '@/components/execution/StatusBadge';
import { DurationBadge, formatDuration } from '@/components/execution/DurationBadge';
import type { ExecutionMetrics } from '@/lib/execution/types';

type Ctx = { params: { id: string } };

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium', timeStyle: 'medium',
  });
}

export default async function ExecutionDetailPage({ params }: Ctx) {
  // Auth guard
  const req = { headers: Object.fromEntries((await headers()).entries()) };
  const user = await getUserFromRequest(req as never);
  if (!user) redirect('/login');

  // Fetch execution data (server-side)
  let execution;
  try {
    const res = await fetchExecutionDetail(params.id);
    execution = res.execution;
  } catch {
    notFound();
  }

  // Build per-execution metrics for the metrics bar
  const execMetrics: ExecutionMetrics = {
    total_executions:  1,
    success_count:     execution.status === 'success' ? 1 : 0,
    failed_count:      execution.status === 'failed'  ? 1 : 0,
    running_count:     execution.status === 'running' ? 1 : 0,
    success_rate:      execution.status === 'success' ? 100 : 0,
    avg_duration_ms:   execution.duration_ms,
    p95_duration_ms:   null,
    last_execution_at: execution.started_at,
  };

  // Node-level stats
  const totalNodes  = execution.steps.length;
  const failedNodes = execution.steps.filter(s => s.status === 'failed').length;
  const avgNodeMs   = totalNodes > 0
    ? execution.steps
        .filter(s => s.duration_ms !== null)
        .reduce((acc, s) => acc + (s.duration_ms ?? 0), 0)
          / execution.steps.filter(s => s.duration_ms !== null).length || null
    : null;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full">
      {/* Back navigation */}
      <div>
        <Button variant="ghost" size="sm" asChild className="gap-1.5 -ml-2 text-muted-foreground">
          <Link href="/executions">
            <ArrowLeft className="h-3.5 w-3.5" />
            All executions
          </Link>
        </Button>
      </div>

      {/* Execution header card */}
      <div className="rounded-xl border border-border bg-card px-6 py-5">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <StatusBadge status={execution.status} />
              <span className="text-xs text-muted-foreground px-2 py-0.5 rounded bg-muted font-medium">
                {execution.mode === 'test' ? 'Test run' : 'Live run'}
              </span>
            </div>
            <h1 className="text-xl font-semibold text-foreground mt-2 truncate">
              {execution.workflow_name}
            </h1>
            <p className="text-sm text-muted-foreground font-mono mt-0.5">
              {execution.id}
            </p>
          </div>

          {execution.duration_ms !== null && (
            <div className="text-right flex-shrink-0">
              <p className="text-3xl font-bold text-foreground tabular-nums">
                {formatDuration(execution.duration_ms)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">Total duration</p>
            </div>
          )}
        </div>

        <Separator className="my-4" />

        {/* Meta row */}
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
              <p className="text-sm font-medium">{formatDateTime(execution.completed_at)}</p>
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

        {/* Execution-level error */}
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
      </div>

      {/* Two-column layout: timeline (left) + summary metrics (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Timeline — takes 2 columns */}
        <div className="lg:col-span-2">
          <h2 className="text-sm font-semibold text-foreground mb-4">Node execution timeline</h2>
          {/* This is a client component — renders the drawer too */}
          <ExecutionTimeline
            steps={execution.steps}
            executionError={execution.error_message}
          />
        </div>

        {/* Sidebar: per-execution stats */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-foreground">This execution</h2>
          <ExecutionMetricsBar metrics={execMetrics} windowDays={0} />

          {/* Input data preview */}
          {execution.input_data && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Input data
              </h3>
              <div className="rounded-lg border bg-muted/30 p-3 max-h-48 overflow-y-auto">
                <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all">
                  {JSON.stringify(execution.input_data, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {/* Output data preview */}
          {execution.output_data && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Output data
              </h3>
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
