'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, ChevronRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fetchExecutions } from '@/lib/execution/client';
import type { ExecutionRecord } from '@/lib/execution/types';

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CLS: Record<string, string> = {
  success:  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  failed:   'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  running:  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  waiting:  'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  paused:   'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  cancelled:'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium capitalize', STATUS_CLS[status] ?? STATUS_CLS.paused)}>
      {status}
    </span>
  );
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  workflowId: string;
  onSelect?: (execution: ExecutionRecord) => void;
  className?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RunHistory({ workflowId, onSelect, className }: Props) {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchExecutions({ workflow_id: workflowId }, 1, 20);
      setExecutions(result.executions);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load runs');
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Run History</span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={load} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {loading && !executions.length ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 rounded-md bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : executions.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 py-6 text-center">
          <p className="text-xs text-muted-foreground">No runs yet for this workflow.</p>
        </div>
      ) : (
        <div className="space-y-1">
          {executions.map((ex) => (
            <button
              key={ex.id}
              onClick={() => onSelect?.(ex)}
              className={cn(
                'w-full flex items-center gap-3 rounded-md border border-border/60 px-3 py-2.5',
                'bg-card hover:bg-muted/40 transition-colors text-left',
                onSelect ? 'cursor-pointer' : 'cursor-default',
              )}
            >
              <StatusBadge status={ex.status} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground truncate">
                  {ex.mode === 'test' ? 'Test run' : 'Live run'}
                  {ex.step_count > 0 && (
                    <span className="ml-1 text-muted-foreground font-normal">
                      · {ex.step_count} step{ex.step_count !== 1 ? 's' : ''}
                    </span>
                  )}
                </p>
                <p className="text-[10px] text-muted-foreground">{formatDate(ex.started_at)}</p>
              </div>
              <span className="text-[10px] text-muted-foreground flex-shrink-0">
                {formatDuration(ex.duration_ms)}
              </span>
              {onSelect && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
