'use client';

import { useMemo, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWorkflowConfigDraft } from './useWorkflowConfigDraft';

const ACK_NODE_TYPES = ['magicflux-nodes.waitforacknowledgment', 'magicflux-nodes.createacknowledgmentchallenge'];
const MIN_SLA_MINUTES = 1;
const MAX_SLA_MINUTES = 7 * 24 * 60;

/**
 * Phase 9.9.16 -- Part H: SLA/acknowledgment editor. V1 is elapsed
 * wall-clock time (deadline = now + slaMinutes), never business hours --
 * stated explicitly here so nobody assumes otherwise. There is no separate
 * "enable SLA for this branch" toggle to expose: whether a branch has SLA
 * treatment at all is a structural property of which nodes the AI/builder
 * wired into that branch (enforced by lib/agent/sla-acknowledgment-gating-
 * guard.ts), not a field this editor can flip -- adding/removing SLA
 * treatment on a branch is a graph-wiring change, out of scope for a
 * per-node config editor (Part I: no arbitrary BPM editor required, but
 * this also means this editor must not pretend to offer that toggle).
 */
export function SlaConfigPanel({ workflowId }: { workflowId: string }) {
  const { draft, loading, loadFailed, reload, save } = useWorkflowConfigDraft(workflowId);
  const slaNodes = useMemo(() => (draft?.nodes ?? []).filter((n) => ACK_NODE_TYPES.includes(String(n.type ?? '').toLowerCase())), [draft]);

  if (loading) return null;
  if (loadFailed) return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
      Could not load SLA configuration. <button className="underline" onClick={() => void reload()}>Retry</button>
    </div>
  );
  if (slaNodes.length === 0) return null;

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Acknowledgment SLA</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          V1 measures elapsed wall-clock time from when a lead needs acknowledgment -- not business hours. The escalation ACTION itself (who gets notified, on which channel) is whatever this branch's "timed out" path is wired to in the workflow builder; this editor only controls timing.
        </p>
      </div>
      {slaNodes.map((n) => <SlaNodeEditor key={String(n.id ?? n.name)} node={n} save={save} />)}
    </section>
  );
}

function SlaNodeEditor({ node, save }: { node: Record<string, unknown>; save: ReturnType<typeof useWorkflowConfigDraft>['save'] }) {
  const params = (node.parameters ?? {}) as Record<string, unknown>;
  const nodeId = String(node.id ?? node.name ?? '');
  const [slaMinutes, setSlaMinutes] = useState(String(params.slaMinutes ?? ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const handleSave = useCallback(async () => {
    setError(null);
    setConflict(false);
    const n = Number(slaMinutes);
    if (!Number.isFinite(n) || n < MIN_SLA_MINUTES || n > MAX_SLA_MINUTES) {
      setError(`SLA minutes must be between ${MIN_SLA_MINUTES} and ${MAX_SLA_MINUTES}.`);
      return;
    }
    setSaving(true);
    const result = await save('sla-config', { nodeId, slaMinutes: n });
    setSaving(false);
    if (!result.ok) {
      if (result.status === 409) setConflict(true);
      else setError(result.error);
    }
  }, [slaMinutes, nodeId, save]);

  return (
    <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-2">
      <p className="text-xs font-medium">{String(node.name ?? nodeId)}</p>
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground/80" htmlFor={`sla-${nodeId}`}>SLA minutes (elapsed)</label>
          <Input id={`sla-${nodeId}`} value={slaMinutes} onChange={(e) => setSlaMinutes(e.target.value)} className="h-8 text-xs w-28" placeholder="e.g. 15" />
        </div>
        <Button size="sm" onClick={() => void handleSave()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {conflict && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-800 dark:text-amber-300 flex items-center justify-between gap-2">
          <span>This workflow was changed elsewhere since you loaded it.</span>
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => window.location.reload()}><RefreshCw className="h-3.5 w-3.5" /> Reload</Button>
        </div>
      )}
    </div>
  );
}
