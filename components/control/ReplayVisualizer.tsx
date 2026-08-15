'use client';

import { useCallback, useState } from 'react';
import { Search, Loader2, Layers, ArrowRight, CheckCircle2, XCircle, Clock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useControlApi } from './use-control-api';
import type { ReplayResponse, ReplayCheckpoint, ExecutionEventRow, ExecutionCommand } from './types';

const EVENT_COLORS: Record<string, string> = {
  'execution.started':     'bg-blue-500',
  'execution.completed':   'bg-emerald-500',
  'execution.failed':      'bg-red-500',
  'execution.checkpointed': 'bg-purple-500',
  'node.started':          'bg-blue-400',
  'node.completed':        'bg-emerald-400',
  'node.failed':           'bg-red-400',
  'retry.started':         'bg-amber-400',
  'retry.completed':       'bg-amber-500',
};

function eventColor(type: string): string {
  return EVENT_COLORS[type] ?? 'bg-slate-400';
}

function statusIcon(status: string) {
  if (status === 'completed') return <CheckCircle2 className='h-3.5 w-3.5 text-emerald-400' />;
  if (status === 'failed')    return <XCircle       className='h-3.5 w-3.5 text-red-400' />;
  if (status === 'running' || status === 'processing')
    return <Loader2 className='h-3.5 w-3.5 text-blue-400 animate-spin' />;
  return <Clock className='h-3.5 w-3.5 text-muted-foreground' />;
}

function EventTimeline({ events }: { events: ExecutionEventRow[] }) {
  return (
    <div className='relative space-y-0.5 pl-6'>
      <div className='absolute left-2 top-0 bottom-0 w-px bg-border' />
      {events.map((ev, idx) => (
        <div key={ev.id} className='relative flex items-start gap-2 text-xs group'>
          <div className={`absolute left-[-16px] mt-1 h-2 w-2 rounded-full ring-2 ring-background ${eventColor(ev.event_type)}`} />
          <div className='flex-1 min-w-0'>
            <div className='flex items-center gap-2'>
              <span className='font-medium text-foreground'>{ev.event_type}</span>
              <span className='text-muted-foreground'>#{ev.sequence_number}</span>
            </div>
            <div className='text-muted-foreground mt-0.5'>
              {new Date(ev.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </div>
          </div>
          {idx < events.length - 1 && <ArrowRight className='h-3 w-3 shrink-0 mt-1 text-border' />}
        </div>
      ))}
    </div>
  );
}

function CheckpointList({ checkpoints }: { checkpoints: ReplayCheckpoint[] }) {
  return (
    <div className='space-y-2'>
      {checkpoints.map(cp => (
        <div
          key={cp.snapshotVersion}
          className='rounded-lg border border-purple-500/30 bg-purple-500/5 px-3 py-2 text-xs'
        >
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <Layers className='h-3.5 w-3.5 text-purple-400' />
              <span className='font-medium text-purple-300'>
                Checkpoint v{cp.snapshotVersion}
              </span>
              <Badge variant='outline' className='text-[10px] text-purple-300 border-purple-500/40'>
                {cp.snapshotType}
              </Badge>
            </div>
            <span className='text-muted-foreground'>
              {new Date(cp.createdAt).toLocaleTimeString()}
            </span>
          </div>
          {cp.currentNodeId && (
            <div className='mt-1 text-muted-foreground'>
              Node: <span className='text-foreground font-mono'>{cp.currentNodeId}</span>
            </div>
          )}
          <div className='mt-1 text-muted-foreground'>
            {cp.eventCount} event{cp.eventCount !== 1 ? 's' : ''} leading here
            {cp.eventTypes.length > 0 && (
              <span className='ml-1'>
                ({cp.eventTypes.slice(0, 3).join(', ')}{cp.eventTypes.length > 3 ? '…' : ''})
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function CommandList({ commands }: { commands: ExecutionCommand[] }) {
  return (
    <div className='space-y-1'>
      {commands.map(cmd => (
        <div key={cmd.id} className='flex items-center gap-2 rounded border border-border/50 bg-card px-3 py-1.5 text-xs'>
          {statusIcon(cmd.status)}
          <span className='font-medium'>{cmd.command_type}</span>
          <span className='text-muted-foreground'>#{cmd.sequence_number}</span>
          <span className='flex-1' />
          <Badge variant='outline' className='text-[10px]'>{cmd.status}</Badge>
          {cmd.retry_count > 0 && (
            <span className='text-amber-400'>×{cmd.retry_count}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function ReplayVisualizer() {
  const { get } = useControlApi();
  const [executionId, setExecutionId] = useState('');
  const [data,        setData]        = useState<ReplayResponse | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [activeTab,   setActiveTab]   = useState<'timeline' | 'checkpoints' | 'commands'>('timeline');

  const load = useCallback(async () => {
    const id = executionId.trim();
    if (!id) return;

    setLoading(true);
    const res = await get<ReplayResponse>(
      `/api/runtime/control/replay-visualizer?execution_id=${encodeURIComponent(id)}&include_incidents=true`
    );
    setData(res ?? null);
    setLoading(false);
  }, [get, executionId]);

  return (
    <div className='space-y-4'>
      {/* Search */}
      <div className='flex gap-2'>
        <div className='relative flex-1'>
          <Search className='absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground' />
          <Input
            placeholder='Execution ID…'
            value={executionId}
            onChange={e => setExecutionId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void load()}
            className='pl-8 h-9 text-xs font-mono'
          />
        </div>
        <Button size='sm' className='h-9 text-xs' onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Load'}
        </Button>
      </div>

      {loading && <Skeleton className='h-64 w-full rounded-xl' />}

      {!loading && data && (
        <div className='space-y-4'>
          {/* Execution header */}
          <div className='flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3'>
            {statusIcon(data.execution.status)}
            <div className='flex-1 min-w-0'>
              <div className='flex items-center gap-2 text-sm'>
                <span className='font-medium font-mono'>{data.execution.id.slice(0, 20)}…</span>
                <Badge variant='outline' className='text-xs'>{data.execution.status}</Badge>
              </div>
              <div className='text-xs text-muted-foreground mt-0.5'>
                {data.execution.started_at && new Date(data.execution.started_at).toLocaleString()}
                {data.execution.completed_at && (
                  <> → {new Date(data.execution.completed_at).toLocaleString()}</>
                )}
              </div>
            </div>
            <div className='text-right text-xs text-muted-foreground'>
              <div>{data.events.length} events</div>
              <div>{data.snapshots.length} snapshots</div>
              <div>{data.commands.length} commands</div>
            </div>
          </div>

          {/* Tabs */}
          <div className='flex gap-1 rounded-lg border border-border p-1 bg-muted/30 w-fit'>
            {(['timeline', 'checkpoints', 'commands'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1 rounded text-xs capitalize transition-colors ${
                  activeTab === tab
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab}
                <span className='ml-1.5 text-muted-foreground'>
                  {tab === 'timeline'    && `(${data.events.length})`}
                  {tab === 'checkpoints' && `(${data.checkpoints.length})`}
                  {tab === 'commands'    && `(${data.commands.length})`}
                </span>
              </button>
            ))}
          </div>

          {/* Content */}
          <div className='max-h-[500px] overflow-y-auto rounded-xl border border-border bg-card p-4'>
            {activeTab === 'timeline' && (
              data.events.length === 0
                ? <p className='text-xs text-muted-foreground'>No events recorded.</p>
                : <EventTimeline events={data.events} />
            )}
            {activeTab === 'checkpoints' && (
              data.checkpoints.length === 0
                ? <p className='text-xs text-muted-foreground'>No replay checkpoints recorded.</p>
                : <CheckpointList checkpoints={data.checkpoints} />
            )}
            {activeTab === 'commands' && (
              data.commands.length === 0
                ? <p className='text-xs text-muted-foreground'>No commands recorded.</p>
                : <CommandList commands={data.commands} />
            )}
          </div>
        </div>
      )}

      {!loading && !data && (
        <div className='rounded-xl border border-border bg-card p-8 text-center text-xs text-muted-foreground'>
          Enter an execution ID to visualize its replay timeline, checkpoints, and commands.
        </div>
      )}
    </div>
  );
}
