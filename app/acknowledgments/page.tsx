import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getUserFromRequest } from '@/lib/supabase-server';
import { AlarmClock } from 'lucide-react';
import { AcknowledgmentsPanel } from '@/components/acknowledgments/AcknowledgmentsPanel';

/**
 * Phase 9.9.12 -- Part L: minimum-viable SLA Acknowledgment dashboard page.
 * Server-side auth guard mirrors app/reviews/page.tsx exactly. Deliberately
 * a SEPARATE page/route from /reviews -- acknowledgment ("has a human
 * taken ownership before a deadline") and Human Review ("what should the
 * AI have decided instead") solve different problems and must not be
 * conflated in the product either.
 */
export default async function AcknowledgmentsPage() {
  const req = { headers: await headers() };
  const user = await getUserFromRequest(req as never);
  if (!user) redirect('/login');

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto w-full">
      <div className="flex items-center gap-3">
        <AlarmClock className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-xl font-semibold text-foreground">SLA Acknowledgments</h1>
          <p className="text-sm text-muted-foreground">Items awaiting a human to take ownership before their deadline escalates.</p>
        </div>
      </div>
      <AcknowledgmentsPanel />
    </div>
  );
}
