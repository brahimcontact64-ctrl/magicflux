'use client';

import { Crown } from 'lucide-react';
import { cn } from '@/lib/utils';

type PlanSlug = 'free' | 'pro' | 'business';

const STYLE: Record<PlanSlug, string> = {
  free: 'text-slate-300 border-slate-500/30 bg-slate-500/10',
  pro: 'text-blue-300 border-blue-500/30 bg-blue-500/10',
  business: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
};

export function PlanBadge({ plan }: { plan: PlanSlug }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide', STYLE[plan])}>
      <Crown className='h-3.5 w-3.5' />
      {plan}
    </span>
  );
}
