'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function SetupRequiredAlert({
  missingIntegrations,
  href = '/settings/integrations',
}: {
  missingIntegrations: string[];
  href?: string;
}) {
  if (missingIntegrations.length === 0) return null;

  return (
    <div className='rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs'>
      <p className='flex items-center gap-2 font-medium text-amber-300'>
        <AlertTriangle className='h-4 w-4' />
        Setup required before live test/deploy
      </p>
      <p className='mt-1 text-amber-200/90'>Missing integrations: {missingIntegrations.join(', ')}</p>
      <div className='mt-2'>
        <Link href={href}>
          <Button size='sm'>Open Integration Setup</Button>
        </Link>
      </div>
    </div>
  );
}
