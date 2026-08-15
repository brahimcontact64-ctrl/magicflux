import { CheckCircle2, XCircle, Activity, Clock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { formatDuration } from './DurationBadge';
import type { ExecutionMetrics } from '@/lib/execution/types';

interface Props {
  metrics: ExecutionMetrics;
  windowDays: number;
}

export function ExecutionMetricsBar({ metrics, windowDays }: Props) {
  const tiles = [
    {
      icon:  <Activity className="h-4 w-4 text-blue-500" />,
      label: `Executions (${windowDays}d)`,
      value: metrics.total_executions.toLocaleString(),
    },
    {
      icon:  <CheckCircle2 className="h-4 w-4 text-green-500" />,
      label: 'Success rate',
      value: `${metrics.success_rate.toFixed(1)}%`,
      sub:   `${metrics.success_count} succeeded`,
    },
    {
      icon:  <XCircle className="h-4 w-4 text-red-500" />,
      label: 'Failed',
      value: metrics.failed_count.toLocaleString(),
      sub:   metrics.total_executions > 0
        ? `${((metrics.failed_count / metrics.total_executions) * 100).toFixed(1)}% failure rate`
        : undefined,
    },
    {
      icon:  <Clock className="h-4 w-4 text-purple-500" />,
      label: 'Avg duration',
      value: metrics.avg_duration_ms !== null
        ? formatDuration(metrics.avg_duration_ms)
        : '—',
      sub:   metrics.p95_duration_ms !== null
        ? `p95: ${formatDuration(metrics.p95_duration_ms)}`
        : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {tiles.map((tile) => (
        <Card key={tile.label} className="border-border/60">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              {tile.icon}
              <span className="text-xs text-muted-foreground font-medium">
                {tile.label}
              </span>
            </div>
            <p className="text-2xl font-bold text-foreground">{tile.value}</p>
            {tile.sub && (
              <p className="text-xs text-muted-foreground mt-0.5">{tile.sub}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
