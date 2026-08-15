'use client';

import { useCallback, useEffect, useState } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { useControlApi } from './use-control-api';
import type { ExecutionDetail, ExecutionEventRow, ExecutionCommand } from './types';

function fmt(ts?: string | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function statusColor(s: string) {
  const map: Record<string, string> = {
    running:      'text-emerald-400',
    waiting:      'text-blue-400',
    paused:       'text-amber-400',
    success:      'text-emerald-400',
    failed:       'text-red-400',
    cancelled:    'text-muted-foreground',
    pending:      'text-blue-400',
    processing:   'text-amber-400',
    acknowledged: 'text-emerald-400',
    dead_letter:  'text-red-500',
  };
  return map[s] ?? 'text-muted-foreground';
}

// Visual command timeline: pending → processing → acknowledged / failed / dead_letter
function CommandTimeline({ commands }: { commands: ExecutionCommand[] }) {
  if (commands.length === 0) return <p className='text-xs text-muted-foreground'>No commands.</p>;

  return (
    <div className='space-y-1.5'>
      {commands.map((cmd, idx) => (
        <div key={cmd.id} className='flex items-start gap-3 text-xs'>
          <div className='flex flex-col items-center'>
            <div className={`h-2 w-2 rounded-full ${
              cmd.status === 'acknowledged'  ? 'bg-emerald-400' :
              cmd.status === 'dead_letter'   ? 'bg-red-500'     :
              cmd.status === 'failed'        ? 'bg-red-400'     :
              cmd.status === 'processing'    ? 'bg-amber-400'   :
              'bg-blue-400'
            }`} />
            {idx < commands.length - 1 && (
              <div className='mt-1 h-3 w-px bg-border' />
            )}
          </div>
          <div className='flex-1 min-w-0 pb-1'>
            <div className='flex items-center justify-between gap-2'>
              <span className='font-medium truncate'>{cmd.command_type}</span>
              <span className={`shrink-0 font-semibold ${statusColor(cmd.status)}`}>{cmd.status}</span>
            </div>
            <div className='flex gap-3 text-muted-foreground text-[11px]'>
              <span>Seq {cmd.sequence_number}</span>
              <span>Retries: {cmd.retry_count}</span>
              {cmd.acknowledged_at && <span>Done: {fmt(cmd.acknowledged_at)}</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EventList({ events }: { events: ExecutionEventRow[] }) {
  if (events.length === 0) return <p className='text-xs text-muted-foreground'>No events.</p>;
  return (
    <div className='space-y-1'>
      {events.slice(0, 50).map(e => (
        <div key={e.id} className='flex items-center gap-3 text-xs'>
          <span className='w-8 shrink-0 tabular-nums text-muted-foreground'>#{e.sequence_number}</span>
          <span className='flex-1 font-medium'>{e.event_type}</span>
          <span className='shrink-0 text-muted-foreground text-[11px]'>{fmt(e.created_at)}</span>
        </div>
      ))}
      {events.length > 50 && (
        <p className='text-xs text-muted-foreground'>… and {events.length - 50} more</p>
      )}
    </div>
  );
}

export function ExecutionDetailModal({
  executionId,
  open,
  onClose,
}: {
  executionId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { get } = useControlApi();
  const [detail, setDetail] = useState<ExecutionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'timeline' | 'events' | 'snapshots' | 'incidents'>('timeline');

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setDetail(null);
    const res = await get<ExecutionDetail>(`/api/runtime/control/executions/${encodeURIComponent(id)}`);
    if (res) setDetail(res);
    setLoading(false);
  }, [get]);

  useEffect(() => {
    if (open && executionId) {
      setTab('timeline');
      void load(executionId);
    }
  }, [open, executionId, load]);

  const exec = detail?.execution;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className='max-w-2xl max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden'>
        <DialogHeader className='px-5 pt-5 pb-3 border-b border-border'>
          <DialogTitle className='text-sm'>Execution Detail</DialogTitle>
          <DialogDescription className='font-mono text-xs'>
            {executionId ?? '—'}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className='p-5 space-y-2'>
            {[...Array(6)].map((_, i) => <Skeleton key={i} className='h-6 w-full rounded' />)}
          </div>
        )}

        {!loading && !detail && (
          <p className='p-8 text-center text-xs text-muted-foreground'>Execution not found.</p>
        )}

        {!loading && detail && exec && (
          <div className='flex flex-col flex-1 overflow-hidden'>
            {/* Metadata strip */}
            <div className='grid grid-cols-2 gap-x-6 gap-y-1.5 border-b border-border px-5 py-3 text-xs sm:grid-cols-4'>
              <div>
                <p className='text-muted-foreground'>Status</p>
                <p className={`font-semibold ${statusColor(exec.status)}`}>{exec.status}</p>
              </div>
              <div>
                <p className='text-muted-foreground'>Workflow</p>
                <p className='font-mono'>{exec.workflow_id.slice(0, 8)}…</p>
              </div>
              <div>
                <p className='text-muted-foreground'>Started</p>
                <p>{fmt(exec.started_at)}</p>
              </div>
              <div>
                <p className='text-muted-foreground'>Retries</p>
                <p className='tabular-nums'>{exec.retry_count}</p>
              </div>
              {exec.error_message && (
                <div className='col-span-2 sm:col-span-4'>
                  <p className='text-muted-foreground'>Error</p>
                  <p className='text-red-400'>{exec.error_message}</p>
                </div>
              )}
            </div>

            {/* Tab bar */}
            <div className='flex border-b border-border px-5 text-xs'>
              {(['timeline', 'events', 'snapshots', 'incidents'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`py-2 px-3 border-b-2 transition-colors ${
                    tab === t
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                  {t === 'incidents' && detail.incidents.length > 0 && (
                    <span className='ml-1 rounded-full bg-amber-500/20 px-1.5 text-amber-400 text-[10px]'>
                      {detail.incidents.length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className='flex-1 overflow-y-auto px-5 py-4'>
              {tab === 'timeline' && <CommandTimeline commands={detail.commands} />}

              {tab === 'events' && <EventList events={detail.events} />}

              {tab === 'snapshots' && (
                detail.snapshots.length === 0
                  ? <p className='text-xs text-muted-foreground'>No snapshots.</p>
                  : (
                    <div className='space-y-2'>
                      {detail.snapshots.map(s => (
                        <div key={s.id} className='rounded border border-border px-3 py-2 text-xs'>
                          <div className='flex items-center justify-between'>
                            <span className='font-semibold'>v{s.snapshot_version} · {s.snapshot_type}</span>
                            <span className='text-muted-foreground text-[11px]'>{fmt(s.created_at)}</span>
                          </div>
                          {s.current_node_id && (
                            <p className='text-muted-foreground mt-1'>Node: {s.current_node_id}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )
              )}

              {tab === 'incidents' && (
                detail.incidents.length === 0
                  ? <p className='text-xs text-muted-foreground'>No related incidents.</p>
                  : (
                    <div className='space-y-2'>
                      {detail.incidents.map(inc => (
                        <div key={inc.id} className='rounded border border-border px-3 py-2 text-xs'>
                          <div className='flex items-center gap-2'>
                            <span className={`font-semibold ${
                              inc.severity === 'critical' ? 'text-red-400' :
                              inc.severity === 'high'     ? 'text-orange-400' :
                              inc.severity === 'medium'   ? 'text-amber-400' :
                              'text-blue-400'
                            }`}>{inc.severity}</span>
                            <span className='font-medium'>{inc.title}</span>
                          </div>
                          <p className='text-muted-foreground mt-0.5'>{inc.status} · {inc.incidentType}</p>
                        </div>
                      ))}
                    </div>
                  )
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
