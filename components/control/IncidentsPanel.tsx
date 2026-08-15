'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle, CheckCircle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useControlApi } from './use-control-api';
import { useAutoRefresh } from './use-auto-refresh';
import type { Incident, IncidentSeverity } from './types';

const SEVERITY_OPTIONS: Array<IncidentSeverity | ''> = ['', 'low', 'medium', 'high', 'critical'];

function severityBadge(severity: Incident['severity']) {
  const map: Record<string, string> = {
    critical: 'border-red-500/50 bg-red-500/10 text-red-400',
    high:     'border-orange-500/50 bg-orange-500/10 text-orange-400',
    medium:   'border-amber-500/50 bg-amber-500/10 text-amber-400',
    low:      'border-blue-500/50 bg-blue-500/10 text-blue-400',
  };
  return map[severity] ?? 'border-border text-muted-foreground';
}

function statusColor(s: string) {
  return s === 'open' ? 'text-amber-400' : s === 'investigating' ? 'text-blue-400' : 'text-muted-foreground';
}

function fmt(ts?: string | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

type IncidentsResponse = { incidents: Incident[]; count: number };

type PendingAction =
  | { kind: 'resolve';       incident: Incident }
  | { kind: 'escalate';      incident: Incident; toSeverity: IncidentSeverity }
  | { kind: 'comment';       incident: Incident }
  | { kind: 'bulk_resolve';  ids: string[] }
  | { kind: 'bulk_escalate'; ids: string[]; toSeverity: IncidentSeverity };

export function IncidentsPanel() {
  const { get, post } = useControlApi();

  const [incidents, setIncidents]   = useState<Incident[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing]         = useState<string | null>(null);
  const [bulkActing, setBulkActing] = useState(false);
  const [pending, setPending]       = useState<PendingAction | null>(null);
  const [commentText, setCommentText] = useState('');
  const commentRef = useRef<HTMLTextAreaElement>(null);

  const [filterSeverity, setFilterSeverity] = useState<IncidentSeverity | ''>('');
  const [selected, setSelected]             = useState<Set<string>>(new Set());

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams({ limit: '100' });
    if (filterSeverity) params.set('severity', filterSeverity);
    return `/api/runtime/control/incidents?${params.toString()}`;
  }, [filterSeverity]);

  const load = useCallback(async (asRefresh = false) => {
    if (asRefresh) setRefreshing(true); else setLoading(true);
    const res = await get<IncidentsResponse>(buildUrl());
    if (res) {
      setIncidents(res.incidents ?? []);
      setSelected(new Set());
    }
    setLoading(false);
    setRefreshing(false);
  }, [get, buildUrl]);

  useEffect(() => { void load(); }, [load]);
  useAutoRefresh(() => void load(true), 15_000);

  const openComment = useCallback((inc: Incident) => {
    setCommentText('');
    setPending({ kind: 'comment', incident: inc });
    setTimeout(() => commentRef.current?.focus(), 50);
  }, []);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === incidents.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(incidents.map(i => i.id)));
    }
  };

  const execute = useCallback(async () => {
    if (!pending) return;
    const { kind } = pending;

    if (kind === 'bulk_resolve') {
      setPending(null);
      setBulkActing(true);
      try {
        const res = await post<{ resolved: number; total: number }>(
          '/api/runtime/control/incidents',
          { action: 'bulk_resolve', incidentIds: pending.ids }
        );
        if (res) {
          toast.success(`Resolved ${res.resolved} of ${res.total} incidents`);
          await load(true);
        } else {
          toast.error('Bulk resolve failed');
        }
      } finally {
        setBulkActing(false);
        setSelected(new Set());
      }
      return;
    }

    if (kind === 'bulk_escalate') {
      setPending(null);
      setBulkActing(true);
      try {
        const res = await post<{ escalated: number; total: number }>(
          '/api/runtime/control/incidents',
          { action: 'bulk_escalate', incidentIds: pending.ids, toSeverity: pending.toSeverity }
        );
        if (res) {
          toast.success(`Escalated ${res.escalated} of ${res.total} incidents to ${pending.toSeverity}`);
          await load(true);
        } else {
          toast.error('Bulk escalate failed');
        }
      } finally {
        setBulkActing(false);
        setSelected(new Set());
      }
      return;
    }

    const incident = (pending as { incident: Incident }).incident;
    setPending(null);
    setActing(incident.id);
    try {
      let body: Record<string, unknown>;
      if (kind === 'resolve') {
        body = { action: 'resolve', incidentId: incident.id };
        toast.loading('Resolving…', { id: 'inc-action' });
      } else if (kind === 'escalate') {
        body = { action: 'escalate', incidentId: incident.id, toSeverity: (pending as { toSeverity: IncidentSeverity }).toSeverity };
        toast.loading('Escalating…', { id: 'inc-action' });
      } else {
        if (!commentText.trim()) { toast.error('Comment cannot be empty'); setActing(null); return; }
        body = { action: 'comment', incidentId: incident.id, comment: commentText.trim() };
        toast.loading('Adding comment…', { id: 'inc-action' });
      }

      const res = await post<Record<string, unknown>>('/api/runtime/control/incidents', body);
      toast.dismiss('inc-action');
      if (res) {
        toast.success(kind === 'resolve' ? 'Incident resolved' : kind === 'escalate' ? 'Incident escalated' : 'Comment added');
        await load(true);
      } else {
        toast.error('Action failed');
      }
    } finally {
      setActing(null);
      setCommentText('');
    }
  }, [pending, post, load, commentText]);

  if (loading) {
    return <div className='space-y-2'>{[...Array(5)].map((_, i) => <Skeleton key={i} className='h-20 rounded-lg' />)}</div>;
  }

  const selectedArr = [...selected];
  const canBulkEscalate = selectedArr.some(id => {
    const inc = incidents.find(i => i.id === id);
    return inc && inc.severity !== 'critical';
  });

  return (
    <div className='space-y-4'>
      {/* Filters */}
      <div className='flex flex-wrap items-center gap-2'>
        <Select value={filterSeverity} onValueChange={v => setFilterSeverity(v as IncidentSeverity | '')}>
          <SelectTrigger className='h-8 w-40 text-xs'>
            <SelectValue placeholder='All severities' />
          </SelectTrigger>
          <SelectContent>
            {SEVERITY_OPTIONS.map(s => (
              <SelectItem key={s || 'all'} value={s} className='text-xs'>
                {s || 'All severities'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
            size='sm' variant='outline'
            className='h-7 gap-1 text-xs border-emerald-500/40 text-emerald-400 hover:border-emerald-500'
            disabled={bulkActing}
            onClick={() => setPending({ kind: 'bulk_resolve', ids: selectedArr })}
          >
            {bulkActing ? <Loader2 className='h-3 w-3 animate-spin' /> : 'Resolve Selected'}
          </Button>
          {canBulkEscalate && (
            <Button
              size='sm' variant='outline'
              className='h-7 gap-1 text-xs border-red-500/40 text-red-400 hover:border-red-500'
              disabled={bulkActing}
              onClick={() => setPending({ kind: 'bulk_escalate', ids: selectedArr, toSeverity: 'critical' })}
            >
              Escalate to Critical
            </Button>
          )}
          <Button size='sm' variant='ghost' className='h-7 text-xs' onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {incidents.length === 0 ? (
        <div className='flex flex-col items-center gap-2 py-10'>
          <CheckCircle className='h-8 w-8 text-emerald-400' />
          <p className='text-sm text-muted-foreground'>No active incidents.</p>
        </div>
      ) : (
        <div className='space-y-3'>
          {/* Select-all header */}
          <div className='flex items-center gap-2 text-xs text-muted-foreground px-1'>
            <Checkbox
              checked={incidents.length > 0 && selected.size === incidents.length}
              onCheckedChange={toggleAll}
              aria-label='Select all incidents'
            />
            <span>Select all</span>
          </div>

          {incidents.map(inc => (
            <div
              key={inc.id}
              className={`rounded-xl border bg-card p-4 ${selected.has(inc.id) ? 'border-primary/40 bg-muted/5' : 'border-border'}`}
            >
              <div className='flex flex-wrap items-start gap-2'>
                <Checkbox
                  checked={selected.has(inc.id)}
                  onCheckedChange={() => toggleSelect(inc.id)}
                  aria-label={`Select incident ${inc.id}`}
                />
                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${severityBadge(inc.severity)}`}>
                  {inc.severity}
                </span>
                <span className={`text-[11px] font-medium ${statusColor(inc.status)}`}>{inc.status}</span>
                <h3 className='flex-1 text-sm font-medium leading-5'>{inc.title}</h3>
              </div>

              <div className='mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground'>
                <span>Type: {inc.incidentType}</span>
                <span>Occurrences: {inc.occurrenceCount}</span>
                <span>Last: {fmt(inc.lastSeenAt)}</span>
                {inc.executionId && <span>Exec: {inc.executionId.slice(0, 8)}</span>}
                {inc.workerId    && <span>Worker: {inc.workerId.slice(0, 16)}</span>}
              </div>

              <div className='mt-3 flex flex-wrap gap-2'>
                <Button
                  size='sm' variant='outline'
                  className='h-7 text-xs border-emerald-500/40 text-emerald-400 hover:border-emerald-500'
                  disabled={acting === inc.id}
                  onClick={() => setPending({ kind: 'resolve', incident: inc })}
                >
                  {acting === inc.id ? <Loader2 className='h-3 w-3 animate-spin' /> : 'Resolve'}
                </Button>
                {inc.severity !== 'critical' && (
                  <Button
                    size='sm' variant='outline'
                    className='h-7 text-xs border-red-500/40 text-red-400 hover:border-red-500'
                    disabled={acting === inc.id}
                    onClick={() => setPending({ kind: 'escalate', incident: inc, toSeverity: nextSeverity(inc.severity) })}
                  >
                    Escalate → {nextSeverity(inc.severity)}
                  </Button>
                )}
                <Button
                  size='sm' variant='ghost'
                  className='h-7 text-xs text-muted-foreground'
                  disabled={acting === inc.id}
                  onClick={() => openComment(inc)}
                >
                  Comment
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Resolve / Escalate confirmation */}
      <AlertDialog
        open={pending !== null && (pending.kind === 'resolve' || pending.kind === 'escalate')}
        onOpenChange={open => { if (!open) setPending(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === 'resolve' ? 'Resolve Incident' : 'Escalate Incident'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'resolve'
                ? `Mark "${(pending as { incident: Incident }).incident.title}" as resolved?`
                : pending?.kind === 'escalate'
                  ? `Escalate "${(pending as { incident: Incident }).incident.title}" to ${(pending as { toSeverity: IncidentSeverity }).toSeverity}?`
                  : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={pending?.kind === 'escalate' ? 'bg-red-600 hover:bg-red-700' : ''}
              onClick={() => void execute()}
            >
              {pending?.kind === 'resolve' ? 'Resolve' : 'Escalate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Comment dialog */}
      <AlertDialog
        open={pending?.kind === 'comment'}
        onOpenChange={open => { if (!open) { setPending(null); setCommentText(''); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add Comment</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'comment' && `Add a comment to "${(pending as { incident: Incident }).incident.title}"`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            ref={commentRef}
            value={commentText}
            onChange={e => setCommentText(e.target.value)}
            placeholder='Describe the finding, action taken, or context…'
            className='min-h-[80px] text-sm'
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={!commentText.trim()} onClick={() => void execute()}>
              Add Comment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk resolve confirmation */}
      <AlertDialog
        open={pending?.kind === 'bulk_resolve'}
        onOpenChange={open => { if (!open) setPending(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Bulk Resolve Incidents</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'bulk_resolve' && `Resolve ${pending.ids.length} selected incident${pending.ids.length > 1 ? 's' : ''}?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void execute()}>Resolve All</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk escalate confirmation */}
      <AlertDialog
        open={pending?.kind === 'bulk_escalate'}
        onOpenChange={open => { if (!open) setPending(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Bulk Escalate to Critical</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'bulk_escalate' && `Escalate ${pending.ids.length} selected incident${pending.ids.length > 1 ? 's' : ''} to critical?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className='bg-red-600 hover:bg-red-700' onClick={() => void execute()}>
              Escalate All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function nextSeverity(current: IncidentSeverity): IncidentSeverity {
  const ladder: IncidentSeverity[] = ['low', 'medium', 'high', 'critical'];
  const idx = ladder.indexOf(current);
  return ladder[Math.min(idx + 1, ladder.length - 1)];
}
