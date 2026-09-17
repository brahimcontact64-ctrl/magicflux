'use client';

import { useMemo, useState, useCallback } from 'react';
import { RefreshCw, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useWorkflowConfigDraft } from './useWorkflowConfigDraft';

const HUMAN_REVIEW_NODE_TYPE = 'magicflux-nodes.humanReview';

/**
 * Phase 9.9.16 -- Part E: Human Review configuration. Outcomes are
 * intentionally renamed-in-place / appended-only here (never removed or
 * reordered) -- see app/api/workflows/[id]/human-review-config/route.ts's
 * own doc comment for why: the runtime picks the downstream branch by the
 * outcome's POSITION in this array, and this editor never touches the
 * graph edges that decide which real node sits behind each position.
 */
export function HumanReviewConfigPanel({ workflowId }: { workflowId: string }) {
  const { draft, loading, loadFailed, reload, save } = useWorkflowConfigDraft(workflowId);
  const node = useMemo(() => draft?.nodes.find((n) => String(n.type ?? '').toLowerCase() === HUMAN_REVIEW_NODE_TYPE.toLowerCase()) ?? null, [draft]);

  if (loading) return null;
  if (loadFailed) return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
      Could not load Human Review configuration. <button className="underline" onClick={() => void reload()}>Retry</button>
    </div>
  );
  if (!node) return null;

  return <HumanReviewForm key={draft!.updatedAt} node={node} save={save} />;
}

function HumanReviewForm({ node, save }: { node: Record<string, unknown>; save: ReturnType<typeof useWorkflowConfigDraft>['save'] }) {
  const params = (node.parameters ?? {}) as Record<string, unknown>;
  const nodeId = String(node.id ?? node.name ?? '');
  const existingOutcomes = Array.isArray(params.allowedOutcomes) ? (params.allowedOutcomes as string[]) : ['approve', 'reject'];

  const [instruction, setInstruction] = useState(String(params.instruction ?? ''));
  const [outcomes, setOutcomes] = useState<string[]>(existingOutcomes);
  const [outputField, setOutputField] = useState(String(params.outputField ?? ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const renameOutcome = useCallback((idx: number, value: string) => {
    setOutcomes((prev) => prev.map((o, i) => (i === idx ? value : o)));
  }, []);

  const appendOutcome = useCallback(() => setOutcomes((prev) => [...prev, '']), []);

  const handleSave = useCallback(async () => {
    setError(null);
    setConflict(false);
    const trimmed = outcomes.map((o) => o.trim());
    if (trimmed.some((o) => !o)) {
      setError('Every outcome needs a name.');
      return;
    }
    if (new Set(trimmed).size !== trimmed.length) {
      setError('Outcome names must be unique.');
      return;
    }
    setSaving(true);
    const result = await save('human-review-config', {
      nodeId,
      instruction: instruction.trim(),
      allowedOutcomes: trimmed,
      outputField: outputField.trim() || undefined,
    });
    setSaving(false);
    if (!result.ok) {
      if (result.status === 409) setConflict(true);
      else setError(result.error);
    }
  }, [outcomes, instruction, outputField, nodeId, save]);

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Human Review</h2>
        <p className="text-xs text-muted-foreground mt-0.5">What a reviewer is asked, and the decisions they can make. These outcomes reconnect to the exact same branches the AI classifier uses.</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground/80">Review instruction</label>
        <Textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} className="text-xs min-h-16" placeholder="e.g. Confirm whether this lead is genuinely Hot, Warm, or Cold before we proceed." />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground/80">Allowed outcomes</label>
        <div className="flex flex-wrap gap-2">
          {outcomes.map((o, idx) => (
            <Input key={idx} value={o} onChange={(e) => renameOutcome(idx, e.target.value)} className="h-7 text-xs w-32" />
          ))}
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={appendOutcome}><Plus className="h-3.5 w-3.5" /> Add outcome</Button>
        </div>
        <p className="text-[10px] text-muted-foreground">Existing outcomes can be renamed but not removed or reordered here -- that would silently repoint an already-wired branch. New outcomes can be appended and wired in the workflow builder.</p>
      </div>

      <div className="space-y-1.5 max-w-xs">
        <label className="text-xs font-medium text-foreground/80">Output field name</label>
        <Input value={outputField} onChange={(e) => setOutputField(e.target.value)} className="h-7 text-xs" placeholder="decision_outcome" />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {conflict && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-800 dark:text-amber-300 flex items-center justify-between gap-2">
          <span>This workflow was changed elsewhere since you loaded it.</span>
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => window.location.reload()}><RefreshCw className="h-3.5 w-3.5" /> Reload</Button>
        </div>
      )}

      <Button size="sm" onClick={() => void handleSave()} disabled={saving}>{saving ? 'Saving…' : 'Save Human Review config'}</Button>
    </section>
  );
}
