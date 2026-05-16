'use client';

import { cn } from '@/lib/utils';

export function UsageMeter({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number;
}) {
  const unlimited = limit === -1;
  const percent = unlimited ? 0 : Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  const nearLimit = !unlimited && percent >= 90;

  return (
    <div className='space-y-1'>
      <div className='flex items-center justify-between text-xs'>
        <span className='text-muted-foreground'>{label}</span>
        <span className={cn('font-medium', nearLimit ? 'text-amber-300' : 'text-foreground')}>
          {used}{unlimited ? '' : `/${limit}`}
        </span>
      </div>
      {!unlimited && (
        <div className='h-1.5 w-full rounded-full bg-muted overflow-hidden'>
          <div
            className={cn('h-full transition-all', nearLimit ? 'bg-amber-400' : 'bg-primary')}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}
