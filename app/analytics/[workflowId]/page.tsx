import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getUserFromRequest } from '@/lib/supabase-server';
import { BarChart2 } from 'lucide-react';
import { QualificationAnalyticsPanel } from '@/components/analytics/QualificationAnalyticsPanel';

/**
 * Phase 9.9.13 -- Part I: minimal-viable AI qualification feedback/analytics
 * dashboard, scoped to ONE workflow. Server-side auth guard mirrors
 * app/acknowledgments/page.tsx and app/reviews/page.tsx exactly.
 */
export default async function QualificationAnalyticsPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  const req = { headers: await headers() };
  const user = await getUserFromRequest(req as never);
  if (!user) redirect('/login');

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center gap-3">
        <BarChart2 className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-xl font-semibold text-foreground">AI Qualification Feedback</h1>
          <p className="text-sm text-muted-foreground">What the AI decided, how confident it was, and how often humans agree.</p>
        </div>
      </div>
      <QualificationAnalyticsPanel workflowId={workflowId} />
    </div>
  );
}
