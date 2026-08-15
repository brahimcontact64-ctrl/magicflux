'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useControlApi } from './use-control-api';
import { useAutoRefresh } from './use-auto-refresh';
import { ExecutionDetailModal } from './ExecutionDetailModal';
import type { Execution } from './types';

const STATUS_OPTIONS = ['', 'running', 'waiting', 'paused', 'success', 'failed', 'cancelled'];

function statusColor(status: string) {
  const map: Record<string, string> = {
    running:   'text-emerald-400',
    waiting:   'text-blue-400',
    paused:    'text-amber-400',
    success:   'text-emerald-400',
    failed:    'text-red-400',
    cancelled: 'text-muted-foreground',
  };
  return map[status] ?? 'text-muted-foreground';
}

function fmt(ts?: string | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

type ExecutionsResponse = { executions: Execution[]; count: number };

type ExecActionKind = 'pause' | 'resume' | 'cancel' | 'force_snapshot';
type PendingAction = { kind: ExecActionKind; exec: Execution };

const ACTION_LABELS: Record<ExecActionKind, string> = {
  pause:          'Pause Execution',
  resume:         'Resume Execution',
  cancel:         'Cancel Execution',
  force_snapshot: 'Force Snapshot',
};

export function ExecutionsPanel() {
  const { get, post } = useControlApi();

  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing]         = useState<string | null>(null);
  const [pending, setPending]       = useState<PendingAction | null>(null);

  const [filterStatus, setFilterStatus]     = useState('');
  const [filterWorkflow, setFilterWorkflow] = useState('');

  const [detailExecId, setDetailExecId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen]     = useState(false);

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams({ limit: '50' });
    if (filterStatus)           params.set('status', filterStatus);
    if (filterWorkflow.trim())  params.set('workflow_id', filterWorkflow.trim());
    return `/api/runtime/control/executions?${params.toString()}`;
  }, [filterStatus, filterWorkflow]);

  const load = useCallback(async (asRefresh = false) => {
    if (asRefresh) setRefreshing(true); else setLoading(true);
    const res = await get<ExecutionsResponse>(buildUrl());
    if (res) setExecutions(res.executions ?? []);
    setLoading(false);
    setRefreshing(false);
  }, [get, buildUrl]);

  useEffect(() => { void load(); }, [load]);
  useAutoRefresh(() => void load(true), 10_000);

  const execute = useCallback(async () => {
    if (!pending) return;
    const { kind, exec } = pending;
    setPending(null);
    setActing(exec.id);
    try {
      const res = await post<Record<string, unknown>>(
        '/api/runtime/control/executions',
        { action: kind, executionId: exec.id, workflowId: exec.workflow_id }
      );
      if (res) {
        toast.success(`${ACTION_LABELS[kind]} — done`);
        await load(true);
      } else {
        toast.error(`${ACTION_LABELS[kind]} failed`);
      }
    } finally {
      setActing(null);
    }
  }, [pending, post, load]);

  const canPause   = (s: string) => s === 'running' || s === 'waiting';
  const canResume  = (s: string) => s === 'paused';
  const canCancel  = (s: string) => !['success', 'failed', 'cancelled'].includes(s);

  if (loading) {
    return <div className='space-y-2'>{[...Array(5)].map((_, i) => <Skeleton key={i} className='h-14 rounded-lg' />)}</div>;
  }

  return (
    <div className='space-y-4'>
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
          placeholder='Workflow ID'
          value={filterWorkflow}
          onChange={e => setFilterWorkflow(e.target.value)}
          className='h-8 w-64 text-xs'
        />
        <Button size='sm' variant='ghost' className='h-8 gap-1 text-xs' onClick={() => void load(true)} disabled={refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {executions.length === 0 ? (
        <div className='flex flex-col items-center gap-2 py-10'>
          <AlertTriangle className='h-8 w-8 text-muted-foreground/40' />
          <p className='text-sm text-muted-foreground'>No executions match the current filters.</p>
        </div>
      ) : (
        <div className='overflow-auto rounded-xl border border-border'>
          <table className='w-full min-w-[960px] text-xs'>
            <thead className='border-b border-border bg-muted/30'>
              <tr>
                {['ID', 'Workflow', 'Status', 'Started', 'Completed', 'Retries', 'Error', 'Actions'].map(h => (
                  <th key={h} className='px-3 py-2.5 text-left font-medium text-muted-foreground'>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {executions.map(exec => (
                <tr key={exec.id} className='border-b border-border/50 hover:bg-muted/10'>
                  <td className='px-3 py-2.5'>
                    <button
                      className='font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline'
                      onClick={() => { setDetailExecId(exec.id); setDetailOpen(true); }}
                    >
                      {exec.id.slice(0, 8)}…
                    </button>
                  </td>
                  <td className='px-3 py-2.5 font-mono text-[11px] text-muted-foreground'>
                    {exec.workflow_id.slice(0, 8)}…
                  </td>
                  <td className='px-3 py-2.5'>
                    <span className={`font-semibold ${statusColor(exec.status)}`}>{exec.status}</span>
                  </td>
                  <td className='px-3 py-2.5 text-muted-foreground'>{fmt(exec.started_at)}</td>
                  <td className='px-3 py-2.5 text-muted-foreground'>{fmt(exec.completed_at)}</td>
                  <td className='px-3 py-2.5 tabular-nums'>{exec.retry_count}</td>
                  <td className='max-w-[180px] truncate px-3 py-2.5 text-red-400'>
                    {exec.error_message ?? '—'}
                  </td>
                  <td className='px-3 py-2.5'>
                    <div className='flex flex-wrap gap-1'>
                      {canPause(exec.status) && (
                        <ActionButton label='Pause' disabled={acting === exec.id}
                          onClick={() => setPending({ kind: 'pause', exec })} />
                      )}
                      {canResume(exec.status) && (
                        <ActionButton label='Resume' disabled={acting === exec.id}
                          onClick={() => setPending({ kind: 'resume', exec })} />
                      )}
                      {canCancel(exec.status) && (
                        <ActionButton label='Cancel' disabled={acting === exec.id} destructive
                          onClick={() => setPending({ kind: 'cancel', exec })} />
                      )}
                      <ActionButton label='Snapshot' disabled={acting === exec.id}
                        onClick={() => setPending({ kind: 'force_snapshot', exec })} />
                      <ActionButton label='Detail' disabled={false}
                        onClick={() => { setDetailExecId(exec.id); setDetailOpen(true); }} />
                      {acting === exec.id && <Loader2 className='h-3.5 w-3.5 animate-spin self-center' />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog open={pending !== null} onOpenChange={open => { if (!open) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending ? ACTION_LABELS[pending.kind] : ''}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending && (
                <>
                  Apply <strong>{pending.kind}</strong> to execution{' '}
                  <code className='font-mono text-xs'>{pending.exec.id.slice(0, 8)}</code>?
                  {pending.kind === 'cancel' && ' This will stop the execution immediately.'}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={pending?.kind === 'cancel' ? 'bg-red-600 hover:bg-red-700' : ''}
              onClick={() => void execute()}
            >
              {pending ? ACTION_LABELS[pending.kind] : 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ExecutionDetailModal
        executionId={detailExecId}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
    </div>
  );
}

function ActionButton({
  label, disabled, destructive, onClick,
}: {
  label: string; disabled: boolean; destructive?: boolean; onClick: () => void;
}) {
  return (
    <Button
      size='sm' variant='outline'
      className={`h-6 px-2 text-[11px] ${destructive ? 'border-red-500/40 text-red-400 hover:border-red-500 hover:text-red-300' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
