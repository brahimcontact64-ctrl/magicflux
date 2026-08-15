'use client';

import { useCallback, useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { useControlApi } from './use-control-api';
import type { HealthHistoryResponse, HealthSnapshot } from './types';

type Window = '24h' | '7d' | '30d';

const WINDOW_LABELS: Record<Window, string> = {
  '24h': '24 hours',
  '7d':  '7 days',
  '30d': '30 days',
};

function formatX(ts: string, window: Window): string {
  const d = new Date(ts);
  if (window === '24h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--color-emerald)';
  if (score >= 60) return 'var(--color-amber)';
  return 'var(--color-red)';
}

const chartConfig = {
  overall_score: {
    label: 'Health Score',
    color: 'hsl(var(--chart-1))',
  },
};

export function HealthTrendChart() {
  const { get } = useControlApi();
  const [window, setWindow] = useState<Window>('24h');
  const [snapshots, setSnapshots] = useState<HealthSnapshot[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (w: Window, asRefresh = false) => {
    if (asRefresh) setRefreshing(true); else setLoading(true);
    const res = await get<HealthHistoryResponse>(`/api/runtime/control/health-history?window=${w}`);
    if (res) setSnapshots(res.snapshots ?? []);
    setLoading(false);
    setRefreshing(false);
  }, [get]);

  useEffect(() => { void load(window); }, [load, window]);

  const chartData = snapshots.map(s => ({
    time:          s.computed_at,
    overall_score: s.overall_score,
    label:         formatX(s.computed_at, window),
  }));

  return (
    <div className='rounded-xl border border-border bg-card p-4'>
      <div className='mb-4 flex items-center justify-between'>
        <h2 className='text-sm font-semibold'>Health Score Trend</h2>
        <div className='flex items-center gap-2'>
          <div className='flex rounded-md border border-border overflow-hidden text-xs'>
            {(['24h', '7d', '30d'] as Window[]).map(w => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={`px-3 py-1 ${window === w ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
              >
                {w}
              </button>
            ))}
          </div>
          <Button size='sm' variant='ghost' className='h-7 w-7 p-0' onClick={() => void load(window, true)} disabled={refreshing}>
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {loading ? (
        <Skeleton className='h-48 w-full rounded-lg' />
      ) : snapshots.length === 0 ? (
        <div className='flex h-48 items-center justify-center text-xs text-muted-foreground'>
          No health snapshots for the last {WINDOW_LABELS[window]}. Visit the Overview tab to generate data.
        </div>
      ) : (
        <ChartContainer config={chartConfig} className='h-48 w-full'>
          <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id='healthGrad' x1='0' y1='0' x2='0' y2='1'>
                <stop offset='5%'  stopColor='hsl(var(--chart-1))' stopOpacity={0.3} />
                <stop offset='95%' stopColor='hsl(var(--chart-1))' stopOpacity={0.0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray='3 3' stroke='hsl(var(--border))' vertical={false} />
            <XAxis
              dataKey='label'
              tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              axisLine={false}
              tickLine={false}
              interval='preserveStartEnd'
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              axisLine={false}
              tickLine={false}
              width={28}
            />
            <ChartTooltip content={<ChartTooltipContent indicator='dot' />} />
            <Area
              type='monotone'
              dataKey='overall_score'
              stroke='hsl(var(--chart-1))'
              strokeWidth={2}
              fill='url(#healthGrad)'
              dot={false}
              activeDot={{ r: 4 }}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  );
}
