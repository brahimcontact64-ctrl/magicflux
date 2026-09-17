'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ChevronDown, ChevronRight, Phone, Trophy, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// Phase 9.9.15A Part G -- mirrors the server's own REVENUE_PATTERN exactly
// (lib/runtime/lead-lifecycle.ts) so a malformed amount is caught with an
// immediate, specific message before the request is even sent.
const REVENUE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Phase 9.9.15 -- Part J: the minimal single-lead inspector. Shows the
 * THREE independent dimensions (Part B) side by side, never collapsed
 * into one ambiguous status:
 *   AI: Hot (92%)          -- immutable, from ai-classifier.ts
 *   Human Review: Warm     -- or "Not reviewed"
 *   SLA: Acknowledged      -- or "Breached" / "Awaiting" / "N/A"
 *   Lifecycle: Contacted   -- or "New"
 *   Outcome: Won ($5,000 USD) -- or "Lost" / "Pending"
 *
 * Recording an outcome here calls ONLY
 * /api/qualification-decisions/[id]/outcome -- never re-runs the workflow,
 * never touches Gmail/Slack/Airtable (Part M).
 */

type ListItem = {
  id: string;
  execution_id: string;
  created_at: string;
  ai_classification: string;
  ai_confidence: number;
  human_review_occurred: boolean;
  human_classification: string | null;
  final_classification: string;
  overridden: boolean | null;
  outcome_status: string | null;
  outcome_revenue: number | null;
  outcome_currency: string | null;
};

type Detail = {
  decision: ListItem & { ai_reason: string | null; needs_review: boolean; qualification_status: string | null };
  acknowledgment: { status: string; deadline_at: string; acknowledged_at: string | null; escalation_level: number } | null;
  lifecycleHistory: Array<{ previousStatus: string | null; newStatus: string; note: string | null; revenue: number | null; currency: string | null; createdAt: string }>;
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function slaLabel(ack: Detail['acknowledgment']): string {
  if (!ack) return 'N/A';
  if (ack.status === 'acknowledged') return 'Acknowledged';
  if (ack.status === 'timed_out') return 'Breached';
  return 'Awaiting';
}

function outcomeLabel(item: Pick<ListItem, 'outcome_status' | 'outcome_revenue' | 'outcome_currency'>): string {
  if (!item.outcome_status) return 'Pending';
  if (item.outcome_status === 'won' && item.outcome_revenue != null && item.outcome_currency) {
    return `Won (${item.outcome_revenue.toLocaleString()} ${item.outcome_currency})`;
  }
  return item.outcome_status.charAt(0).toUpperCase() + item.outcome_status.slice(1);
}

function LeadRow({ item, onChanged }: { item: ListItem; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revenue, setRevenue] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [note, setNote] = useState('');

  const loadDetail = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/qualification-decisions/${item.id}`);
    if (res.ok) setDetail(await res.json());
    setLoading(false);
  }, [item.id]);

  useEffect(() => { if (expanded && !detail) void loadDetail(); }, [expanded, detail, loadDetail]);

  const [pendingTerminal, setPendingTerminal] = useState<'won' | 'lost' | null>(null);

  const act = useCallback(async (action: 'contacted' | 'won' | 'lost') => {
    setActing(action);
    setError(null);
    // Phase 9.9.15A Part G -- revenue is sent as the EXACT string the user
    // typed, never Number(revenue) -- the server is the one place that
    // ever converts it, only after validating its shape.
    const body: Record<string, unknown> = { action, note: note || undefined };
    if (action === 'won' && revenue) {
      const trimmed = revenue.trim();
      if (!REVENUE_PATTERN.test(trimmed)) {
        setError('Revenue must be a plain amount like "125000.50" -- no currency symbol, no commas, no negative sign.');
        setActing(null);
        return;
      }
      body.revenue = trimmed;
      body.currency = currency;
    }
    const res = await fetch(`/api/qualification-decisions/${item.id}/outcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    setActing(null);
    if (!res.ok) {
      setError(payload.error ?? 'Failed to record outcome.');
      return;
    }
    setNote('');
    await loadDetail();
    onChanged();
  }, [item.id, note, revenue, currency, loadDetail, onChanged]);

  // Phase 9.9.15A Part E -- Won/Lost are terminal in V1 (no undo/edit
  // exists) -- a confirmation step makes that explicit BEFORE the action
  // is taken, since there is genuinely no working "Undo" to fall back on.
  const requestTerminal = useCallback((action: 'won' | 'lost') => {
    if (action === 'won' && revenue && !REVENUE_PATTERN.test(revenue.trim())) {
      setError('Revenue must be a plain amount like "125000.50" -- no currency symbol, no commas, no negative sign.');
      return;
    }
    setError(null);
    setPendingTerminal(action);
  }, [revenue]);

  const confirmTerminal = useCallback(() => {
    if (!pendingTerminal) return;
    const action = pendingTerminal;
    setPendingTerminal(null);
    void act(action);
  }, [pendingTerminal, act]);

  const outcome = detail?.decision.outcome_status ?? item.outcome_status;
  const isTerminal = outcome === 'won' || outcome === 'lost';

  return (
    <div className="rounded-lg border border-border bg-card">
      <button className="flex w-full items-center gap-3 p-3 text-left" onClick={() => setExpanded((v) => !v)}>
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <span className="text-xs text-muted-foreground w-32 shrink-0">{fmtDate(item.created_at)}</span>
        <span className="text-xs font-medium w-20 shrink-0">AI: {item.ai_classification}</span>
        <span className="text-xs text-muted-foreground w-32 shrink-0">
          Human: {item.human_review_occurred ? item.human_classification : 'Not reviewed'}
        </span>
        <span className="text-xs w-40 shrink-0">Outcome: {outcomeLabel(item)}</span>
      </button>

      {expanded && (
        <div className="border-t border-border p-3 space-y-3">
          {loading || !detail ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                <div>
                  <p className="text-muted-foreground">AI</p>
                  <p className="font-medium">{detail.decision.ai_classification} ({Math.round(detail.decision.ai_confidence * 100)}%)</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Human Review</p>
                  <p className="font-medium">{detail.decision.human_review_occurred ? detail.decision.human_classification : 'Not reviewed'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">SLA</p>
                  <p className="font-medium">{slaLabel(detail.acknowledgment)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Lifecycle</p>
                  <p className="font-medium">{outcome === 'contacted' ? 'Contacted' : outcome ? outcomeLabel(detail.decision) : 'New'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Outcome</p>
                  <p className="font-medium">{outcomeLabel(detail.decision)}</p>
                </div>
              </div>

              {detail.lifecycleHistory.length > 0 && (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {detail.lifecycleHistory.map((h, i) => (
                    <p key={i}>{fmtDate(h.createdAt)}: {h.previousStatus ?? 'new'} → {h.newStatus}{h.note ? ` — "${h.note}"` : ''}</p>
                  ))}
                </div>
              )}

              {error && <p className="text-xs text-destructive">{error}</p>}

              {!isTerminal ? (
                <div className="flex flex-wrap items-end gap-2">
                  {outcome !== 'contacted' && (
                    <Button size="sm" variant="outline" disabled={!!acting} onClick={() => act('contacted')}>
                      <Phone className="h-3.5 w-3.5 mr-1" /> Contacted
                    </Button>
                  )}
                  <div className="flex items-end gap-1">
                    <Input placeholder="Revenue" value={revenue} onChange={(e) => setRevenue(e.target.value)} className="h-8 w-24 text-xs" />
                    <Input placeholder="USD" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} className="h-8 w-16 text-xs" maxLength={3} />
                    <Button size="sm" variant="outline" disabled={!!acting} onClick={() => requestTerminal('won')}>
                      <Trophy className="h-3.5 w-3.5 mr-1" /> Won
                    </Button>
                  </div>
                  <Button size="sm" variant="outline" disabled={!!acting} onClick={() => requestTerminal('lost')}>
                    <XCircle className="h-3.5 w-3.5 mr-1" /> Lost
                  </Button>
                  <Textarea placeholder="Optional note / loss reason" value={note} onChange={(e) => setNote(e.target.value)} className="h-8 min-h-8 text-xs flex-1 min-w-[160px]" />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Outcome is final for this lead -- Won/Lost cannot be changed in this version. Contact support for a manual correction if this was a mistake.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Phase 9.9.15A Part E -- Won/Lost are terminal in V1: this
          confirmation is the ONLY place that fact is communicated before
          the action is irreversible, since no working Undo/Edit exists. */}
      <AlertDialog open={pendingTerminal !== null} onOpenChange={(open) => { if (!open) setPendingTerminal(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this lead as {pendingTerminal === 'won' ? 'Won' : 'Lost'}?</AlertDialogTitle>
            <AlertDialogDescription>
              This is permanent in the current version of MagicFlux -- once recorded, {pendingTerminal === 'won' ? 'Won' : 'Lost'} cannot
              be changed or undone from this screen. If you make a mistake, a correction requires contacting support for a manual fix; there
              is no in-product Edit/Undo yet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmTerminal}>Confirm {pendingTerminal === 'won' ? 'Won' : 'Lost'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function LeadListPanel({ workflowId }: { workflowId: string }) {
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'open' | 'all'>('open');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/qualification-decisions?workflow_id=${encodeURIComponent(workflowId)}&outcome=${filter}`);
    if (res.ok) {
      const body = await res.json();
      setItems(body.decisions ?? []);
    }
    setLoading(false);
  }, [workflowId, filter]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Leads</h2>
          <p className="text-xs text-muted-foreground">Inspect each qualification decision and record what actually happened.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant={filter === 'open' ? 'default' : 'outline'} onClick={() => setFilter('open')}>Open</Button>
          <Button size="sm" variant={filter === 'all' ? 'default' : 'outline'} onClick={() => setFilter('all')}>All</Button>
          <Button size="sm" variant="ghost" onClick={load}><RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /></Button>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : !items || items.length === 0 ? (
        <p className="text-xs text-muted-foreground">No leads yet.</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <LeadRow key={item.id} item={item} onChanged={load} />
          ))}
        </div>
      )}
    </section>
  );
}
