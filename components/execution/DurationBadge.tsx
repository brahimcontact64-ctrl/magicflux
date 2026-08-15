import { cn } from '@/lib/utils';

interface Props {
  ms: number | null | undefined;
  className?: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function DurationBadge({ ms, className }: Props) {
  if (ms === null || ms === undefined) {
    return <span className={cn('text-xs text-muted-foreground', className)}>—</span>;
  }
  return (
    <span className={cn('text-xs text-muted-foreground tabular-nums', className)}>
      {formatDuration(ms)}
    </span>
  );
}

export { formatDuration };
