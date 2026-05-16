'use client';

import { CheckCircle2, CircleAlert, Loader2, PauseCircle, TestTube2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type ExecutionStatus = 'simulated_success' | 'success' | 'failed' | 'waiting' | 'running' | 'cancelled';

const STYLES: Record<ExecutionStatus, { label: string; className: string; icon: React.ElementType }> = {
  simulated_success: {
    label: 'SIMULATED TEST',
    className: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
    icon: TestTube2,
  },
  success: {
    label: 'LIVE SUCCESS',
    className: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
    icon: CheckCircle2,
  },
  failed: {
    label: 'FAILED',
    className: 'text-red-300 border-red-500/30 bg-red-500/10',
    icon: XCircle,
  },
  waiting: {
    label: 'WAITING',
    className: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
    icon: PauseCircle,
  },
  running: {
    label: 'RUNNING',
    className: 'text-blue-300 border-blue-500/30 bg-blue-500/10',
    icon: Loader2,
  },
  cancelled: {
    label: 'CANCELLED',
    className: 'text-muted-foreground border-border bg-muted/20',
    icon: CircleAlert,
  },
};

export function ExecutionStatusBadge({ status, className }: { status: ExecutionStatus; className?: string }) {
  const style = STYLES[status];
  const Icon = style.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium', style.className, className)}>
      <Icon className={cn('h-3.5 w-3.5', status === 'running' && 'animate-spin')} />
      {style.label}
    </span>
  );
}
