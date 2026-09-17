'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, BarChart2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Phase 9.9.13 -- Part F: this UI must NEVER call AI/human agreement
// "accuracy" -- a human decision is feedback, not verified ground truth.
// Every label below says "AI/Human Agreement" or "Override Rate" only.

type Distribution = { label: string; count: number; rate: number | null };
type RateStat = { count: number; rate: number | null };
type AgreementStat = { count: number; denominator: number; rate: number | null };
type OverrideDirection = { from: string; to: string; count: number };
type ConfidenceBucket = { range: string; count: number };
type PolicyVersion = { hash: string; count: number };

type QualificationMetrics = {
  workflowId: string;
  total: number;
  automaticCount: number;
  humanReview: RateStat;
  agreement: AgreementStat;
  override: AgreementStat;
  aiClassificationDistribution: Distribution[];
  finalClassificationDistribution: Distribution[];
  avgConfidence: number | null;
  confidenceBuckets: ConfidenceBucket[];
  overridesByDirection: OverrideDirection[];
  needsInformation: RateStat;
  contradictions: RateStat;
  policyVersions: PolicyVersion[];
};

// Fixed categorical hue order (never cycled/reassigned by data) -- up to 5
// distinct labels get their own color; anything beyond that folds into a
// shared "more" shade rather than generating new hues indefinitely.
const CATEGORY_COLORS = ['bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-violet-500'];
const OVERFLOW_COLOR = 'bg-slate-400';

// Sequential, single-hue, light -> dark -- confidence buckets are ordered
// magnitude, not identity.
const CONFIDENCE_COLORS = ['bg-blue-200', 'bg-blue-300', 'bg-blue-400', 'bg-blue-500', 'bg-blue-600'];

function formatPct(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 1000) / 10}%`;
}

function StatCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function BarList({ items, colors }: { items: { label: string; count: number; rate: number | null }[]; colors: string[] }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, idx) => (
        <div key={item.label} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">{item.label}</span>
          <div className="h-3 flex-1 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full ${colors[idx] ?? OVERFLOW_COLOR}`}
              style={{ width: `${(item.count / max) * 100}%` }}
            />
          </div>
          <span className="w-20 shrink-0 text-right text-xs tabular-nums text-foreground">
            {item.count} ({formatPct(item.rate)})
          </span>
        </div>
      ))}
    </div>
  );
}

export function QualificationAnalyticsPanel({ workflowId }: { workflowId: string }) {
  const [metrics, setMetrics] = useState<QualificationMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/analytics/qualification?workflow_id=${encodeURIComponent(workflowId)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Failed to load qualification analytics.');
        return;
      }
      setMetrics(body as QualificationMetrics);
    } catch {
      setError('Network error while loading qualification analytics.');
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }

  if (!metrics) return null;

  // Part I -- honest empty/insufficient-sample states. Never a percentage
  // computed against a zero denominator anywhere below.
  if (metrics.total === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card py-16 text-muted-foreground">
        <BarChart2 className="h-8 w-8" />
        <p className="text-sm">No AI qualification decisions recorded yet for this workflow.</p>
        <p className="text-xs">Metrics will appear here once this workflow classifies its first real lead.</p>
      </div>
    );
  }

  const INSUFFICIENT_SAMPLE = 5;
  const sampleTooSmallForAgreement = metrics.agreement.denominator < INSUFFICIENT_SAMPLE;

  const multiplePolicyVersions = metrics.policyVersions.length > 1;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={load}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>

      {/* Phase 9.9.13A Part L -- overview cards below blend every decision
          for this workflow regardless of which qualification ruleset
          produced it (see the Policy Versions section for the exact
          breakdown). Surfaced HERE, not only in that section further down,
          so nobody reads "80% agreement" as comparable across a rule
          change without first seeing this caveat. */}
      {multiplePolicyVersions ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-300">
          This workflow&apos;s qualification rules changed at least once during this history. The totals below blend decisions from {metrics.policyVersions.length} different rule-sets -- see &quot;Policy Versions&quot; below before treating them as one comparable trend.
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="Total Qualifications" value={String(metrics.total)} />
        <StatCard
          title="Human Review Rate"
          value={formatPct(metrics.humanReview.rate)}
          sub={`${metrics.humanReview.count} of ${metrics.total} reviewed by a human`}
        />
        <StatCard
          title="Average AI Confidence"
          value={metrics.avgConfidence === null ? '—' : `${Math.round(metrics.avgConfidence * 100)}%`}
        />
        <StatCard
          title="AI/Human Agreement"
          value={sampleTooSmallForAgreement ? 'Not enough data yet' : formatPct(metrics.agreement.rate)}
          sub={
            metrics.agreement.denominator === 0
              ? 'No human decisions yet -- this is feedback, not accuracy.'
              : `${metrics.agreement.count} of ${metrics.agreement.denominator} human-reviewed decisions matched the AI`
          }
        />
        <StatCard
          title="Override Rate"
          value={sampleTooSmallForAgreement ? 'Not enough data yet' : formatPct(metrics.override.rate)}
          sub={
            metrics.override.denominator === 0
              ? 'No human decisions yet.'
              : `${metrics.override.count} of ${metrics.override.denominator} human-reviewed decisions changed the label`
          }
        />
        <StatCard
          title="Needs More Information"
          value={formatPct(metrics.needsInformation.rate)}
          sub={`${metrics.needsInformation.count} of ${metrics.total} missing required qualification evidence`}
        />
        <StatCard
          title="Contradiction Rate"
          value={formatPct(metrics.contradictions.rate)}
          sub={`${metrics.contradictions.count} of ${metrics.total} flagged a contradiction`}
        />
      </div>

      <section className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">AI Classification Distribution</h2>
        <BarList items={metrics.aiClassificationDistribution} colors={CATEGORY_COLORS} />
      </section>

      <section className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">Final Classification Distribution</h2>
        <p className="text-xs text-muted-foreground">After any human override -- what actually happened, not just what the AI proposed.</p>
        <BarList items={metrics.finalClassificationDistribution} colors={CATEGORY_COLORS} />
      </section>

      <section className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">AI Confidence Distribution</h2>
        <BarList
          items={metrics.confidenceBuckets.map((b) => ({ label: b.range, count: b.count, rate: metrics.total > 0 ? b.count / metrics.total : null }))}
          colors={CONFIDENCE_COLORS}
        />
      </section>

      <section className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">Override Directions</h2>
        {metrics.overridesByDirection.length === 0 ? (
          <p className="text-sm text-muted-foreground">No overrides recorded yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {metrics.overridesByDirection.map((d) => (
              <div key={`${d.from}-${d.to}`} className="flex items-center gap-2 text-sm">
                <span className="font-medium">{d.from}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{d.to}</span>
                <span className="text-xs text-muted-foreground">({d.count})</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {metrics.policyVersions.length > 1 ? (
        <section className="rounded-xl border border-border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold">Policy Versions</h2>
          <p className="text-xs text-muted-foreground">
            This workflow&apos;s qualification rules changed at least once during this history -- decisions below are grouped by the exact ruleset that produced them, so results are never silently blended across different policies.
          </p>
          <div className="flex flex-col gap-1.5">
            {metrics.policyVersions.map((p) => (
              <div key={p.hash} className="flex items-center justify-between text-xs">
                <span className="font-mono text-muted-foreground">{p.hash.slice(0, 12)}…</span>
                <span className="tabular-nums">{p.count} decisions</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
