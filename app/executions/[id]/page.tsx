import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getUserFromRequest } from '@/lib/supabase-server';
import { fetchExecutionDetail } from '@/lib/execution/client';
import { ExecutionDetailView } from '@/components/execution/ExecutionDetailView';

type Ctx = { params: { id: string } };

export default async function ExecutionDetailPage({ params }: Ctx) {
  // Auth guard
  const req = { headers: Object.fromEntries((await headers()).entries()) };
  const user = await getUserFromRequest(req as never);
  if (!user) redirect('/login');

  // Fetch execution data (server-side, initial paint). Live updates after
  // that are handled client-side by ExecutionDetailView (Phase 9.4.3 Step
  // G) via the same ownership-checked GET /api/executions/[id] route.
  let execution;
  try {
    const res = await fetchExecutionDetail(params.id);
    execution = res.execution;
  } catch {
    notFound();
  }

  return <ExecutionDetailView initialExecution={execution} />;
}
