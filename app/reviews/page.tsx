import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getUserFromRequest } from '@/lib/supabase-server';
import { ClipboardCheck } from 'lucide-react';
import { ReviewsPanel } from '@/components/reviews/ReviewsPanel';

/**
 * Phase 9.9.2 -- minimum-viable Founder/admin Pending Reviews page.
 * Server-side auth guard mirrors app/executions/page.tsx exactly (same
 * header-forwarding fix that page's own history required).
 */
export default async function ReviewsPage() {
  const req = { headers: await headers() };
  const user = await getUserFromRequest(req as never);
  if (!user) redirect('/login');

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto w-full">
      <div className="flex items-center gap-3">
        <ClipboardCheck className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-xl font-semibold text-foreground">Pending Reviews</h1>
          <p className="text-sm text-muted-foreground">Workflows waiting on a human decision before they continue.</p>
        </div>
      </div>
      <ReviewsPanel />
    </div>
  );
}
