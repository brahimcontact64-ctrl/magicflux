'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle, Wifi, WifiOff } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useControlApi } from './use-control-api';
import { useAutoRefresh } from './use-auto-refresh';
import { WorkerDetailSheet } from './WorkerDetailSheet';
import type { Worker, RestartRequest } from './types';

const STATUS_OPTIONS = ['', 'healthy', 'degraded', 'draining', 'restarting', 'stopped', 'crashed'];

const STALE_THRESHOLD_MS = 90_000;

function isLive(w: Worker) {
  return Date.now() - new Date(w.heartbeat_at).getTime() < STALE_THRESHOLD_MS;
}

function statusColor(s: string) {
  const map: Record<string, string> = {
    healthy:    'text-emerald-400',
    degraded:   'text-amber-400',
    draining:   'text-blue-400',
    restarting: 'text-blue-400',
    stopped:    'text-muted-foreground',
    crashed:    'text-red-400',
  };
  return map[s] ?? 'text-muted-foreground';
}

function fmt(ts?: string | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

type WorkersResponse = {
  workers:         Worker[];
  liveCount:       number;
  stalledCount:    number;
  statusSummary:   Record<string, number>;
  restartRequests: RestartRequest[];
  generatedAt:     string;
};

type PendingAction = { kind: 'drain' | 'restart'; worker: Worker };

export function WorkersPanel() {
  const { get, post } = useControlApi();

  const [data, setData]             = useState<WorkersResponse | null>(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing]         = useState<string | null>(null);
  const [pending, setPending]       = useState<PendingAction | null>(null);
  const [filterStatus, setFilterStatus] = useState('');

  const [detailWorkerId, setDetailWorkerId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen]         = useState(false);

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams({ limit: '100' });
    if (filterStatus) params.set('status', filterStatus);
    return `/api/runtime/control/workers?${params.toString()}`;
  }, [filterStatus]);

  const load = useCallback(async (asRefresh = false) => {
    if (asRefresh) setRefreshing(true); else setLoading(true);
    const res = await get<WorkersResponse>(buildUrl());
    if (res) setData(res);
    setLoading(false);
    setRefreshing(false);
  }, [get, buildUrl]);

  useEffect(() => { void load(); }, [load]);
  useAutoRefresh(() => void load(true), 10_000);

  const execute = useCallback(async () => {
    if (!pending) return;
    const { kind, worker } = pending;
    setPending(null);
    setActing(worker.worker_id);
    try {
      const res = await post<Record<string, unknown>>(
        '/api/runtime/control/workers',
        { action: kind, workerId: worker.worker_id }
      );
      if (res) {
        toast.success(kind === 'drain' ? 'Worker draining…' : 'Restart requested');
        await load(true);
      } else {
        toast.error(`${kind} failed`);
      }
    } finally {
      setActing(null);
    }
  }, [pending, post, load]);

  if (loading) {
    return <div className='space-y-2'>{[...Array(4)].map((_, i) => <Skeleton key={i} className='h-20 rounded-lg' />)}</div>;
  }

  const workers = data?.workers ?? [];

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center gap-3'>
        <div className='flex items-center gap-2 text-xs'>
          <Wifi className='h-3.5 w-3.5 text-emerald-400' />
          <span className='text-muted-foreground'>Live: <strong>{data?.liveCount ?? 0}</strong></span>
          <WifiOff className='ml-2 h-3.5 w-3.5 text-red-400' />
          <span className='text-muted-foreground'>Stalled: <strong>{data?.stalledCount ?? 0}</strong></span>
        </div>
        <div className='flex-1' />
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className='h-8 w-40 text-xs'>
            <SelectValue placeholder='All statuses' />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map(s => (
              <SelectItem key={s || 'all'} value={s} className='text-xs'>
                {s || 'All statuses'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size='sm' variant='ghost' className='h-8 gap-1 text-xs' onClick={() => void load(true)} disabled={refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {workers.length === 0 ? (
        <div className='flex flex-col items-center gap-2 py-10'>
          <AlertTriangle className='h-8 w-8 text-muted-foreground/40' />
          <p className='text-sm text-muted-foreground'>No workers registered.</p>
        </div>
      ) : (
        <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
          {workers.map(w => (
            <div key={w.worker_id} className={`rounded-xl border bg-card p-4 ${!isLive(w) ? 'border-red-500/30 opacity-70' : 'border-border'}`}>
              <div className='flex items-start justify-between gap-2'>
                <div className='min-w-0'>
                  <button
                    className='truncate font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline text-left block max-w-full'
                    onClick={() => { setDetailWorkerId(w.worker_id); setDetailOpen(true); }}
                  >
                    {w.worker_id}
                  </button>
                  <p className={`mt-0.5 text-sm font-semibold ${statusColor(w.status)}`}>{w.status}</p>
                </div>
                {!isLive(w) && <WifiOff className='mt-0.5 h-4 w-4 shrink-0 text-red-400' />}
              </div>

              <div className='mt-3 grid grid-cols-2 gap-y-1.5 text-xs text-muted-foreground'>
                <span>Host: {w.hostname ?? '—'}</span>
                <span>PID: {w.pid ?? '—'}</span>
                <span>Jobs: {w.jobs_processed}</span>
                <span>Restarts: {w.restart_count}</span>
                <span>Concurrency: {w.concurrency}</span>
                <span>CPU: {w.cpu_load != null ? w.cpu_load.toFixed(2) : '—'}</span>
                <span className='col-span-2 truncate'>Heartbeat: {fmt(w.heartbeat_at)}</span>
                {w.queues.length > 0 && (
                  <span className='col-span-2 truncate'>Queues: {w.queues.join(', ')}</span>
                )}
                {w.last_error && (
                  <span className='col-span-2 truncate text-red-400'>{w.last_error}</span>
                )}
              </div>

              <div className='mt-3 flex gap-2'>
                <Button
                  size='sm' variant='outline' className='h-7 flex-1 text-xs'
                  disabled={acting === w.worker_id || w.status === 'draining' || w.status === 'stopped'}
                  onClick={() => setPending({ kind: 'drain', worker: w })}
                >
                  {acting === w.worker_id ? <Loader2 className='h-3 w-3 animate-spin' /> : 'Drain'}
                </Button>
                <Button
                  size='sm' variant='outline'
                  className='h-7 flex-1 text-xs border-amber-500/40 text-amber-400 hover:border-amber-500 hover:text-amber-300'
                  disabled={acting === w.worker_id}
                  onClick={() => setPending({ kind: 'restart', worker: w })}
                >
                  Restart
                </Button>
                <Button
                  size='sm' variant='ghost'
                  className='h-7 text-xs'
                  onClick={() => { setDetailWorkerId(w.worker_id); setDetailOpen(true); }}
                >
                  Detail
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(data?.restartRequests?.length ?? 0) > 0 && (
        <section className='rounded-xl border border-border bg-card p-4'>
          <h2 className='mb-3 text-sm font-semibold'>Pending Restart Requests</h2>
          <div className='space-y-1.5'>
            {data!.restartRequests.map(r => (
              <div key={r.id} className='flex items-center justify-between text-xs'>
                <span className='font-mono text-muted-foreground'>{r.worker_id}</span>
                <span>{r.reason}</span>
                <span className='text-muted-foreground'>{fmt(r.created_at)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <AlertDialog open={pending !== null} onOpenChange={open => { if (!open) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === 'drain' ? 'Drain Worker' : 'Request Worker Restart'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'drain'
                ? `Drain worker "${pending.worker.worker_id}"? It will finish current jobs then stop accepting new ones.`
                : `Request a restart for worker "${pending?.worker.worker_id}"? A restart request will be queued.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void execute()}>
              {pending?.kind === 'drain' ? 'Drain' : 'Request Restart'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <WorkerDetailSheet
        workerId={detailWorkerId}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
    </div>
  );
}
