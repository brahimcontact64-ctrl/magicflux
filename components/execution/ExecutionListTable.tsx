'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  AlertCircle,
  Inbox,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from './StatusBadge';
import { DurationBadge } from './DurationBadge';
import { ExecutionFilterBar } from './ExecutionFilterBar';
import { useExecutionStore } from '@/store/execution-store';
import { fetchExecutions } from '@/lib/execution/client';
import type { ExecutionRecord, PaginatedExecutions } from '@/lib/execution/types';
import { cn } from '@/lib/utils';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function ExecutionRow({ execution }: { execution: ExecutionRecord }) {
  const router = useRouter();

  return (
    <tr
      onClick={() => router.push(`/executions/${execution.id}`)}
      className="group cursor-pointer hover:bg-muted/40 transition-colors"
    >
      <td className="py-3 px-4">
        <div className="font-medium text-sm text-foreground group-hover:text-primary transition-colors truncate max-w-[220px]">
          {execution.workflow_name}
        </div>
        <div className="text-xs text-muted-foreground font-mono mt-0.5">
          {execution.id.slice(0, 8)}…
        </div>
      </td>

      <td className="py-3 px-4">
        <StatusBadge status={execution.status} size="sm" />
      </td>

      <td className="py-3 px-4 text-xs text-muted-foreground">
        {execution.mode === 'test' ? (
          <span className="px-1.5 py-0.5 rounded bg-muted text-xs font-medium">Test</span>
        ) : (
          <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-xs font-medium border border-blue-100">Live</span>
        )}
      </td>

      <td className="py-3 px-4">
        <span className="text-sm">{execution.step_count}</span>
        {execution.failed_step_count > 0 && (
          <span className="ml-1.5 text-xs text-red-600">
            ({execution.failed_step_count} failed)
          </span>
        )}
      </td>

      <td className="py-3 px-4">
        <DurationBadge ms={execution.duration_ms} />
      </td>

      <td className="py-3 px-4 text-xs text-muted-foreground whitespace-nowrap">
        {formatDate(execution.started_at)}
      </td>
    </tr>
  );
}

function TableSkeleton() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i}>
          <td className="py-3 px-4"><Skeleton className="h-8 w-48" /></td>
          <td className="py-3 px-4"><Skeleton className="h-5 w-16" /></td>
          <td className="py-3 px-4"><Skeleton className="h-5 w-12" /></td>
          <td className="py-3 px-4"><Skeleton className="h-5 w-8"  /></td>
          <td className="py-3 px-4"><Skeleton className="h-5 w-14" /></td>
          <td className="py-3 px-4"><Skeleton className="h-5 w-28" /></td>
        </tr>
      ))}
    </>
  );
}

export function ExecutionListTable() {
  const { filters, page, setPage } = useExecutionStore();
  const [data,    setData   ] = useState<PaginatedExecutions | null>(null);
  const [error,   setError  ] = useState<string | null>(null);
  const [pending, startTrans] = useTransition();

  const load = useCallback(() => {
    setError(null);
    startTrans(async () => {
      try {
        const result = await fetchExecutions(filters, page);
        setData(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
      }
    });
  }, [filters, page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = data ? Math.ceil(data.total / data.page_size) : 0;

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <ExecutionFilterBar />

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                {['Workflow', 'Status', 'Mode', 'Steps', 'Duration', 'Started'].map(h => (
                  <th key={h} className="py-2.5 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pending || !data ? (
                <TableSkeleton />
              ) : error ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <AlertCircle className="h-5 w-5 text-destructive" />
                      <p className="text-sm text-muted-foreground">{error}</p>
                      <Button variant="outline" size="sm" onClick={load}>
                        <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : data.executions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <Inbox className="h-6 w-6 text-muted-foreground" />
                      <p className="text-sm font-medium">No executions found</p>
                      <p className="text-xs text-muted-foreground">
                        Run a workflow or adjust your filters.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                data.executions.map(ex => (
                  <ExecutionRow key={ex.id} execution={ex} />
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination footer */}
        {data && data.total > data.page_size && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/10">
            <span className="text-xs text-muted-foreground">
              {((page - 1) * data.page_size) + 1}–{Math.min(page * data.page_size, data.total)} of {data.total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline" size="icon"
                className="h-7 w-7"
                disabled={page <= 1 || pending}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className={cn('text-xs px-2', pending && 'opacity-50')}>
                {page} / {totalPages}
              </span>
              <Button
                variant="outline" size="icon"
                className="h-7 w-7"
                disabled={!data.has_next || pending}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
