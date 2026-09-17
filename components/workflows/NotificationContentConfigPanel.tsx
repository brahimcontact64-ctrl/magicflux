'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { RefreshCw, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkflowConfigDraft } from './useWorkflowConfigDraft';

const AI_CLASSIFIER_NODE_TYPE = 'magicflux-nodes.aiclassifier';
const ACK_NODE_TYPES = ['magicflux-nodes.waitforacknowledgment', 'magicflux-nodes.createacknowledgmentchallenge'];

function isEmailNodeType(type: string): boolean {
  const t = type.toLowerCase();
  return (t.includes('email') || t.includes('gmail')) && !t.includes('trigger');
}
function isSlackNodeType(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes('slack') && !t.includes('trigger');
}

/**
 * Phase 9.9.16 -- Part F/G: Gmail/Slack notification content editor.
 * Never asks a user to memorize `{{$json["..."]}}` or the `{{?field}}...
 * {{/field}}` optional-block grammar (lib/workflow-runtime/node-handlers/
 * json-field-reference.ts) -- this UI generates those certified expressions
 * from a plain "insert a field" / "insert an optional line" action. The
 * acknowledgment URL is offered as a distinct, clearly-labeled ACTION
 * (Part G), never something the user has to construct -- shown only when
 * this workflow actually contains an SLA/acknowledgment node.
 *
 * All actual guard enforcement (Phase 9.9.9's no-eval/no-arbitrary-JS rule,
 * the denylist) happens server-side on save, exactly as it does at
 * generation/activation (Part D) -- this editor cannot bypass that by
 * composing something unsupported, since the server re-parses the final
 * string with the same guard either way.
 */
export function NotificationContentConfigPanel({ workflowId }: { workflowId: string }) {
  const { draft, loading, loadFailed, reload, save } = useWorkflowConfigDraft(workflowId);

  const notificationNodes = useMemo(
    () => (draft?.nodes ?? []).filter((n) => isEmailNodeType(String(n.type ?? '')) || isSlackNodeType(String(n.type ?? ''))),
    [draft],
  );
  const hasAckNode = useMemo(
    () => (draft?.nodes ?? []).some((n) => ACK_NODE_TYPES.includes(String(n.type ?? '').toLowerCase())),
    [draft],
  );
  const availableFields = useMemo(() => {
    const classifier = (draft?.nodes ?? []).find((n) => String(n.type ?? '').toLowerCase() === AI_CLASSIFIER_NODE_TYPE);
    const p = (classifier?.parameters ?? {}) as Record<string, unknown>;
    const fields = new Set<string>();
    if (typeof p.outputField === 'string' && p.outputField) fields.add(p.outputField);
    const policy = p.qualificationPolicy as { allowedInputFields?: unknown } | undefined;
    if (Array.isArray(policy?.allowedInputFields)) policy!.allowedInputFields!.forEach((f) => fields.add(String(f)));
    const extract = Array.isArray(p.extractFields) ? p.extractFields as Array<{ name?: string }> : [];
    extract.forEach((f) => { if (f.name) fields.add(f.name); });
    return Array.from(fields);
  }, [draft]);

  if (loading) return null;
  if (loadFailed) return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
      Could not load notification content. <button className="underline" onClick={() => void reload()}>Retry</button>
    </div>
  );
  if (notificationNodes.length === 0) return null;

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Notification Content</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Gmail and Slack content, editable without memorizing template syntax.</p>
      </div>
      {notificationNodes.map((n) => (
        <NotificationNodeEditor
          key={String(n.id ?? n.name)}
          node={n}
          availableFields={availableFields}
          hasAckNode={hasAckNode}
          save={save}
        />
      ))}
    </section>
  );
}

function insertAtCursor(el: HTMLTextAreaElement | null, current: string, snippet: string): string {
  if (!el) return `${current}${snippet}`;
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? current.length;
  return `${current.slice(0, start)}${snippet}${current.slice(end)}`;
}

function NotificationNodeEditor({
  node,
  availableFields,
  hasAckNode,
  save,
}: {
  node: Record<string, unknown>;
  availableFields: string[];
  hasAckNode: boolean;
  save: ReturnType<typeof useWorkflowConfigDraft>['save'];
}) {
  const params = (node.parameters ?? {}) as Record<string, unknown>;
  const nodeId = String(node.id ?? node.name ?? '');
  const type = String(node.type ?? '');
  const isEmail = isEmailNodeType(type);
  const contentFields: Array<{ key: string; label: string }> = isEmail
    ? [{ key: 'subject', label: 'Subject' }, { key: 'body', label: 'Body' }]
    : [{ key: 'message', label: 'Message' }];

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of contentFields) initial[f.key] = String(params[f.key] ?? '');
    return initial;
  });
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const refs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const insertField = useCallback((key: string, field: string) => {
    setValues((prev) => ({ ...prev, [key]: insertAtCursor(refs.current[key], prev[key] ?? '', `{{$json["${field}"]}}`) }));
  }, []);

  const insertOptional = useCallback((key: string, field: string) => {
    setValues((prev) => ({ ...prev, [key]: insertAtCursor(refs.current[key], prev[key] ?? '', `{{?${field}}}{{$json["${field}"]}}{{/${field}}}`) }));
  }, []);

  const insertAckLink = useCallback((key: string) => {
    setValues((prev) => ({ ...prev, [key]: insertAtCursor(refs.current[key], prev[key] ?? '', `{{$json["acknowledgment_url"]}}`) }));
  }, []);

  const handleSave = useCallback(async (key: string) => {
    setError(null);
    setConflict(false);
    setSaving(key);
    const result = await save('notification-content', { nodeId, field: key, value: values[key] ?? '' });
    setSaving(null);
    if (!result.ok) {
      if (result.status === 409) setConflict(true);
      else setError(result.error);
    }
  }, [nodeId, values, save]);

  return (
    <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-3">
      <p className="text-xs font-medium">{String(node.name ?? nodeId)} <span className="text-muted-foreground font-normal">({isEmail ? 'Gmail' : 'Slack'})</span></p>

      {contentFields.map(({ key, label }) => (
        <div key={key} className="space-y-1.5">
          <label className="text-xs font-medium text-foreground/80" htmlFor={`notif-${nodeId}-${key}`}>{label}</label>
          <textarea
            id={`notif-${nodeId}-${key}`}
            ref={(el) => { refs.current[key] = el; }}
            value={values[key] ?? ''}
            onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
            className="w-full min-h-16 rounded-md border border-border bg-background px-2 py-1.5 text-xs font-mono"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {availableFields.map((f) => (
              <div key={f} className="flex items-center gap-0.5">
                <Button size="sm" variant="outline" className="h-6 px-1.5 text-[10px]" onClick={() => insertField(key, f)}>+ {f}</Button>
                <Button size="sm" variant="ghost" className="h-6 px-1 text-[10px] text-muted-foreground" title={`Insert "${f}" as an optional line -- only shown when present`} onClick={() => insertOptional(key, f)}>optional</Button>
              </div>
            ))}
            {hasAckNode && (
              <Button size="sm" variant="outline" className="h-6 px-1.5 text-[10px] gap-1" onClick={() => insertAckLink(key)}>
                <Link2 className="h-3 w-3" /> Insert acknowledgment link
              </Button>
            )}
          </div>
          <Button size="sm" className="h-7" onClick={() => void handleSave(key)} disabled={saving === key}>{saving === key ? 'Saving…' : `Save ${label.toLowerCase()}`}</Button>
        </div>
      ))}

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
