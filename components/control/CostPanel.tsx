'use client';

import { useCallback, useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { DollarSign, RefreshCw, TrendingUp } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { useControlApi } from './use-control-api';
import { useAutoRefresh } from './use-auto-refresh';
import type { CostResponse } from './types';

type CostWindow = '7d' | '30d' | '90d';
const WINDOW_DAYS: Record<CostWindow, number> = { '7d': 7, '30d': 30, '90d': 90 };

const COST_TYPE_LABELS: Record<string, string> = {
  execution:   'Executions',
  worker_time: 'Worker Time',
  storage:     'Storage',
  api_call:    'API Calls',
  ai_token:    'AI Tokens',
};

function formatUsd(usd: number): string {
  if (usd < 0.001)  return `$${(usd * 1000).toFixed(3)}m`;
  if (usd < 1)      return `$${usd.toFixed(4)}`;
  if (usd < 1000)   return `$${usd.toFixed(2)}`;
  return `$${(usd / 1000).toFixed(2)}k`;
}

const chartConfig = {
  total_usd: { label: 'Cost (USD)', color: 'hsl(var(--chart-1))' },
};

export function CostPanel() {
  const { get } = useControlApi();
  const [costWindow, setCostWindow] = useState<CostWindow>('30d');
  const [data,    setData]    = useState<CostResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (w: CostWindow, showLoading = true) => {
    if (showLoading) setLoading(true);
    const res = await get<CostResponse>(`/api/runtime/control/cost?window=${WINDOW_DAYS[w]}&top=10`);
    if (res) setData(res);
    setLoading(false);
  }, [get]);

  useEffect(() => { void load(costWindow); }, [load, costWindow]);
  useAutoRefresh(() => { void load(costWindow, false); }, 60_000);

  const byTypeData = data
    ? Object.entries(data.summary.byType).map(([type, total]) => ({
        name:      COST_TYPE_LABELS[type] ?? type,
        total_usd: total,
      })).sort((a, b) => b.total_usd - a.total_usd)
    : [];

  return (
    <div className='space-y-4'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <DollarSign className='h-4 w-4 text-muted-foreground' />
          <span className='text-sm font-medium'>Cost Analytics</span>
        </div>
        <div className='flex items-center gap-2'>
          <div className='flex rounded-md border border-border overflow-hidden text-xs'>
            {(['7d', '30d', '90d'] as CostWindow[]).map(w => (
              <button
                key={w}
                onClick={() => setCostWindow(w)}
                className={`px-3 py-1 ${costWindow === w ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
              >
                {w}
              </button>
            ))}
          </div>
          <Button size='sm' variant='ghost' className='h-7 w-7 p-0' onClick={() => void load(costWindow)}>
            <RefreshCw className='h-3 w-3' />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className='space-y-3'>
          <Skeleton className='h-20 w-full rounded-xl' />
          <Skeleton className='h-40 w-full rounded-xl' />
          <Skeleton className='h-40 w-full rounded-xl' />
        </div>
      ) : !data ? (
        <div className='rounded-lg border border-border bg-card p-6 text-center text-xs text-muted-foreground'>
          Failed to load cost data.
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className='grid grid-cols-3 gap-3'>
            <div className='rounded-xl border border-border bg-card p-3'>
              <div className='text-xs text-muted-foreground'>Total ({costWindow})</div>
              <div className='mt-1 text-xl font-semibold'>{formatUsd(data.summary.totalUsd)}</div>
            </div>
            <div className='rounded-xl border border-border bg-card p-3'>
              <div className='flex items-center gap-1 text-xs text-muted-foreground'>
                <TrendingUp className='h-3 w-3' />
                Monthly projection
              </div>
              <div className='mt-1 text-xl font-semibold'>{formatUsd(data.summary.monthlyProjection)}</div>
            </div>
            <div className='rounded-xl border border-border bg-card p-3'>
              <div className='text-xs text-muted-foreground'>Daily avg</div>
              <div className='mt-1 text-xl font-semibold'>
                {formatUsd(data.summary.totalUsd / Math.max(1, WINDOW_DAYS[costWindow]))}
              </div>
            </div>
          </div>

          {/* Cost by type chart */}
          {byTypeData.length > 0 && (
            <div className='rounded-xl border border-border bg-card p-4'>
              <div className='mb-3 text-xs font-medium text-muted-foreground'>Cost by Type</div>
              <ChartContainer config={chartConfig} className='h-36 w-full'>
                <BarChart data={byTypeData} layout='vertical' margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray='3 3' stroke='hsl(var(--border))' horizontal={false} />
                  <XAxis
                    type='number'
                    tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={v => formatUsd(v as number)}
                  />
                  <YAxis
                    type='category'
                    dataKey='name'
                    tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={false}
                    tickLine={false}
                    width={72}
                  />
                  <ChartTooltip
                    content={<ChartTooltipContent indicator='dot' />}
                    formatter={(value: unknown) => [formatUsd(Number(value)), 'Cost']}
                  />
                  <Bar dataKey='total_usd' fill='hsl(var(--chart-1))' radius={[0, 3, 3, 0]} />
                </BarChart>
              </ChartContainer>
            </div>
          )}

          {/* Top costly workflows */}
          {data.topWorkflows.length > 0 && (
            <div className='rounded-xl border border-border bg-card p-4'>
              <div className='mb-3 text-xs font-medium text-muted-foreground'>Top Costly Workflows</div>
              <div className='space-y-1.5'>
                {data.topWorkflows.map((wf, i) => (
                  <div key={wf.workflow_id} className='flex items-center gap-3 text-xs'>
                    <span className='w-5 text-right text-muted-foreground'>{i + 1}.</span>
                    <span className='flex-1 font-mono truncate text-foreground'>
                      {wf.workflow_id.slice(0, 20)}…
                    </span>
                    <Badge variant='outline' className='text-[10px]'>
                      {wf.execution_count} exec{wf.execution_count !== 1 ? 's' : ''}
                    </Badge>
                    <span className='w-20 text-right font-medium'>{formatUsd(wf.total_usd)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.topWorkflows.length === 0 && byTypeData.length === 0 && (
            <div className='rounded-lg border border-border/50 bg-card p-6 text-center text-xs text-muted-foreground'>
              No cost data recorded for the last {costWindow}.
              Cost records are generated when executions complete.
            </div>
          )}
        </>
      )}
    </div>
  );
}
