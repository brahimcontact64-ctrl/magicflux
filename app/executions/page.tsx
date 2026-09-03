import { Suspense } from 'react';
import { Activity } from 'lucide-react';
import { getUserFromRequest } from '@/lib/supabase-server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { fetchExecutionMetrics } from '@/lib/execution/client';
import { ExecutionMetricsBar } from '@/components/execution/ExecutionMetricsBar';
import { ExecutionListTable } from '@/components/execution/ExecutionListTable';
import { Skeleton } from '@/components/ui/skeleton';

// ── Metrics panel — server-fetched, re-runs on each page load ─────────────────

async function MetricsPanel() {
  try {
    // Phase 9.5 Step H: forward the cookie explicitly -- this fetch() runs
    // server-side with no browser cookie jar to inherit one from
    // automatically, so without this it silently fetched unauthenticated
    // and always fell into the catch below, permanently showing "Metrics
    // unavailable" regardless of the visitor's real session.
    const cookie = (await headers()).get('cookie') ?? '';
    const { metrics, window_days } = await fetchExecutionMetrics(undefined, 30, { cookie });
    return <ExecutionMetricsBar metrics={metrics} windowDays={window_days} />;
  } catch {
    return (
      <div className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
        Metrics unavailable
      </div>
    );
  }
}

function MetricsSkeleton() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {[0, 1, 2, 3].map(i => (
        <Skeleton key={i} className="h-24 rounded-lg" />
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function ExecutionsPage() {
  // Server-side auth guard
  //
  // Phase 9.5 Step H: same bug as app/executions/[id]/page.tsx -- wrapping
  // the header list in Object.fromEntries(...) produced a plain object,
  // but getUserFromRequest() calls req.headers.get(...), which a plain
  // object doesn't have. Confirmed live (server log): "TypeError:
  // e.headers.get is not a function" on every authenticated visit to this
  // page -- the entire executions list crashed for any logged-in user.
  const req = { headers: await headers() };
  const user = await getUserFromRequest(req as never);
  if (!user) redirect('/login');

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-blue-50 p-2">
          <Activity className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-foreground">Execution History</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Inspect, debug, and analyze every workflow run.
          </p>
        </div>
      </div>

      {/* Metrics */}
      <Suspense fallback={<MetricsSkeleton />}>
        <MetricsPanel />
      </Suspense>

      {/* List table — fully client-side for filtering + pagination */}
      <ExecutionListTable />
    </div>
  );
}
