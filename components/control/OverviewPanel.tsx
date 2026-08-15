'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Activity, AlertTriangle, CheckCircle, Cpu, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useControlApi } from './use-control-api';
import { useAutoRefresh } from './use-auto-refresh';
import { HealthTrendChart } from './HealthTrendChart';
import type { OverviewResponse, Incident, HealthScoreV2, RecentAction } from './types';

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-400';
  if (score >= 60) return 'text-amber-400';
  return 'text-red-400';
}

function scoreBar(score: number): string {
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 60) return 'bg-amber-500';
  return 'bg-red-500';
}

function severityBadge(severity: Incident['severity']) {
  const map: Record<string, string> = {
    critical: 'border-red-500/50 bg-red-500/10 text-red-400',
    high:     'border-orange-500/50 bg-orange-500/10 text-orange-400',
    medium:   'border-amber-500/50 bg-amber-500/10 text-amber-400',
    low:      'border-blue-500/50 bg-blue-500/10 text-blue-400',
  };
  return map[severity] ?? 'border-border text-muted-foreground';
}

function fmt(ts?: string | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function ComponentRow({ label, value }: { label: string; value: number }) {
  return (
    <div className='space-y-1'>
      <div className='flex items-center justify-between text-xs'>
        <span className='text-muted-foreground'>{label}</span>
        <span className={scoreColor(value)}>{value}</span>
      </div>
      <div className='h-1.5 w-full overflow-hidden rounded-full bg-secondary'>
        <div
          className={`h-full rounded-full transition-all ${scoreBar(value)}`}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  );
}

function HealthCard({ health }: { health: HealthScoreV2 }) {
  const { overallScore, components, signals } = health;
  return (
    <div className='rounded-xl border border-border bg-card p-5'>
      <div className='mb-4 flex items-center justify-between'>
        <h2 className='text-sm font-semibold'>Health Score v2</h2>
        <span className={`text-3xl font-bold tabular-nums ${scoreColor(overallScore)}`}>
          {overallScore}
        </span>
      </div>

      <div className='space-y-2.5'>
        <ComponentRow label='Worker Liveness'        value={components.workerLiveness} />
        <ComponentRow label='Queue Health'           value={components.queueHealth} />
        <ComponentRow label='Command Bus'            value={components.commandBusHealth} />
        <ComponentRow label='Replay Integrity'       value={components.replayIntegrityHealth} />
        <ComponentRow label='Incident Severity'      value={components.incidentSeverityScore} />
      </div>

      <div className='mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs'>
        <div>
          <p className='text-muted-foreground'>Command Backlog</p>
          <p className='font-medium tabular-nums'>{signals.commandBacklog}</p>
        </div>
        <div>
          <p className='text-muted-foreground'>DLQ Rate</p>
          <p className='font-medium tabular-nums'>{signals.deadLetterRate}%</p>
        </div>
        <div>
          <p className='text-muted-foreground'>Worker Liveness</p>
          <p className='font-medium tabular-nums'>{signals.workerLivenessPercent}%</p>
        </div>
        <div>
          <p className='text-muted-foreground'>Queue Delay</p>
          <p className='font-medium tabular-nums'>{(signals.queueDelay / 1000).toFixed(1)}s</p>
        </div>
        <div>
          <p className='text-muted-foreground'>Open Incidents</p>
          <p className={`font-medium tabular-nums ${signals.openIncidentCount > 0 ? 'text-amber-400' : ''}`}>
            {signals.openIncidentCount}
          </p>
        </div>
        <div>
          <p className='text-muted-foreground'>Critical</p>
          <p className={`font-medium tabular-nums ${signals.criticalIncidentCount > 0 ? 'text-red-400' : ''}`}>
            {signals.criticalIncidentCount}
          </p>
        </div>
      </div>
    </div>
  );
}

function ActiveIncidents({ incidents }: { incidents: Incident[] }) {
  if (incidents.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center gap-2 py-8 text-center'>
        <CheckCircle className='h-8 w-8 text-emerald-400' />
        <p className='text-sm text-muted-foreground'>No active incidents</p>
      </div>
    );
  }
  return (
    <div className='space-y-2'>
      {incidents.slice(0, 6).map((inc) => (
        <div key={inc.id} className='rounded-lg border border-border bg-muted/20 p-3 text-xs'>
          <div className='flex flex-wrap items-start gap-2'>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${severityBadge(inc.severity)}`}>
              {inc.severity}
            </span>
            <span className='font-medium leading-5'>{inc.title}</span>
          </div>
          <div className='mt-1.5 flex flex-wrap gap-3 text-muted-foreground'>
            <span>{inc.incidentType}</span>
            <span>×{inc.occurrenceCount}</span>
            <span>Last: {fmt(inc.lastSeenAt)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function RecentActivity({ actions }: { actions: RecentAction[] }) {
  if (actions.length === 0) {
    return <p className='text-xs text-muted-foreground'>No recent operator actions.</p>;
  }
  return (
    <div className='space-y-1.5'>
      {actions.slice(0, 10).map((a, i) => (
        <div key={i} className='flex items-center justify-between text-xs'>
          <span className='font-medium'>{a.action_type}</span>
          <span className='text-muted-foreground'>{fmt(a.created_at)}</span>
        </div>
      ))}
    </div>
  );
}

export function OverviewPanel() {
  const { get } = useControlApi();
  const [data, setData]         = useState<OverviewResponse | null>(null);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (asRefresh = false) => {
    if (asRefresh) setRefreshing(true); else setLoading(true);
    const res = await get<OverviewResponse>('/api/runtime/control/overview');
    if (res) setData(res);
    else if (!asRefresh) toast.error('Failed to load overview');
    setLoading(false);
    setRefreshing(false);
  }, [get]);

  useEffect(() => { void load(); }, [load]);
  useAutoRefresh(() => void load(true), 10_000);

  if (loading) {
    return (
      <div className='grid gap-6 lg:grid-cols-3'>
        <Skeleton className='h-64 rounded-xl' />
        <Skeleton className='h-64 rounded-xl lg:col-span-2' />
      </div>
    );
  }

  if (!data) {
    return (
      <div className='flex flex-col items-center gap-2 py-12'>
        <AlertTriangle className='h-8 w-8 text-amber-400' />
        <p className='text-sm text-muted-foreground'>Could not load overview.</p>
        <Button size='sm' variant='outline' onClick={() => void load()}>Retry</Button>
      </div>
    );
  }

  const ws = data.workerSummary;

  return (
    <div className='space-y-6'>
      <div className='flex items-center justify-between'>
        <p className='text-xs text-muted-foreground'>Updated {fmt(data.generatedAt)}</p>
        <Button size='sm' variant='ghost' className='gap-1.5 text-xs' onClick={() => void load(true)} disabled={refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className='grid gap-4 sm:grid-cols-3'>
        <div className='rounded-xl border border-border bg-card p-4'>
          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
            <Cpu className='h-3.5 w-3.5' /> Live Workers
          </div>
          <p className='mt-1 text-2xl font-semibold tabular-nums'>{ws.liveWorkers}</p>
          <p className='text-xs text-muted-foreground'>concurrency {ws.totalConcurrency}</p>
        </div>
        <div className='rounded-xl border border-border bg-card p-4'>
          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
            <Zap className='h-3.5 w-3.5' /> Pending Commands
          </div>
          <p className='mt-1 text-2xl font-semibold tabular-nums'>
            {data.commandBacklog.statusCounts.pending ?? 0}
          </p>
          <p className='text-xs text-muted-foreground'>
            {data.commandBacklog.statusCounts.dead_letter ?? 0} dead-lettered
          </p>
        </div>
        <div className='rounded-xl border border-border bg-card p-4'>
          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
            <Activity className='h-3.5 w-3.5' /> Active Incidents
          </div>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${data.activeIncidents.length > 0 ? 'text-amber-400' : ''}`}>
            {data.activeIncidents.length}
          </p>
          <p className='text-xs text-muted-foreground'>
            {data.activeIncidents.filter(i => i.severity === 'critical').length} critical
          </p>
        </div>
      </div>

      <div className='grid gap-6 lg:grid-cols-3'>
        <HealthCard health={data.healthScore} />

        <div className='space-y-6 lg:col-span-2'>
          <section className='rounded-xl border border-border bg-card p-4'>
            <h2 className='mb-3 text-sm font-semibold'>Active Incidents</h2>
            <ActiveIncidents incidents={data.activeIncidents} />
          </section>

          <section className='rounded-xl border border-border bg-card p-4'>
            <h2 className='mb-3 text-sm font-semibold'>Recent Operator Actions</h2>
            <RecentActivity actions={data.recentActivity} />
          </section>
        </div>
      </div>

      <HealthTrendChart />

      {Object.keys(data.commandBacklog.byType).length > 0 && (
        <section className='rounded-xl border border-border bg-card p-4'>
          <h2 className='mb-3 text-sm font-semibold'>Pending Commands by Type</h2>
          <div className='flex flex-wrap gap-2'>
            {Object.entries(data.commandBacklog.byType).map(([type, count]) => (
              <Badge key={type} variant='outline' className='gap-1.5 font-mono text-xs'>
                {type}
                <span className='font-semibold'>{count}</span>
              </Badge>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
