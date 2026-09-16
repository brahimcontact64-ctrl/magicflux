'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Inbox, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';

// Phase 9.9.12 -- deliberately a SEPARATE concept from Human Review's own
// pending -> resume_pending -> resumed lifecycle (see ReviewsPanel.tsx):
// `status` here is the SLA OUTCOME itself (pending -> acknowledged XOR
// pending -> timed_out), not a resume-in-progress marker -- resume
// crash-safety is tracked separately server-side (resumed_at) and never
// surfaced as a distinct dashboard state, since it's not actionable by a
// user the way "still awaiting acknowledgment" or "already breached" are.
type AcknowledgmentItem = {
  id: string;
  workflow_id: string;
  execution_id: string;
  node_name: string | null;
  status: 'pending' | 'acknowledged' | 'timed_out';
  deadline_at: string;
  escalation_level: number;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  late_acknowledged_by: string | null;
  late_acknowledged_at: string | null;
  created_at: string;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function isOverdue(item: AcknowledgmentItem): boolean {
  return item.status === 'pending' && new Date(item.deadline_at).getTime() < Date.now();
}

function StatusPill({ item }: { item: AcknowledgmentItem }) {
  if (item.status === 'acknowledged') {
    return <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">acknowledged</span>;
  }
  if (item.status === 'timed_out') {
    return <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300">SLA breached — escalated</span>;
  }
  if (isOverdue(item)) {
    return <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">overdue — escalating shortly</span>;
  }
  return <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">awaiting acknowledgment</span>;
}

function AcknowledgmentCard({ item, onDecided }: { item: AcknowledgmentItem; onDecided: () => void }) {
  const [acking, setAcking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const acknowledge = useCallback(async () => {
    setAcking(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/acknowledgments/${item.id}/decide`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? 'Failed to record acknowledgment.');
        return;
      }
      if (body.lateAcknowledgment) {
        // Part H -- never presented as a normal success; the breach already happened.
        setNotice(body.message ?? 'This item already breached its SLA. Your acknowledgment was recorded, but the breach remains on record.');
      }
      onDecided();
    } catch {
      setError('Network error while recording your acknowledgment.');
    } finally {
      setAcking(false);
    }
  }, [item.id, onDecided]);

  return (
    <div className="rounded-lg border border-border/60 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground truncate">{item.node_name ?? 'Awaiting acknowledgment'}</div>
          <div className="text-xs text-muted-foreground">
            workflow {item.workflow_id.slice(0, 8)} · execution {item.execution_id.slice(0, 8)} · deadline {formatDate(item.deadline_at)}
            {item.escalation_level > 0 ? ` · escalation level ${item.escalation_level}` : ''}
          </div>
        </div>
        <StatusPill item={item} />
      </div>

      {item.status === 'pending' ? (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={acking} onClick={acknowledge}>
            <CheckCircle2 className="h-4 w-4 mr-1" />
            {acking ? 'Recording…' : 'Acknowledge'}
          </Button>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          {item.status === 'timed_out' ? <AlertTriangle className="h-3.5 w-3.5 text-red-500" /> : null}
          {item.status === 'acknowledged'
            ? <>Acknowledged{item.acknowledged_at ? ` · ${formatDate(item.acknowledged_at)}` : ''}</>
            : <>SLA breached at {formatDate(item.deadline_at)} — escalation branch taken</>}
          {item.late_acknowledged_at ? (
            <span className="ml-1">· late acknowledgment recorded {formatDate(item.late_acknowledged_at)}</span>
          ) : null}
        </div>
      )}

      {item.status === 'timed_out' && !item.late_acknowledged_at ? (
        <Button size="sm" variant="outline" disabled={acking} onClick={acknowledge}>
          {acking ? 'Recording…' : 'Acknowledge anyway (late)'}
        </Button>
      ) : null}

      {notice ? <p className="text-xs text-amber-700 dark:text-amber-400">{notice}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function AcknowledgmentsPanel() {
  const [items, setItems] = useState<AcknowledgmentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async (all: boolean) => {
    setError(null);
    try {
      const res = await fetch(`/api/acknowledgments?status=${all ? 'all' : 'pending'}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? 'Failed to load acknowledgment items.');
        return;
      }
      setItems(body.items ?? []);
    } catch {
      setError('Network error while loading acknowledgment items.');
    }
  }, []);

  useEffect(() => { load(showAll); }, [load, showAll]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button size="sm" variant={showAll ? 'outline' : 'default'} onClick={() => setShowAll(false)}>Awaiting</Button>
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
          <p className="text-sm">{showAll ? 'No acknowledgment items yet.' : 'Nothing awaiting acknowledgment.'}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <AcknowledgmentCard key={item.id} item={item} onDecided={() => load(showAll)} />
          ))}
        </div>
      )}
    </div>
  );
}
