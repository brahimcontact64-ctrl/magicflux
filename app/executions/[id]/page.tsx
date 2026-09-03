import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getUserFromRequest } from '@/lib/supabase-server';
import { fetchExecutionDetail } from '@/lib/execution/client';
import { ExecutionDetailView } from '@/components/execution/ExecutionDetailView';

type Ctx = { params: { id: string } };

export default async function ExecutionDetailPage({ params }: Ctx) {
  // Auth guard
  //
  // Phase 9.5 Step H: previously wrapped the header list in
  // Object.fromEntries(...), producing a plain object -- but
  // getUserFromRequest() calls req.headers.get(...), which a plain object
  // does not have. That threw on every single visit to this page ("server-
  // side exception"), confirmed live: a fixtured non-terminal execution
  // never rendered at all. next/headers' headers() already returns a
  // Headers-like object with .get(), so it can be passed straight through.
  const req = { headers: await headers() };
  const user = await getUserFromRequest(req as never);
  if (!user) redirect('/login');

  // Fetch execution data (server-side, initial paint). Live updates after
  // that are handled client-side by ExecutionDetailView (Phase 9.4.3 Step
  // G) via the same ownership-checked GET /api/executions/[id] route.
  //
  // Phase 9.5 Step H: this fetch() runs on the server -- no browser cookie
  // jar to auto-attach the visitor's session the way a client component's
  // fetch() would. Without forwarding the cookie explicitly here, this call
  // was unauthenticated and genuinely 404'd for lack of ownership every
  // time, regardless of the Object.fromEntries(...) fix above -- confirmed
  // live with a fixtured execution the requesting user actually owned.
  let execution;
  try {
    const res = await fetchExecutionDetail(params.id, { cookie: req.headers.get('cookie') ?? '' });
    execution = res.execution;
  } catch {
    notFound();
  }

  return <ExecutionDetailView initialExecution={execution} />;
}
