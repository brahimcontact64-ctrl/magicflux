'use client';

import { useMemo } from 'react';
import { useWorkflowConfigDraft } from './useWorkflowConfigDraft';
import { computeBranchOverview, type Connections } from '@/lib/workflow/branch-overview';

/**
 * Phase 9.9.16/9.9.16A -- Part I: a read-only, best-effort structural
 * summary of what each classification branch actually does ("does Hot get
 * Airtable/Gmail/Slack/SLA") without building a full visual BPM editor.
 * The actual computation lives in lib/workflow/branch-overview.ts (unit-
 * tested there); this component only fetches the draft and renders it.
 */
export function BranchOverviewPanel({ workflowId }: { workflowId: string }) {
  const { draft, loading } = useWorkflowConfigDraft(workflowId);

  const summary = useMemo(() => {
    if (!draft) return null;
    return computeBranchOverview(draft.nodes, (draft.connections ?? {}) as Connections);
  }, [draft]);

  if (loading || !summary || summary.branches.length === 0) return null;

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Branch Overview</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          What each classification actually does, at a glance. Best-effort structural summary derived from the workflow graph{!summary.labelsMatch ? ' -- branch names could not be matched to classification labels exactly, so they are numbered' : ''}.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {summary.branches.map((b) => (
          <div key={b.label} className="rounded-lg border border-border bg-muted/10 p-3 space-y-1.5">
            <p className="text-xs font-semibold">{b.label}</p>
            {(['airtable', 'gmail', 'slack', 'sla'] as const).map((cap) => (
              <div key={cap} className="flex items-center justify-between text-[11px]">
                <span className="capitalize text-muted-foreground">{cap === 'gmail' ? 'Gmail' : cap === 'sla' ? 'SLA' : cap.charAt(0).toUpperCase() + cap.slice(1)}</span>
                <span className={b[cap] ? 'text-emerald-500' : 'text-muted-foreground'}>{b[cap] ? '✓' : '—'}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
