'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Inbox, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';

// `status` is the resume LIFECYCLE (pending -> resume_pending -> resumed),
// not the decision's own value -- decision_outcome carries approve/reject/
// custom regardless of lifecycle stage (see lib/runtime/review-resume.ts).
type ReviewItem = {
  id: string;
  workflow_id: string;
  execution_id: string;
  node_name: string | null;
  status: 'pending' | 'resume_pending' | 'resumed';
  allowed_outcomes: string[];
  decision_outcome: string | null;
  instruction: string | null;
  review_context: Record<string, unknown>;
  reviewed_at: string | null;
  created_at: string;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function StatusPill({ item }: { item: ReviewItem }) {
  if (item.status === 'pending') {
    return <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">pending</span>;
  }
  // Decided (resume_pending or resumed) -- lead with the decision itself,
  // since that's what a reviewer cares about; resume_pending additionally
  // means "still finishing up," not "needs another decision."
  const decisionStyle = item.decision_outcome === 'approve'
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
    : item.decision_outcome === 'reject'
      ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
      : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${decisionStyle}`}>{item.decision_outcome}</span>
      {item.status === 'resume_pending' ? (
        <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">finishing…</span>
      ) : null}
    </span>
  );
}

function ReviewCard({ item, onDecided }: { item: ReviewItem; onDecided: () => void }) {
  const [deciding, setDeciding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = useCallback(async (decision: string) => {
    setDeciding(decision);
    setError(null);
    try {
      const res = await fetch(`/api/reviews/${item.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? 'Failed to record decision.');
        return;
      }
      onDecided();
    } catch {
      setError('Network error while recording your decision.');
    } finally {
      setDeciding(null);
    }
  }, [item.id, onDecided]);

  const outcomes = item.allowed_outcomes?.length > 0 ? item.allowed_outcomes : ['approve', 'reject'];

  return (
    <div className="rounded-lg border border-border/60 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground truncate">{item.node_name ?? 'Review step'}</div>
          <div className="text-xs text-muted-foreground">workflow {item.workflow_id.slice(0, 8)} · execution {item.execution_id.slice(0, 8)} · {formatDate(item.created_at)}</div>
        </div>
        <StatusPill item={item} />
      </div>

      {item.instruction ? <p className="text-sm text-foreground/90">{item.instruction}</p> : null}

      <div className="rounded-md bg-muted/50 p-3 text-xs font-mono overflow-x-auto max-h-40 overflow-y-auto">
        <pre className="whitespace-pre-wrap break-words">{JSON.stringify(item.review_context ?? {}, null, 2)}</pre>
      </div>

      {item.status === 'pending' ? (
        <div className="flex items-center gap-2 flex-wrap">
          {outcomes.map((outcome) => (
            <Button
              key={outcome}
              size="sm"
              variant={outcome === 'approve' ? 'default' : outcome === 'reject' ? 'destructive' : 'outline'}
              disabled={deciding !== null}
              onClick={() => decide(outcome)}
            >
              {outcome === 'approve' ? <CheckCircle2 className="h-4 w-4 mr-1" /> : outcome === 'reject' ? <XCircle className="h-4 w-4 mr-1" /> : null}
              {deciding === outcome ? 'Recording…' : outcome}
            </Button>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          Decided: <span className="font-medium text-foreground">{item.decision_outcome}</span>
          {item.reviewed_at ? ` · ${formatDate(item.reviewed_at)}` : ''}
        </div>
      )}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function ReviewsPanel() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async (all: boolean) => {
    setError(null);
    try {
      const res = await fetch(`/api/reviews?status=${all ? 'all' : 'pending'}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? 'Failed to load reviews.');
        return;
      }
      setItems(body.items ?? []);
    } catch {
      setError('Network error while loading reviews.');
    }
  }, []);

  useEffect(() => { load(showAll); }, [load, showAll]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button size="sm" variant={showAll ? 'outline' : 'default'} onClick={() => setShowAll(false)}>Pending</Button>
          <Button size="sm" variant={showAll ? 'default' : 'outline'} onClick={() => setShowAll(true)}>All</Button>
        </div>
        <Button size="sm" variant="ghost" onClick={() => load(showAll)}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {items === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
          <Inbox className="h-8 w-8" />
          <p className="text-sm">{showAll ? 'No review items yet.' : 'No pending reviews.'}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <ReviewCard key={item.id} item={item} onDecided={() => load(showAll)} />
          ))}
        </div>
      )}
    </div>
  );
}
