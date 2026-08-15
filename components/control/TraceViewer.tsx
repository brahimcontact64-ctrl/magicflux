'use client';

import { useCallback, useState } from 'react';
import { Search, ChevronDown, ChevronRight, Clock, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useControlApi } from './use-control-api';
import type { Trace, TraceSpan, TracesResponse, TraceDetailResponse } from './types';

function statusColor(status: string) {
  switch (status) {
    case 'completed': case 'success': return 'text-emerald-400';
    case 'failed':    case 'error':   return 'text-red-400';
    case 'running':                   return 'text-blue-400';
    default:                          return 'text-muted-foreground';
  }
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed' || status === 'success')
    return <CheckCircle2 className='h-3.5 w-3.5 text-emerald-400' />;
  if (status === 'failed' || status === 'error')
    return <XCircle className='h-3.5 w-3.5 text-red-400' />;
  if (status === 'running')
    return <Loader2 className='h-3.5 w-3.5 text-blue-400 animate-spin' />;
  return <Clock className='h-3.5 w-3.5 text-muted-foreground' />;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000)   return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function SpanRow({ span, depth }: { span: TraceSpan; depth: number }) {
  const indent = depth * 16;
  const pct    = span.duration_ms !== null
    ? Math.min(100, Math.max(2, (span.duration_ms / 5000) * 100))
    : 0;

  return (
    <div className='flex items-center gap-2 py-1 text-xs hover:bg-muted/30 rounded px-1'>
      <div style={{ paddingLeft: indent }} className='flex items-center gap-1.5 w-48 shrink-0'>
        <StatusIcon status={span.status} />
        <span className='truncate text-foreground'>{span.name}</span>
      </div>
      <span className='w-16 shrink-0 text-muted-foreground text-right'>
        {formatDuration(span.duration_ms)}
      </span>
      <div className='flex-1 h-1.5 rounded bg-muted overflow-hidden'>
        <div
          className='h-full rounded bg-blue-500/60'
          style={{ width: `${pct}%` }}
        />
      </div>
      <Badge variant='outline' className={`text-[10px] px-1 py-0 ${statusColor(span.status)}`}>
        {span.kind}
      </Badge>
    </div>
  );
}

function buildSpanTree(spans: TraceSpan[]): Array<{ span: TraceSpan; depth: number }> {
  const byId = new Map(spans.map(s => [s.span_id, s]));
  const result: Array<{ span: TraceSpan; depth: number }> = [];

  function visit(span: TraceSpan, depth: number) {
    result.push({ span, depth });
    const children = spans.filter(s => s.parent_span_id === span.span_id);
    children.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
    for (const child of children) visit(child, depth + 1);
  }

  const roots = spans.filter(s => !s.parent_span_id || !byId.has(s.parent_span_id));
  roots.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
  for (const root of roots) visit(root, 0);

  return result;
}

function TraceRow({ trace, onSelect }: { trace: Trace; onSelect: (t: Trace) => void }) {
  const duration = trace.started_at && trace.completed_at
    ? new Date(trace.completed_at).getTime() - new Date(trace.started_at).getTime()
    : null;

  return (
    <div
      className='flex items-center gap-3 rounded-lg border border-border/50 bg-card px-3 py-2 text-xs hover:bg-muted/30 cursor-pointer'
      onClick={() => onSelect(trace)}
    >
      <StatusIcon status={trace.status} />
      <span className='font-mono text-muted-foreground w-32 shrink-0 truncate'>
        {trace.trace_id.slice(0, 12)}…
      </span>
      <span className={`w-20 shrink-0 ${statusColor(trace.status)}`}>{trace.status}</span>
      <span className='flex-1 truncate text-muted-foreground'>
        {trace.execution_id ?? trace.workflow_id ?? trace.correlation_id}
      </span>
      <span className='w-20 shrink-0 text-right text-muted-foreground'>
        {formatDuration(duration)}
      </span>
      <span className='w-28 shrink-0 text-right text-muted-foreground'>
        {new Date(trace.started_at).toLocaleTimeString()}
      </span>
      <ChevronRight className='h-3 w-3 shrink-0 text-muted-foreground' />
    </div>
  );
}

export function TraceViewer() {
  const { get } = useControlApi();

  const [query,       setQuery]       = useState('');
  const [status,      setStatus]      = useState('');
  const [traces,      setTraces]      = useState<Trace[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [selected,    setSelected]    = useState<Trace | null>(null);
  const [spans,       setSpans]       = useState<TraceSpan[]>([]);
  const [loadingSpans, setLoadingSpans] = useState(false);
  const [expanded,    setExpanded]    = useState(true);

  const search = useCallback(async () => {
    setLoading(true);
    setSelected(null);

    const params = new URLSearchParams({ limit: '50' });
    if (status) params.set('status', status);

    // Determine if query looks like an execution ID, workflow ID, or trace ID
    const trimmed = query.trim();
    if (trimmed) {
      // Check if it looks like a UUID
      const uuidPattern = /^[0-9a-f-]{32,}/i;
      if (uuidPattern.test(trimmed)) {
        // Try trace_id search first
        params.set('execution_id', trimmed);
      }
    }

    const res = await get<TracesResponse>(`/api/runtime/control/traces?${params}`);
    setTraces(res?.traces ?? []);
    setLoading(false);
  }, [get, query, status]);

  const selectTrace = useCallback(async (trace: Trace) => {
    setSelected(trace);
    setLoadingSpans(true);
    const res = await get<TraceDetailResponse>(`/api/runtime/control/traces?id=${encodeURIComponent(trace.trace_id)}`);
    setSpans(res?.spans ?? []);
    setLoadingSpans(false);
  }, [get]);

  const spanRows = buildSpanTree(spans);

  return (
    <div className='space-y-4'>
      {/* Search bar */}
      <div className='flex gap-2'>
        <div className='relative flex-1'>
          <Search className='absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground' />
          <Input
            placeholder='Search by execution ID, workflow ID…'
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void search()}
            className='pl-8 h-9 text-xs'
          />
        </div>
        <select
          value={status}
          onChange={e => setStatus(e.target.value)}
          className='h-9 rounded-md border border-input bg-transparent px-3 text-xs text-foreground'
        >
          <option value=''>All statuses</option>
          <option value='running'>Running</option>
          <option value='completed'>Completed</option>
          <option value='failed'>Failed</option>
          <option value='cancelled'>Cancelled</option>
        </select>
        <Button size='sm' className='h-9 text-xs' onClick={() => void search()} disabled={loading}>
          {loading ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Search'}
        </Button>
      </div>

      <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
        {/* Trace list */}
        <div className='space-y-1.5'>
          <div className='text-xs font-medium text-muted-foreground mb-2'>
            {traces.length} trace{traces.length !== 1 ? 's' : ''}
          </div>
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className='h-10 w-full rounded-lg' />
            ))
          ) : traces.length === 0 ? (
            <div className='rounded-lg border border-border/50 bg-card p-6 text-center text-xs text-muted-foreground'>
              No traces found. Click Search to load recent traces.
            </div>
          ) : (
            traces.map(t => (
              <TraceRow
                key={t.trace_id}
                trace={t}
                onSelect={selectTrace}
              />
            ))
          )}
        </div>

        {/* Span detail */}
        <div className='rounded-xl border border-border bg-card p-4'>
          {!selected ? (
            <div className='flex h-48 items-center justify-center text-xs text-muted-foreground'>
              Select a trace to view spans
            </div>
          ) : (
            <div className='space-y-3'>
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-2'>
                  <button onClick={() => setExpanded(v => !v)}>
                    {expanded
                      ? <ChevronDown className='h-4 w-4' />
                      : <ChevronRight className='h-4 w-4' />}
                  </button>
                  <span className='text-xs font-medium'>
                    {selected.trace_id.slice(0, 20)}…
                  </span>
                  <Badge variant='outline' className={`text-[10px] ${statusColor(selected.status)}`}>
                    {selected.status}
                  </Badge>
                </div>
                <span className='text-xs text-muted-foreground'>
                  {spanRows.length} span{spanRows.length !== 1 ? 's' : ''}
                </span>
              </div>

              {expanded && (
                <div className='space-y-0.5 max-h-80 overflow-y-auto'>
                  {loadingSpans ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className='h-6 w-full rounded' />
                    ))
                  ) : spanRows.length === 0 ? (
                    <div className='py-4 text-center text-xs text-muted-foreground'>No spans</div>
                  ) : (
                    spanRows.map(({ span, depth }) => (
                      <SpanRow key={span.span_id} span={span} depth={depth} />
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
