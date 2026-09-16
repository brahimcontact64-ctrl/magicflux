'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table2, Loader2, CheckCircle2, AlertTriangle, PlugZap } from 'lucide-react';
import { supabase } from '@/lib/supabase-client';

type AirtableBase = { id: string; name: string };
type AirtableField = { id: string; name: string; type: string };
type AirtableTable = { id: string; name: string; fields: AirtableField[] };

/**
 * Phase 9.9.8 -- explicit per-node configuration state, computed by the
 * caller (which already knows whether Airtable is connected and, for an
 * already-configured node, whether its stored field names still exist on
 * Airtable's real live schema). This component only ever displays what it's
 * told; it does not infer state on its own, so Dashboard and Builder always
 * agree on what "configured" means for the exact same node.
 */
export type AirtableNodeStatus = 'unconfigured' | 'configured' | 'schema_changed' | 'credential_missing';

export type AirtableNodeNeedingConfig = {
  nodeId: string;
  nodeName: string;
  /**
   * The node's current field keys. For an unconfigured node these are the
   * semantic/proposed names generation left behind (e.g. "name", "email");
   * for an already-configured node these are the REAL Airtable field names
   * currently in use as the fields object's keys (e.g. "Name", "Email") --
   * either way, "map each of these keys to a real field in this table".
   */
  fieldKeys: string[];
  /** Omitted/undefined is treated as 'unconfigured' (backward compatible with existing callers). */
  status?: AirtableNodeStatus;
  /** Pre-fills the base/table pickers when this node already has a selection. */
  baseId?: string;
  tableId?: string;
};

const STATUS_BADGE: Record<AirtableNodeStatus, { label: string; className: string; icon: React.ReactNode }> = {
  unconfigured: { label: 'Unconfigured', className: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300', icon: <Table2 className="w-3.5 h-3.5" /> },
  configured: { label: 'Configured', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
  schema_changed: { label: 'Schema changed', className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400', icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  credential_missing: { label: 'Credential missing', className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400', icon: <PlugZap className="w-3.5 h-3.5" /> },
};

async function authHeaders(): Promise<HeadersInit | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

function NodeConfigCard({
  workflowId,
  node,
  onConfigured,
}: {
  workflowId: string;
  node: AirtableNodeNeedingConfig;
  onConfigured: () => void;
}) {
  const status = node.status ?? 'unconfigured';
  // Phase 9.9.8A -- every node card starts COLLAPSED behind an explicit
  // "Configure" button, regardless of status. Production testing found the
  // always-open form indistinguishable from the surrounding informational
  // cards ("nothing looks clickable"); a single, unambiguous per-node
  // button that visibly opens/closes the real editor fixes that, and
  // matches the literal required UX: "Save to Airtable (Hot) [Configure]".
  const [expanded, setExpanded] = useState(false);
  const [bases, setBases] = useState<AirtableBase[] | null>(null);
  const [tables, setTables] = useState<AirtableTable[] | null>(null);
  const [baseId, setBaseId] = useState(node.baseId ?? '');
  const [tableId, setTableId] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // Credential missing: nothing to fetch, nothing to configure -- Airtable
  // itself must be connected first (via the integration card elsewhere on
  // this page), never attempted here.
  const credentialMissing = status === 'credential_missing';

  useEffect(() => {
    if (!expanded || credentialMissing) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const headers = await authHeaders();
      if (!headers) { setError('Session expired.'); setLoading(false); return; }
      try {
        const res = await fetch('/api/integrations/airtable/bases', { headers });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'Failed to load Airtable bases');
        if (!cancelled) setBases(body.bases ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load Airtable bases');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [expanded, credentialMissing]);

  const loadTables = useCallback(async (selectedBaseId: string, preselectTableId?: string) => {
    setBaseId(selectedBaseId);
    setTableId('');
    setTables(null);
    if (!selectedBaseId) return;
    setLoading(true);
    setError(null);
    const headers = await authHeaders();
    if (!headers) { setError('Session expired.'); setLoading(false); return; }
    try {
      const res = await fetch(`/api/integrations/airtable/tables?baseId=${encodeURIComponent(selectedBaseId)}`, { headers });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to load tables');
      const loadedTables = body.tables ?? [];
      setTables(loadedTables);
      if (preselectTableId && loadedTables.some((t: AirtableTable) => t.id === preselectTableId)) {
        setTableId(preselectTableId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tables');
    } finally {
      setLoading(false);
    }
  }, []);

  // Pre-fill: a node that already has a base/table selected (configured or
  // schema_changed) auto-loads its tables once bases have arrived, instead
  // of making the founder re-pick a base/table they already chose just to
  // re-check or fix one renamed field.
  useEffect(() => {
    if (!expanded) return;
    if (node.baseId && bases !== null && tables === null && !loading) {
      loadTables(node.baseId, node.tableId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, bases, node.baseId, node.tableId]);

  const selectedTable = useMemo(() => tables?.find((t) => t.id === tableId) ?? null, [tables, tableId]);

  // Identity pre-fill: once the real table schema is known, any existing
  // field key that is already an exact real field name (the common "just
  // re-verify, nothing actually changed" case, and every field a fresh
  // 'configured' node already has) is pre-selected automatically; a
  // genuinely renamed/removed field (the 'schema_changed' case) is left
  // blank so the founder must deliberately pick its replacement.
  useEffect(() => {
    if (!selectedTable) return;
    setMapping((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const key of node.fieldKeys) {
        if (next[key]) continue;
        if (selectedTable.fields.some((f) => f.name === key)) {
          next[key] = key;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedTable, node.fieldKeys]);

  const canSave = baseId && tableId && node.fieldKeys.every((k) => mapping[k]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setJustSaved(false);
    const headers = await authHeaders();
    if (!headers) { setError('Session expired.'); setSaving(false); return; }
    try {
      const res = await fetch(`/api/workflows/${workflowId}/airtable-config`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ nodeId: node.nodeId, baseId, tableId, fieldMapping: mapping }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to save Airtable configuration');
      setJustSaved(true);
      onConfigured();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Airtable configuration');
    } finally {
      setSaving(false);
    }
  }, [workflowId, node, baseId, tableId, mapping, onConfigured]);

  const badge = STATUS_BADGE[status];

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{node.nodeName}</p>
          <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${badge.className}`}>
            {badge.icon}{badge.label}
          </span>
        </div>
        <Button
          size="sm"
          variant={expanded ? 'outline' : 'default'}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? 'Close' : 'Configure'}
        </Button>
      </div>

      {expanded && credentialMissing ? (
        <p className="text-xs text-muted-foreground">Connect Airtable first, then come back here to configure this step.</p>
      ) : null}

      {expanded && !credentialMissing ? (
        <>
          {status === 'schema_changed' ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              One or more previously-mapped fields no longer match Airtable's real schema. Review the mapping below and re-save.
            </p>
          ) : null}
          {justSaved ? (
            <p className="text-[11px] text-emerald-700 dark:text-emerald-300 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Saved and verified against Airtable's live schema.
            </p>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className="text-xs text-muted-foreground">Base</label>
              <select
                className="w-full mt-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                value={baseId}
                onChange={(e) => loadTables(e.target.value)}
              >
                <option value="">{bases === null ? 'Loading…' : 'Select a base…'}</option>
                {(bases ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Table</label>
              <select
                className="w-full mt-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                value={tableId}
                disabled={!baseId}
                onChange={(e) => setTableId(e.target.value)}
              >
                <option value="">{!baseId ? 'Select a base first' : tables === null ? 'Loading…' : 'Select a table…'}</option>
                {(tables ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>

          {selectedTable && node.fieldKeys.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Map each value this step sends to a real field in this table:</p>
              {node.fieldKeys.map((key) => (
                <div key={key} className="flex items-center gap-2 text-sm">
                  <span className="w-40 shrink-0 font-mono text-xs text-muted-foreground truncate">{key}</span>
                  <span className="text-muted-foreground">→</span>
                  <select
                    className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    value={mapping[key] ?? ''}
                    onChange={(e) => setMapping((m) => ({ ...m, [key]: e.target.value }))}
                  >
                    <option value="">Select a field…</option>
                    {selectedTable.fields.map((f) => <option key={f.id} value={f.name}>{f.name} ({f.type})</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <Button size="sm" onClick={handleSave} disabled={!canSave || saving}>
            {saving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
            Save & verify mapping
          </Button>
          {loading && !bases ? <p className="text-xs text-muted-foreground">Loading your Airtable bases…</p> : null}
        </>
      ) : null}
    </div>
  );
}

export function AirtableConfigPanel({
  workflowId,
  nodes,
  onConfigured,
}: {
  workflowId: string;
  nodes: AirtableNodeNeedingConfig[];
  onConfigured: () => void;
}) {
  if (nodes.length === 0) return null;

  const needsAttention = nodes.some((n) => (n.status ?? 'unconfigured') !== 'configured');

  return (
    <div className={`rounded-lg border p-3 space-y-3 ${needsAttention ? 'border-amber-500/30 bg-amber-500/5' : 'border-emerald-500/25 bg-emerald-500/5'}`}>
      <p className="text-xs font-medium flex items-center gap-1.5">
        <Table2 className="w-3.5 h-3.5" />
        {needsAttention
          ? 'Airtable configuration required before this workflow can be activated'
          : 'Airtable configuration'}
      </p>
      <p className="text-[11px] text-muted-foreground">
        {needsAttention
          ? 'This workflow saves data to Airtable, but no real base/table/field mapping has been selected yet. Choose your real Airtable base and table below, then map each value to a real field.'
          : 'Every Airtable step below is configured and verified against your real base/table. Reopen any step to change its mapping.'}
      </p>
      {nodes.map((node) => (
        <NodeConfigCard key={node.nodeId} workflowId={workflowId} node={node} onConfigured={onConfigured} />
      ))}
    </div>
  );
}
