'use client';

import { useCallback, useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { RefreshCw, Activity } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { useControlApi } from './use-control-api';
import { useAutoRefresh } from './use-auto-refresh';
import type { MetricWindow, MetricSeries, MetricSnapshot, MetricsResponse, MetricsSnapshotResponse } from './types';

type ObsWindow = '1h' | '24h' | '7d' | '30d';

const WINDOW_MAP: Record<ObsWindow, MetricWindow> = {
  '1h':  '1h',
  '24h': '24h',
  '7d':  '7d',
  '30d': '30d',
};

const CHART_METRICS: Array<{
  key:   string;
  label: string;
  unit:  string;
  color: string;
  max?:  number;
}> = [
  { key: 'cpu_load',           label: 'CPU Load',         unit: '%',  color: 'hsl(var(--chart-1))', max: 100 },
  { key: 'queue_depth',        label: 'Queue Depth',      unit: '',   color: 'hsl(var(--chart-2))' },
  { key: 'worker_utilization', label: 'Worker Util.',     unit: '%',  color: 'hsl(var(--chart-3))', max: 100 },
  { key: 'error_rate',         label: 'Error Rate',       unit: '%',  color: 'hsl(var(--chart-4))', max: 100 },
  { key: 'command_latency_ms', label: 'Cmd Latency',      unit: 'ms', color: 'hsl(var(--chart-5))' },
  { key: 'incident_rate',      label: 'Open Incidents',   unit: '',   color: 'hsl(var(--chart-1))' },
];

function formatXLabel(ts: string, w: ObsWindow): string {
  const d = new Date(ts);
  if (w === '1h')  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (w === '24h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function MetricChart({
  series,
  label,
  unit,
  color,
  max,
  obsWindow,
}: {
  series:    MetricSeries | null;
  label:     string;
  unit:      string;
  color:     string;
  max?:      number;
  obsWindow: ObsWindow;
}) {
  const chartData = (series?.points ?? []).map(p => ({
    value: p.metric_value,
    label: formatXLabel(p.recorded_at, obsWindow),
  }));

  const config = { value: { label, color } };
  const gradId = `grad-${label.replace(/\s+/g, '')}`;

  if (chartData.length === 0) {
    return (
      <div className='flex h-32 items-center justify-center text-xs text-muted-foreground'>
        No data
      </div>
    );
  }

  return (
    <ChartContainer config={config} className='h-32 w-full'>
      <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradId} x1='0' y1='0' x2='0' y2='1'>
            <stop offset='5%'  stopColor={color} stopOpacity={0.3} />
            <stop offset='95%' stopColor={color} stopOpacity={0.0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray='3 3' stroke='hsl(var(--border))' vertical={false} />
        <XAxis
          dataKey='label'
          tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
          axisLine={false}
          tickLine={false}
          interval='preserveStartEnd'
        />
        <YAxis
          domain={[0, max ?? 'auto']}
          tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
          axisLine={false}
          tickLine={false}
          width={max ? 28 : 36}
          tickFormatter={v => unit ? `${v}${unit}` : String(v)}
        />
        <ChartTooltip content={<ChartTooltipContent indicator='dot' />} />
        <Area
          type='monotone'
          dataKey='value'
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gradId})`}
          dot={false}
          activeDot={{ r: 3 }}
        />
      </AreaChart>
    </ChartContainer>
  );
}

function StatCard({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  return (
    <div className='rounded-lg border border-border bg-card p-3'>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 text-xl font-semibold'>
        {value !== null ? `${value}${unit}` : '—'}
      </div>
    </div>
  );
}

export function ObservabilityPanel() {
  const { get }  = useControlApi();
  const [obsWindow, setObsWindow] = useState<ObsWindow>('1h');
  const [series, setSeries]   = useState<Record<string, MetricSeries>>({});
  const [snapshot, setSnapshot] = useState<MetricSnapshot | null>(null);
  const [loading, setLoading]   = useState(true);
  const [recording, setRecording] = useState(false);

  const loadSeries = useCallback(async (w: ObsWindow) => {
    const window = WINDOW_MAP[w];
    const results = await Promise.all(
      CHART_METRICS.map(m =>
        get<MetricsResponse>(`/api/runtime/control/metrics?metric=${m.key}&window=${window}`)
      )
    );
    const map: Record<string, MetricSeries> = {};
    CHART_METRICS.forEach((m, i) => {
      if (results[i]) map[m.key] = results[i]!.series;
    });
    setSeries(map);
    setLoading(false);
  }, [get]);

  const recordSnapshot = useCallback(async () => {
    setRecording(true);
    const res = await get<MetricsSnapshotResponse>('/api/runtime/control/metrics?snapshot=true');
    if (res) setSnapshot(res.snapshot);
    setRecording(false);
    void loadSeries(obsWindow);
  }, [get, loadSeries, obsWindow]);

  useEffect(() => {
    setLoading(true);
    void loadSeries(obsWindow);
  }, [loadSeries, obsWindow]);

  useAutoRefresh(() => { void loadSeries(obsWindow); }, 30_000);

  return (
    <div className='space-y-4'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <Activity className='h-4 w-4 text-muted-foreground' />
          <span className='text-sm font-medium'>Observability</span>
        </div>
        <div className='flex items-center gap-2'>
          <div className='flex rounded-md border border-border overflow-hidden text-xs'>
            {(['1h', '24h', '7d', '30d'] as ObsWindow[]).map(w => (
              <button
                key={w}
                onClick={() => setObsWindow(w)}
                className={`px-3 py-1 ${obsWindow === w ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
              >
                {w}
              </button>
            ))}
          </div>
          <Button
            size='sm'
            variant='outline'
            className='h-7 text-xs'
            onClick={recordSnapshot}
            disabled={recording}
          >
            <RefreshCw className={`mr-1 h-3 w-3 ${recording ? 'animate-spin' : ''}`} />
            Snapshot
          </Button>
        </div>
      </div>

      {/* Latest snapshot stats */}
      {snapshot && (
        <div className='grid grid-cols-4 gap-2'>
          <StatCard label='CPU Load'       value={snapshot.cpu_load}           unit='%' />
          <StatCard label='Queue Depth'    value={snapshot.queue_depth}         unit=''  />
          <StatCard label='Error Rate'     value={snapshot.error_rate}          unit='%' />
          <StatCard label='Worker Util.'   value={snapshot.worker_utilization}  unit='%' />
        </div>
      )}

      {/* Charts grid */}
      {loading ? (
        <div className='grid grid-cols-2 gap-4'>
          {CHART_METRICS.map(m => (
            <Skeleton key={m.key} className='h-48 w-full rounded-lg' />
          ))}
        </div>
      ) : (
        <div className='grid grid-cols-2 gap-4'>
          {CHART_METRICS.map(m => (
            <div key={m.key} className='rounded-xl border border-border bg-card p-3'>
              <div className='mb-2 text-xs font-medium text-muted-foreground'>{m.label}</div>
              <MetricChart
                series={series[m.key] ?? null}
                label={m.label}
                unit={m.unit}
                color={m.color}
                max={m.max}
                obsWindow={obsWindow}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
