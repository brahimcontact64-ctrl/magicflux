'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Shield } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useControlApi } from './use-control-api';
import { useAutoRefresh } from './use-auto-refresh';
import type { SlaReport, SlaTarget, SlaViolation } from './types';

type SlaWindow = '1h' | '24h' | '7d';

const WINDOW_HOURS: Record<SlaWindow, number> = { '1h': 1, '24h': 24, '7d': 168 };

const TARGET_LABELS: Record<string, string> = {
  execution_duration: 'Execution Duration',
  worker_availability: 'Worker Availability',
  queue_latency: 'Queue Latency',
  command_ack_time: 'Command Ack Time',
};

function formatMs(ms: number): string {
  if (ms < 1000)      return `${ms}ms`;
  if (ms < 60_000)    return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function ComplianceBadge({ pct }: { pct: number }) {
  if (pct >= 99) return <Badge className='bg-emerald-500/10 text-emerald-400 border-emerald-500/30'>{pct}%</Badge>;
  if (pct >= 90) return <Badge className='bg-amber-500/10 text-amber-400 border-amber-500/30'>{pct}%</Badge>;
  return <Badge className='bg-red-500/10 text-red-400 border-red-500/30'>{pct}%</Badge>;
}

function TargetRow({ target, compliance }: {
  target:     SlaTarget;
  compliance: { total: number; violated: number; compliancePct: number } | undefined;
}) {
  const pct = compliance?.compliancePct ?? 100;
  return (
    <div className='flex items-center gap-3 rounded-lg border border-border/50 bg-card px-3 py-2.5 text-xs'>
      <Shield className='h-4 w-4 shrink-0 text-muted-foreground' />
      <div className='flex-1 min-w-0'>
        <div className='font-medium'>{TARGET_LABELS[target.target_type] ?? target.target_type}</div>
        <div className='text-muted-foreground mt-0.5'>
          Threshold: <span className='text-foreground'>{formatMs(target.threshold_ms)}</span>
          {' · '}Warning at <span className='text-foreground'>{target.warning_pct}%</span>
          {target.description && (
            <span className='ml-1'>— {target.description}</span>
          )}
        </div>
      </div>
      <div className='text-right'>
        <ComplianceBadge pct={pct} />
        {compliance && (
          <div className='mt-1 text-muted-foreground'>
            {compliance.violated}/{compliance.total} violated
          </div>
        )}
      </div>
    </div>
  );
}

function ViolationRow({ v }: { v: SlaViolation }) {
  return (
    <div className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-xs ${
      v.severity === 'violated'
        ? 'border-red-500/30 bg-red-500/5'
        : 'border-amber-500/30 bg-amber-500/5'
    }`}>
      <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${
        v.severity === 'violated' ? 'text-red-400' : 'text-amber-400'
      }`} />
      <div className='flex-1 min-w-0'>
        <div className='flex items-center gap-2'>
          <span className='font-medium'>{TARGET_LABELS[v.target_type] ?? v.target_type}</span>
          <Badge variant='outline' className={`text-[10px] ${
            v.severity === 'violated' ? 'text-red-400 border-red-500/40' : 'text-amber-400 border-amber-500/40'
          }`}>
            {v.severity}
          </Badge>
        </div>
        {v.execution_id && (
          <div className='font-mono text-muted-foreground mt-0.5'>
            {v.execution_id.slice(0, 20)}…
          </div>
        )}
      </div>
      <div className='text-right shrink-0'>
        <div className='font-medium text-foreground'>{formatMs(v.actual_value_ms)}</div>
        <div className='text-muted-foreground'>limit: {formatMs(v.threshold_ms)}</div>
      </div>
      <div className='text-muted-foreground shrink-0'>
        {new Date(v.recorded_at).toLocaleTimeString()}
      </div>
    </div>
  );
}

export function SlaPanel() {
  const { get }    = useControlApi();
  const [window,   setWindow]   = useState<SlaWindow>('24h');
  const [report,   setReport]   = useState<SlaReport | null>(null);
  const [loading,  setLoading]  = useState(true);

  const load = useCallback(async (w: SlaWindow, showLoading = true) => {
    if (showLoading) setLoading(true);
    const res = await get<SlaReport>(`/api/runtime/control/sla?window=${WINDOW_HOURS[w]}`);
    if (res) setReport(res);
    setLoading(false);
  }, [get]);

  useEffect(() => { void load(window); }, [load, window]);
  useAutoRefresh(() => { void load(window, false); }, 30_000);

  const overallCompliance = report
    ? Object.values(report.complianceByType).reduce((sum, e) => sum + e.compliancePct, 0) /
      Math.max(1, Object.values(report.complianceByType).length)
    : 100;

  return (
    <div className='space-y-4'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <Shield className='h-4 w-4 text-muted-foreground' />
          <span className='text-sm font-medium'>SLA Monitoring</span>
          {!loading && report && (
            <Badge className={`ml-2 ${
              overallCompliance >= 99
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : overallCompliance >= 90
                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                  : 'bg-red-500/10 text-red-400 border-red-500/30'
            }`}>
              {Math.round(overallCompliance)}% compliant
            </Badge>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <div className='flex rounded-md border border-border overflow-hidden text-xs'>
            {(['1h', '24h', '7d'] as SlaWindow[]).map(w => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={`px-3 py-1 ${window === w ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
              >
                {w}
              </button>
            ))}
          </div>
          <Button
            size='sm'
            variant='ghost'
            className='h-7 w-7 p-0'
            onClick={() => void load(window)}
          >
            <RefreshCw className='h-3 w-3' />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className='space-y-2'>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className='h-16 w-full rounded-lg' />
          ))}
        </div>
      ) : !report ? (
        <div className='rounded-lg border border-border bg-card p-6 text-center text-xs text-muted-foreground'>
          Failed to load SLA data.
        </div>
      ) : (
        <>
          {/* SLA targets */}
          <div className='space-y-2'>
            <div className='text-xs font-medium text-muted-foreground'>Targets</div>
            {report.targets.length === 0 ? (
              <div className='rounded-lg border border-border/50 bg-card p-4 text-center text-xs text-muted-foreground'>
                No SLA targets configured.
              </div>
            ) : (
              report.targets.map(t => (
                <TargetRow
                  key={t.id}
                  target={t}
                  compliance={report.complianceByType[t.target_type]}
                />
              ))
            )}
          </div>

          {/* Recent violations */}
          <div className='space-y-2'>
            <div className='text-xs font-medium text-muted-foreground'>
              Recent Violations
              {report.recentViolations.length > 0 && (
                <span className='ml-2 text-muted-foreground'>({report.recentViolations.length})</span>
              )}
            </div>
            {report.recentViolations.length === 0 ? (
              <div className='flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-xs text-emerald-400'>
                <CheckCircle2 className='h-3.5 w-3.5 shrink-0' />
                No SLA violations in the last {window}
              </div>
            ) : (
              <div className='max-h-80 overflow-y-auto space-y-1.5'>
                {report.recentViolations.map(v => (
                  <ViolationRow key={v.id} v={v} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
