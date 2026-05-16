'use client';

import { CheckCircle2, CircleAlert, PlugZap } from 'lucide-react';
import { cn } from '@/lib/utils';

type IntegrationStatus = 'connected' | 'invalid' | 'not_connected';

const STYLE: Record<IntegrationStatus, { label: string; className: string; icon: React.ElementType }> = {
  connected: {
    label: 'Connected',
    className: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
    icon: CheckCircle2,
  },
  invalid: {
    label: 'Invalid',
    className: 'text-red-300 border-red-500/30 bg-red-500/10',
    icon: CircleAlert,
  },
  not_connected: {
    label: 'Not connected',
    className: 'text-muted-foreground border-border bg-muted/20',
    icon: PlugZap,
  },
};

export function IntegrationStatusBadge({ status }: { status: IntegrationStatus }) {
  const style = STYLE[status];
  const Icon = style.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium', style.className)}>
      <Icon className='h-3.5 w-3.5' />
      {style.label}
    </span>
  );
}
