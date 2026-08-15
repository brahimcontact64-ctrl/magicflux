'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useControlApi } from './use-control-api';
import { useAutoRefresh } from './use-auto-refresh';
import type { ExecutionCommand } from './types';

const STATUS_OPTIONS = ['', 'pending', 'processing', 'acknowledged', 'failed', 'dead_letter'];

const STATUS_FLOW: Record<string, string[]> = {
  pending:      ['processing', 'failed', 'dead_letter'],
  processing:   ['acknowledged', 'failed', 'dead_letter'],
  acknowledged: [],
  failed:       ['pending', 'dead_letter'],
  dead_letter:  [],
};

function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending:      'border-blue-500/40 bg-blue-500/10 text-blue-400',
    processing:   'border-amber-500/40 bg-amber-500/10 text-amber-400',
    acknowledged: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
    failed:       'border-red-500/40 bg-red-500/10 text-red-400',
    dead_letter:  'border-red-700/40 bg-red-700/10 text-red-500',
  };
  return map[status] ?? 'border-border text-muted-foreground';
}

function TimelineDot({ status }: { status: string }) {
  const color: Record<string, string> = {
    pending:      'bg-blue-400',
    processing:   'bg-amber-400',
    acknowledged: 'bg-emerald-400',
    failed:       'bg-red-400',
    dead_letter:  'bg-red-600',
  };
  return <span className={`inline-block h-2 w-2 rounded-full ${color[status] ?? 'bg-muted-foreground'}`} />;
}

function fmt(ts?: string | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

type CommandsResponse = { commands: ExecutionCommand[]; count: number };

type PendingAction =
  | { kind: 'retry';        cmd: ExecutionCommand }
  | { kind: 'dead_letter';  cmd: ExecutionCommand }
  | { kind: 'bulk_retry';   ids: string[] }
  | { kind: 'bulk_dl';      ids: string[] };

export function CommandsPanel() {
  const { get, post } = useControlApi();

  const [commands, setCommands]     = useState<ExecutionCommand[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing]         = useState<string | null>(null);
  const [pending, setPending]       = useState<PendingAction | null>(null);
  const [selected, setSelected]     = useState<Set<string>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);

  const [filterStatus, setFilterStatus]   = useState('');
  const [filterExecId, setFilterExecId]   = useState('');
  const [filterCmdType, setFilterCmdType] = useState('');

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams({ limit: '100' });
    if (filterStatus)          params.set('status', filterStatus);
    if (filterExecId.trim())   params.set('execution_id', filterExecId.trim());
    if (filterCmdType.trim())  params.set('command_type', filterCmdType.trim());
    return `/api/runtime/control/commands?${params.toString()}`;
  }, [filterStatus, filterExecId, filterCmdType]);

  const load = useCallback(async (asRefresh = false) => {
    if (asRefresh) setRefreshing(true); else setLoading(true);
    const res = await get<CommandsResponse>(buildUrl());
    if (res) {
      setCommands(res.commands ?? []);
      setSelected(new Set());
    }
    setLoading(false);
    setRefreshing(false);
  }, [get, buildUrl]);

  useEffect(() => { void load(); }, [load]);
  useAutoRefresh(() => void load(true), 15_000);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === commands.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(commands.map(c => c.id)));
    }
  };

  const execute = useCallback(async () => {
    if (!pending) return;

    if (pending.kind === 'bulk_retry' || pending.kind === 'bulk_dl') {
      const items = commands
        .filter(c => pending.ids.includes(c.id))
        .map(c => ({ commandId: c.id, executionId: c.execution_id, retryCount: c.retry_count }));
      setPending(null);
      setBulkActing(true);
      try {
        const action = pending.kind === 'bulk_retry' ? 'bulk_retry' : 'bulk_dead_letter';
        const res = await post<{ queued?: number; deadLettered?: number; errors?: number; total?: number }>(
          '/api/runtime/control/commands',
          { action, commands: items }
        );
        if (res) {
          if (action === 'bulk_retry') {
            toast.success(`Bulk retry: ${res.queued ?? 0} queued, ${res.deadLettered ?? 0} max-retried`);
          } else {
            toast.success(`Dead-lettered ${res.deadLettered ?? 0} of ${res.total ?? 0} commands`);
          }
          await load(true);
        } else {
          toast.error('Bulk action failed');
        }
      } finally {
        setBulkActing(false);
        setSelected(new Set());
      }
      return;
    }

    const { kind, cmd } = pending;
    setPending(null);
    setActing(cmd.id);
    try {
      if (kind === 'retry') {
        const res = await post<{ queued: boolean; deadLettered: boolean }>(
          '/api/runtime/control/commands',
          { action: 'retry', commandId: cmd.id, executionId: cmd.execution_id, retryCount: cmd.retry_count }
        );
        if (res?.queued)            toast.success('Command re-queued');
        else if (res?.deadLettered) toast.warning('Max retries reached — moved to dead-letter');
        else                        toast.error('Retry failed');
      } else {
        const res = await post<{ deadLettered: boolean }>(
          '/api/runtime/control/commands',
          { action: 'dead_letter', commandId: cmd.id, executionId: cmd.execution_id, reason: 'operator_dead_letter' }
        );
        if (res?.deadLettered) toast.success('Command moved to dead-letter');
        else                   toast.error('Dead-letter failed');
      }
      await load(true);
    } finally {
      setActing(null);
    }
  }, [pending, commands, post, load]);

  if (loading) {
    return <div className='space-y-2'>{[...Array(5)].map((_, i) => <Skeleton key={i} className='h-14 rounded-lg' />)}</div>;
  }

  const selectable = commands.filter(c => c.status !== 'acknowledged' && c.status !== 'dead_letter');
  const canBulkRetry = [...selected].some(id => {
    const cmd = commands.find(c => c.id === id);
    return cmd?.status === 'failed' || cmd?.status === 'pending';
  });
  const canBulkDL = [...selected].some(id => {
    const cmd = commands.find(c => c.id === id);
    return cmd && cmd.status !== 'acknowledged' && cmd.status !== 'dead_letter';
  });

  return (
    <div className='space-y-4'>
      {/* Filters */}
      <div className='flex flex-wrap items-center gap-2'>
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
        <Input
          placeholder='Execution ID'
          value={filterExecId}
          onChange={e => setFilterExecId(e.target.value)}
          className='h-8 w-64 text-xs'
        />
        <Input
          placeholder='Command type'
          value={filterCmdType}
          onChange={e => setFilterCmdType(e.target.value)}
          className='h-8 w-44 text-xs'
        />
        <Button size='sm' variant='ghost' className='h-8 gap-1 text-xs' onClick={() => void load(true)} disabled={refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className='flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-2'>
          <span className='text-xs text-muted-foreground'>{selected.size} selected</span>
          <div className='flex-1' />
          <Button
            size='sm' variant='outline' className='h-7 gap-1 text-xs'
            disabled={!canBulkRetry || bulkActing}
            onClick={() => setPending({ kind: 'bulk_retry', ids: [...selected] })}
          >
            {bulkActing ? <Loader2 className='h-3 w-3 animate-spin' /> : 'Retry Selected'}
          </Button>
          <Button
            size='sm' variant='outline' className='h-7 gap-1 text-xs border-red-500/40 text-red-400 hover:border-red-500'
            disabled={!canBulkDL || bulkActing}
            onClick={() => setPending({ kind: 'bulk_dl', ids: [...selected] })}
          >
            Dead-Letter Selected
          </Button>
          <Button size='sm' variant='ghost' className='h-7 text-xs' onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {commands.length === 0 ? (
        <div className='flex flex-col items-center gap-2 py-10'>
          <AlertTriangle className='h-8 w-8 text-muted-foreground/40' />
          <p className='text-sm text-muted-foreground'>No commands match the current filters.</p>
        </div>
      ) : (
        <div className='overflow-auto rounded-xl border border-border'>
          <table className='w-full min-w-[940px] text-xs'>
            <thead className='border-b border-border bg-muted/30'>
              <tr>
                <th className='w-8 px-3 py-2.5'>
                  <Checkbox
                    checked={selectable.length > 0 && selected.size === selectable.length}
                    onCheckedChange={toggleAll}
                    aria-label='Select all'
                  />
                </th>
                {['Flow', 'Type', 'Status', 'Execution', 'Seq', 'Retries', 'Scheduled', 'Created', 'Actions'].map(h => (
                  <th key={h} className='px-3 py-2.5 text-left font-medium text-muted-foreground'>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {commands.map(cmd => {
                const isActing = acting === cmd.id;
                const isSelectable = cmd.status !== 'acknowledged' && cmd.status !== 'dead_letter';
                return (
                  <tr key={cmd.id} className={`border-b border-border/50 hover:bg-muted/10 ${selected.has(cmd.id) ? 'bg-muted/5' : ''}`}>
                    <td className='px-3 py-2.5'>
                      {isSelectable ? (
                        <Checkbox
                          checked={selected.has(cmd.id)}
                          onCheckedChange={() => toggleSelect(cmd.id)}
                          aria-label={`Select ${cmd.id}`}
                        />
                      ) : null}
                    </td>
                    {/* Timeline flow indicator */}
                    <td className='px-3 py-2.5'>
                      <div className='flex items-center gap-0.5'>
                        {['pending', 'processing', 'acknowledged'].map(step => (
                          <span key={step}>
                            <TimelineDot status={cmd.status === step || (step === 'acknowledged' && (cmd.status === 'failed' || cmd.status === 'dead_letter')) ? cmd.status : step === 'pending' ? 'acknowledged' : 'pending'} />
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className='px-3 py-2.5 font-medium'>{cmd.command_type}</td>
                    <td className='px-3 py-2.5'>
                      <span className={`rounded-full border px-2 py-0.5 font-semibold ${statusBadge(cmd.status)}`}>
                        {cmd.status}
                      </span>
                    </td>
                    <td className='px-3 py-2.5 font-mono text-[11px] text-muted-foreground'>
                      {cmd.execution_id.slice(0, 8)}…
                    </td>
                    <td className='px-3 py-2.5 tabular-nums'>{cmd.sequence_number}</td>
                    <td className='px-3 py-2.5 tabular-nums'>{cmd.retry_count}</td>
                    <td className='px-3 py-2.5 text-muted-foreground'>{fmt(cmd.scheduled_for)}</td>
                    <td className='px-3 py-2.5 text-muted-foreground'>{fmt(cmd.created_at)}</td>
                    <td className='px-3 py-2.5'>
                      <div className='flex gap-1.5'>
                        {(cmd.status === 'failed' || cmd.status === 'pending') && (
                          <Button
                            size='sm' variant='outline'
                            className='h-6 px-2 text-[11px]'
                            disabled={isActing}
                            onClick={() => setPending({ kind: 'retry', cmd })}
                          >
                            {isActing ? <Loader2 className='h-3 w-3 animate-spin' /> : 'Retry'}
                          </Button>
                        )}
                        {cmd.status !== 'dead_letter' && cmd.status !== 'acknowledged' && (
                          <Button
                            size='sm' variant='ghost'
                            className='h-6 px-2 text-[11px] text-red-400 hover:text-red-300'
                            disabled={isActing}
                            onClick={() => setPending({ kind: 'dead_letter', cmd })}
                          >
                            DL
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Single command action dialog */}
      <AlertDialog
        open={pending !== null && (pending.kind === 'retry' || pending.kind === 'dead_letter')}
        onOpenChange={open => { if (!open) setPending(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === 'retry' ? 'Retry Command' : 'Dead-Letter Command'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'retry'
                ? `Re-queue command "${(pending as { kind: 'retry'; cmd: ExecutionCommand }).cmd.command_type}" (retry ${(pending as { kind: 'retry'; cmd: ExecutionCommand }).cmd.retry_count + 1})?`
                : pending?.kind === 'dead_letter'
                  ? `Move "${(pending as { kind: 'dead_letter'; cmd: ExecutionCommand }).cmd.command_type}" to dead-letter? This cannot be undone automatically.`
                  : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void execute()}>
              {pending?.kind === 'retry' ? 'Retry' : 'Dead-Letter'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk action dialog */}
      <AlertDialog
        open={pending !== null && (pending.kind === 'bulk_retry' || pending.kind === 'bulk_dl')}
        onOpenChange={open => { if (!open) setPending(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === 'bulk_retry' ? 'Bulk Retry Commands' : 'Bulk Dead-Letter Commands'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'bulk_retry'
                ? `Re-queue ${pending.ids.length} selected command${pending.ids.length > 1 ? 's' : ''}?`
                : `Move ${(pending as { kind: 'bulk_dl'; ids: string[] })?.ids?.length ?? 0} selected command${(pending as { kind: 'bulk_dl'; ids: string[] })?.ids?.length > 1 ? 's' : ''} to dead-letter?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={pending?.kind === 'bulk_dl' ? 'bg-red-600 hover:bg-red-700' : ''}
              onClick={() => void execute()}
            >
              {pending?.kind === 'bulk_retry' ? 'Retry All' : 'Dead-Letter All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
