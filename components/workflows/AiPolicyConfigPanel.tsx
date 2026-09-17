'use client';

import { useCallback, useMemo, useState } from 'react';
import { Plus, Trash2, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { isDenylistedFieldName } from '@/lib/security/field-denylist';
import { useWorkflowConfigDraft } from './useWorkflowConfigDraft';

const AI_CLASSIFIER_NODE_TYPE = 'magicflux-nodes.aiClassifier';

type FieldRuleDraft = {
  field: string;
  required: boolean;
  kind: 'numeric' | 'enum' | 'text';
  positiveMin?: string;
  negativeMax?: string;
  positiveValues?: string; // comma-separated in the UI
  negativeValues?: string;
};

type ContradictionDraft = { positiveField: string; negativeField: string; note: string };

function toFieldRuleDraft(raw: Record<string, unknown>): FieldRuleDraft {
  return {
    field: String(raw.field ?? ''),
    required: raw.required === true,
    kind: raw.kind === 'numeric' || raw.kind === 'enum' || raw.kind === 'text' ? raw.kind : 'text',
    positiveMin: typeof raw.positiveMin === 'number' ? String(raw.positiveMin) : '',
    negativeMax: typeof raw.negativeMax === 'number' ? String(raw.negativeMax) : '',
    positiveValues: Array.isArray(raw.positiveValues) ? raw.positiveValues.join(', ') : '',
    negativeValues: Array.isArray(raw.negativeValues) ? raw.negativeValues.join(', ') : '',
  };
}

/**
 * Phase 9.9.16 -- Part C: the AI Qualification Policy Editor. Turns
 * magicflux-nodes.aiClassifier's "qualificationPolicy" JSON (Phase 9.9.10)
 * into a form a business owner can read and change without touching JSON.
 * Saves through PATCH /api/workflows/[id]/qualification-policy, which
 * re-validates through the exact same parseQualificationPolicy()/
 * validateQualificationPolicyShape() the generator and activation gate
 * already use (Part D) -- this form's own checks are a head start on a
 * good error message, never the actual authority.
 */
export function AiPolicyConfigPanel({ workflowId }: { workflowId: string }) {
  const { draft, loading, loadFailed, reload, save } = useWorkflowConfigDraft(workflowId);
  const node = useMemo(() => draft?.nodes.find((n) => String(n.type ?? '').toLowerCase() === AI_CLASSIFIER_NODE_TYPE.toLowerCase()) ?? null, [draft]);

  if (loading) return null;
  if (loadFailed) return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
      Could not load the AI qualification policy. <button className="underline" onClick={() => void reload()}>Retry</button>
    </div>
  );
  if (!node) return null;

  return <AiPolicyForm key={draft!.updatedAt} node={node} save={save} />;
}

function AiPolicyForm({
  node,
  save,
}: {
  node: Record<string, unknown>;
  save: ReturnType<typeof useWorkflowConfigDraft>['save'];
}) {
  const params = (node.parameters ?? {}) as Record<string, unknown>;
  const nodeId = String(node.id ?? node.name ?? '');
  const existingPolicy = (params.qualificationPolicy ?? null) as Record<string, unknown> | null;

  const [instruction, setInstruction] = useState(String(params.instruction ?? ''));
  const [allowedLabelsText, setAllowedLabelsText] = useState(Array.isArray(params.allowedLabels) ? (params.allowedLabels as string[]).join(', ') : '');
  const [confidenceThreshold, setConfidenceThreshold] = useState(typeof params.confidenceThreshold === 'number' ? params.confidenceThreshold : 0.6);
  const [policyEnabled, setPolicyEnabled] = useState(Boolean(existingPolicy));
  const [fields, setFields] = useState<FieldRuleDraft[]>(
    Array.isArray(existingPolicy?.fields) ? (existingPolicy!.fields as Record<string, unknown>[]).map(toFieldRuleDraft) : [],
  );
  const [contradictions, setContradictions] = useState<ContradictionDraft[]>(
    Array.isArray(existingPolicy?.contradictions)
      ? (existingPolicy!.contradictions as Record<string, unknown>[]).map((c) => ({ positiveField: String(c.positiveField ?? ''), negativeField: String(c.negativeField ?? ''), note: String(c.note ?? '') }))
      : [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const fieldNames = fields.map((f) => f.field.trim()).filter(Boolean);

  const addField = useCallback(() => {
    setFields((prev) => [...prev, { field: '', required: false, kind: 'text' }]);
  }, []);

  const updateField = useCallback((idx: number, patch: Partial<FieldRuleDraft>) => {
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  }, []);

  const removeField = useCallback((idx: number) => {
    setFields((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const addContradiction = useCallback(() => {
    setContradictions((prev) => [...prev, { positiveField: fieldNames[0] ?? '', negativeField: fieldNames[0] ?? '', note: '' }]);
  }, [fieldNames]);

  const handleSave = useCallback(async () => {
    setError(null);
    setConflict(false);

    const allowedLabels = Array.from(new Set(allowedLabelsText.split(',').map((s) => s.trim()).filter(Boolean)));
    if (allowedLabels.length === 0) {
      setError('At least one classification label (e.g. Hot, Warm, Cold) is required.');
      return;
    }

    for (const name of fieldNames) {
      if (isDenylistedFieldName(name)) {
        setError(`"${name}" is an internal or credential-shaped name and can never be a qualification input.`);
        return;
      }
    }
    if (new Set(fieldNames).size !== fieldNames.length) {
      setError('Field names must be unique.');
      return;
    }

    let qualificationPolicy: Record<string, unknown> | null = null;
    if (policyEnabled) {
      if (fields.length === 0) {
        setError('Add at least one field rule, or turn the qualification policy off.');
        return;
      }
      const builtFields = fields.map((f) => {
        const rule: Record<string, unknown> = { field: f.field.trim(), required: f.required, kind: f.kind };
        if (f.kind === 'numeric') {
          if (f.positiveMin?.trim()) rule.positiveMin = Number(f.positiveMin);
          if (f.negativeMax?.trim()) rule.negativeMax = Number(f.negativeMax);
        } else if (f.kind === 'enum') {
          if (f.positiveValues?.trim()) rule.positiveValues = f.positiveValues.split(',').map((s) => s.trim()).filter(Boolean);
          if (f.negativeValues?.trim()) rule.negativeValues = f.negativeValues.split(',').map((s) => s.trim()).filter(Boolean);
        }
        return rule;
      });
      qualificationPolicy = {
        version: 1,
        allowedInputFields: fieldNames,
        fields: builtFields,
        contradictions: contradictions.filter((c) => c.positiveField && c.negativeField).map((c) => ({ ...c, note: c.note.trim() || 'Contradictory signals detected.' })),
      };
    }

    setSaving(true);
    const result = await save('qualification-policy', {
      nodeId,
      instruction: instruction.trim(),
      allowedLabels,
      confidenceThreshold,
      qualificationPolicy,
    });
    setSaving(false);

    if (!result.ok) {
      if (result.status === 409) setConflict(true);
      else setError(result.error);
    }
  }, [allowedLabelsText, fieldNames, fields, policyEnabled, contradictions, instruction, confidenceThreshold, nodeId, save]);

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold">AI Qualification Policy</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          What counts as Hot, Warm, or Cold for this business -- configured here, not in raw JSON.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-foreground/80">What should the AI classify, and on what basis?</label>
        <Textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} className="text-xs min-h-16" placeholder="e.g. Classify this lead as Hot, Warm, or Cold based on budget and urgency." />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground/80">Allowed classifications</label>
          <Input value={allowedLabelsText} onChange={(e) => setAllowedLabelsText(e.target.value)} className="h-8 text-xs" placeholder="Hot, Warm, Cold" />
          <p className="text-[10px] text-muted-foreground">Comma-separated. These are the exact labels this workflow's branches key off.</p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground/80">Confidence threshold ({Math.round(confidenceThreshold * 100)}%)</label>
          <input
            type="range" min={0} max={1} step={0.05} value={confidenceThreshold}
            onChange={(e) => setConfidenceThreshold(Number(e.target.value))}
            className="w-full"
            aria-label="Confidence threshold"
          />
          <p className="text-[10px] text-muted-foreground">Below this confidence, the decision goes to Human Review instead of automatically proceeding.</p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium">Deterministic business rules (optional)</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Numbers/choices this business already knows matter -- evaluated with plain comparisons, never left to AI guesswork. A field that's simply absent is <span className="font-medium">missing information</span>, never treated the same as a <span className="font-medium">negative signal</span> from a field that IS present with a bad value.
            </p>
          </div>
          <label className="flex items-center gap-1.5 text-xs shrink-0">
            <input type="checkbox" checked={policyEnabled} onChange={(e) => setPolicyEnabled(e.target.checked)} />
            Enabled
          </label>
        </div>

        {policyEnabled && (
          <div className="space-y-3">
            {fields.map((f, idx) => (
              <div key={idx} className="rounded-md border border-border bg-background/40 p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <Input value={f.field} onChange={(e) => updateField(idx, { field: e.target.value })} placeholder="field name, e.g. budget_max" className="h-7 text-xs flex-1" />
                  <select value={f.kind} onChange={(e) => updateField(idx, { kind: e.target.value as FieldRuleDraft['kind'] })} className="h-7 rounded-md border border-border bg-background px-1.5 text-xs">
                    <option value="numeric">numeric</option>
                    <option value="enum">choice (enum)</option>
                    <option value="text">free text (AI-interpreted)</option>
                  </select>
                  <label className="flex items-center gap-1 text-[10px] shrink-0">
                    <input type="checkbox" checked={f.required} onChange={(e) => updateField(idx, { required: e.target.checked })} /> required
                  </label>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => removeField(idx)} aria-label={`Remove field ${f.field || idx + 1}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {f.field.trim() && isDenylistedFieldName(f.field.trim()) && (
                  <p className="text-[10px] text-destructive flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> This name is reserved/internal and cannot be used.</p>
                )}
                {f.kind === 'numeric' && (
                  <div className="grid grid-cols-2 gap-2">
                    <Input value={f.positiveMin ?? ''} onChange={(e) => updateField(idx, { positiveMin: e.target.value })} placeholder="Positive if >= (e.g. 10000)" className="h-7 text-xs" />
                    <Input value={f.negativeMax ?? ''} onChange={(e) => updateField(idx, { negativeMax: e.target.value })} placeholder="Negative if <= (e.g. 100)" className="h-7 text-xs" />
                  </div>
                )}
                {f.kind === 'enum' && (
                  <div className="grid grid-cols-2 gap-2">
                    <Input value={f.positiveValues ?? ''} onChange={(e) => updateField(idx, { positiveValues: e.target.value })} placeholder="Positive values, comma-separated" className="h-7 text-xs" />
                    <Input value={f.negativeValues ?? ''} onChange={(e) => updateField(idx, { negativeValues: e.target.value })} placeholder="Negative values, comma-separated" className="h-7 text-xs" />
                  </div>
                )}
                {f.kind === 'text' && (
                  <p className="text-[10px] text-muted-foreground">The AI reads this field's raw text for nuance -- it never scores it as positive/negative on its own.</p>
                )}
              </div>
            ))}
            <Button size="sm" variant="outline" className="h-7 gap-1" onClick={addField}><Plus className="h-3.5 w-3.5" /> Add field rule</Button>

            {fieldNames.length >= 2 && (
              <div className="space-y-2 pt-1">
                <p className="text-xs font-medium">Contradiction rules (optional)</p>
                {contradictions.map((c, idx) => (
                  <div key={idx} className="flex flex-wrap items-center gap-2">
                    <select value={c.positiveField} onChange={(e) => setContradictions((prev) => prev.map((x, i) => i === idx ? { ...x, positiveField: e.target.value } : x))} className="h-7 rounded-md border border-border bg-background px-1.5 text-xs">
                      {fieldNames.map((n) => <option key={n} value={n}>{n} (positive)</option>)}
                    </select>
                    <span className="text-[10px] text-muted-foreground">contradicts</span>
                    <select value={c.negativeField} onChange={(e) => setContradictions((prev) => prev.map((x, i) => i === idx ? { ...x, negativeField: e.target.value } : x))} className="h-7 rounded-md border border-border bg-background px-1.5 text-xs">
                      {fieldNames.map((n) => <option key={n} value={n}>{n} (negative)</option>)}
                    </select>
                    <Input value={c.note} onChange={(e) => setContradictions((prev) => prev.map((x, i) => i === idx ? { ...x, note: e.target.value } : x))} placeholder="e.g. High budget but low urgency" className="h-7 text-xs flex-1 min-w-[140px]" />
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setContradictions((prev) => prev.filter((_, i) => i !== idx))} aria-label="Remove contradiction rule"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" className="h-7 gap-1" onClick={addContradiction}><Plus className="h-3.5 w-3.5" /> Add contradiction rule</Button>
              </div>
            )}
          </div>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {conflict && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-800 dark:text-amber-300 flex items-center justify-between gap-2">
          <span>This workflow was changed elsewhere since you loaded it.</span>
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => window.location.reload()}><RefreshCw className="h-3.5 w-3.5" /> Reload</Button>
        </div>
      )}

      <Button size="sm" onClick={() => void handleSave()} disabled={saving}>{saving ? 'Saving…' : 'Save policy'}</Button>
    </section>
  );
}
