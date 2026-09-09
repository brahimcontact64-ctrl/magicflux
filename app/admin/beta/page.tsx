'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, TrendingUp, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { supabase } from '@/lib/supabase-client';
import type { BetaFunnelMetrics } from '@/lib/analytics/beta-metrics';

type AccessState = 'checking' | 'allowed' | 'forbidden' | 'unauthorized';

function StatTile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

export default function BetaMetricsPage() {
  const [state, setState] = useState<AccessState>('checking');
  const [metrics, setMetrics] = useState<BetaFunnelMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        if (!cancelled) setState('unauthorized');
        return;
      }

      const res = await fetch('/api/admin/beta-metrics', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });

      if (cancelled) return;
      if (res.status === 401) return setState('unauthorized');
      if (res.status === 403) return setState('forbidden');

      const payload = await res.json().catch(() => ({})) as { metrics?: BetaFunnelMetrics; message?: string };
      if (!res.ok) {
        setError(payload.message ?? 'Failed to load metrics');
        setState('forbidden');
        return;
      }

      setMetrics(payload.metrics ?? null);
      setState('allowed');
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-14 items-center gap-4 border-b border-border bg-card/50 px-6">
        <Link href="/" className="group flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary transition-transform group-hover:scale-105">
            <Zap className="h-3.5 w-3.5 text-primary-foreground" fill="currentColor" />
          </div>
          <span className="text-sm font-semibold">MagicFlux</span>
        </Link>
        <div className="h-4 w-px bg-border" />
        <span className="text-xs text-muted-foreground">Beta Funnel Metrics</span>
        <div className="flex-1" />
        <ThemeToggle />
        <Link href="/admin">
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
        </Link>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        {state === 'checking' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking admin access...
          </div>
        )}

        {state === 'unauthorized' && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-6">
            <p className="text-sm font-semibold text-amber-300">Sign-in required</p>
            <p className="mt-1 text-xs text-amber-200/90">You must sign in with an admin account to view Beta metrics.</p>
          </div>
        )}

        {state === 'forbidden' && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6">
            <p className="text-sm font-semibold text-red-300">Admin access denied</p>
            {error && <p className="mt-1 text-xs text-red-200/90">{error}</p>}
          </div>
        )}

        {state === 'allowed' && metrics && (
          <div className="space-y-6">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              <h1 className="text-lg font-semibold">Free Beta funnel — aggregate only</h1>
            </div>
            <p className="text-xs text-muted-foreground">
              Computed {new Date(metrics.computedAt).toLocaleString()}. Every number below is a count or average over
              existing product tables — no user content, prompts, or credentials.
            </p>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <StatTile label="Signups" value={metrics.signups} sub="auth.users total" />
              <StatTile label="Onboarding completed" value={metrics.onboardingCompleted} />
              <StatTile label="Workflows created" value={metrics.workflowsCreated} />
              <StatTile label="AI generations" value={metrics.aiGenerations} sub="successful generate_workflow_json calls" />
              <StatTile label="Validations / tests" value={metrics.validationsOrTests} sub="mode:'test' executions" />
              <StatTile label="Activations" value={metrics.activations} sub="deployment_versions rows" />
              <StatTile label="Executions (total)" value={metrics.executionsTotal} />
              <StatTile label="Executions succeeded" value={metrics.executionsSuccessful} />
              <StatTile label="Executions failed" value={metrics.executionsFailed} />
              <StatTile label="Active Beta users (7d)" value={metrics.activeBetaUsers7d} />
              <StatTile label="Active Beta users (30d)" value={metrics.activeBetaUsers30d} />
              <StatTile
                label="Feedback"
                value={metrics.feedbackTableMissing ? '—' : metrics.feedbackCount}
                sub={
                  metrics.feedbackTableMissing
                    ? 'product_feedback migration not applied yet'
                    : metrics.feedbackAvgRating != null
                      ? `avg rating ${metrics.feedbackAvgRating.toFixed(1)} / 5`
                      : 'no ratings yet'
                }
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
