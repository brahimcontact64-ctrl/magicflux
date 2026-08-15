'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, WifiOff } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { useControlApi } from './use-control-api';
import type { WorkerDetail } from './types';

const STALE_MS = 90_000;

function fmt(ts?: string | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
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

function cmdStatusColor(s: string) {
  const map: Record<string, string> = {
    pending:      'text-blue-400',
    processing:   'text-amber-400',
    acknowledged: 'text-emerald-400',
    failed:       'text-red-400',
    dead_letter:  'text-red-500',
  };
  return map[s] ?? 'text-muted-foreground';
}

export function WorkerDetailSheet({
  workerId,
  open,
  onClose,
}: {
  workerId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { get } = useControlApi();
  const [detail, setDetail] = useState<WorkerDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setDetail(null);
    const res = await get<WorkerDetail>(`/api/runtime/control/workers/${encodeURIComponent(id)}`);
    if (res) setDetail(res);
    setLoading(false);
  }, [get]);

  useEffect(() => {
    if (open && workerId) void load(workerId);
  }, [open, workerId, load]);

  const w       = detail?.worker;
  const isLive  = w ? Date.now() - new Date(w.heartbeat_at).getTime() < STALE_MS : false;

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent side='right' className='w-full max-w-md p-0 flex flex-col overflow-y-auto'>
        <SheetHeader className='px-5 pt-5 pb-3 border-b border-border'>
          <SheetTitle className='text-sm font-semibold'>Worker Detail</SheetTitle>
          {w && (
            <SheetDescription className='font-mono text-xs break-all'>
              {w.worker_id}
            </SheetDescription>
          )}
        </SheetHeader>

        {loading && (
          <div className='p-5 space-y-3'>
            {[...Array(5)].map((_, i) => <Skeleton key={i} className='h-8 w-full rounded' />)}
          </div>
        )}

        {!loading && !detail && (
          <p className='p-8 text-center text-xs text-muted-foreground'>Worker not found.</p>
        )}

        {!loading && detail && w && (
          <div className='flex-1 overflow-y-auto divide-y divide-border/50'>
            {/* Status */}
            <section className='px-5 py-4 space-y-3'>
              <div className='flex items-center justify-between'>
                <span className={`text-lg font-bold ${statusColor(w.status)}`}>{w.status}</span>
                {!isLive && (
                  <span className='flex items-center gap-1 text-xs text-red-400'>
                    <WifiOff className='h-3.5 w-3.5' /> Stale
                  </span>
                )}
              </div>
              <div className='grid grid-cols-2 gap-2 text-xs'>
                <div><p className='text-muted-foreground'>Host</p><p className='font-medium'>{w.hostname ?? '—'}</p></div>
                <div><p className='text-muted-foreground'>PID</p><p className='font-medium tabular-nums'>{w.pid ?? '—'}</p></div>
                <div><p className='text-muted-foreground'>Jobs Processed</p><p className='font-medium tabular-nums'>{w.jobs_processed}</p></div>
                <div><p className='text-muted-foreground'>Restarts</p><p className='font-medium tabular-nums'>{w.restart_count}</p></div>
                <div><p className='text-muted-foreground'>Concurrency</p><p className='font-medium tabular-nums'>{w.concurrency}</p></div>
                <div><p className='text-muted-foreground'>CPU Load</p><p className='font-medium tabular-nums'>{w.cpu_load != null ? w.cpu_load.toFixed(2) : '—'}</p></div>
                <div><p className='text-muted-foreground'>Memory</p><p className='font-medium tabular-nums'>{w.memory_mb != null ? `${w.memory_mb} MB` : '—'}</p></div>
                <div><p className='text-muted-foreground'>Last Heartbeat</p><p className='font-medium text-[11px]'>{fmt(w.heartbeat_at)}</p></div>
              </div>
              {(w.queues?.length ?? 0) > 0 && (
                <div className='text-xs'>
                  <p className='text-muted-foreground mb-1'>Queues</p>
                  <div className='flex flex-wrap gap-1'>
                    {w.queues.map(q => (
                      <span key={q} className='rounded border border-border px-1.5 py-0.5 font-mono text-[11px]'>{q}</span>
                    ))}
                  </div>
                </div>
              )}
              {(w.capabilities?.length ?? 0) > 0 && (
                <div className='text-xs'>
                  <p className='text-muted-foreground mb-1'>Capabilities</p>
                  <div className='flex flex-wrap gap-1'>
                    {w.capabilities.map(c => (
                      <span key={c} className='rounded border border-border px-1.5 py-0.5 font-mono text-[11px]'>{c}</span>
                    ))}
                  </div>
                </div>
              )}
              {w.last_error && (
                <p className='rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400'>
                  {w.last_error}
                </p>
              )}
            </section>

            {/* Active Incidents */}
            {detail.activeIncidents.length > 0 && (
              <section className='px-5 py-4'>
                <h3 className='mb-2 text-xs font-semibold text-amber-400'>Active Incidents ({detail.activeIncidents.length})</h3>
                <div className='space-y-1.5'>
                  {detail.activeIncidents.map(inc => (
                    <div key={inc.id} className='rounded border border-border px-3 py-2 text-xs'>
                      <p className='font-medium'>{inc.title}</p>
                      <p className='text-muted-foreground'>{inc.severity} · {inc.status}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Recent Commands */}
            {detail.recentCommands.length > 0 && (
              <section className='px-5 py-4'>
                <h3 className='mb-2 text-xs font-semibold'>Recent Commands ({detail.recentCommands.length})</h3>
                <div className='space-y-1'>
                  {detail.recentCommands.map(cmd => (
                    <div key={cmd.id} className='flex items-center justify-between text-xs'>
                      <span className='font-medium'>{cmd.command_type}</span>
                      <span className={`font-semibold ${cmdStatusColor(cmd.status)}`}>{cmd.status}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Restart History */}
            {detail.restartHistory.length > 0 && (
              <section className='px-5 py-4'>
                <h3 className='mb-2 text-xs font-semibold'>Restart History</h3>
                <div className='space-y-1.5'>
                  {detail.restartHistory.map(r => (
                    <div key={r.id} className='flex items-center justify-between text-xs'>
                      <span className='text-muted-foreground'>{r.reason}</span>
                      <span className={r.status === 'acknowledged' ? 'text-emerald-400' : 'text-muted-foreground'}>
                        {r.status}
                      </span>
                      <span className='text-muted-foreground text-[11px]'>{fmt(r.created_at)}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
