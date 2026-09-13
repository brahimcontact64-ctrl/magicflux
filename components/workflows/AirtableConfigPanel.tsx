'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table2, Loader2, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/lib/supabase-client';

type AirtableBase = { id: string; name: string };
type AirtableField = { id: string; name: string; type: string };
type AirtableTable = { id: string; name: string; fields: AirtableField[] };

export type AirtableNodeNeedingConfig = {
  nodeId: string;
  nodeName: string;
  /** The node's current, semantic (pre-mapping) field keys, e.g. "Name", "Email". */
  fieldKeys: string[];
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
  const [bases, setBases] = useState<AirtableBase[] | null>(null);
  const [tables, setTables] = useState<AirtableTable[] | null>(null);
  const [baseId, setBaseId] = useState('');
  const [tableId, setTableId] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
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
  }, []);

  const loadTables = useCallback(async (selectedBaseId: string) => {
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
      setTables(body.tables ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tables');
    } finally {
      setLoading(false);
    }
  }, []);

  const selectedTable = useMemo(() => tables?.find((t) => t.id === tableId) ?? null, [tables, tableId]);

  const canSave = baseId && tableId && node.fieldKeys.every((k) => mapping[k]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
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
      setSaved(true);
      onConfigured();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Airtable configuration');
    } finally {
      setSaving(false);
    }
  }, [workflowId, node, baseId, tableId, mapping, onConfigured]);

  if (saved) {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="w-4 h-4" /> {node.nodeName}: Airtable mapping saved and verified.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3 space-y-3">
      <p className="text-sm font-medium">{node.nodeName}</p>

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

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-3">
      <p className="text-xs font-medium flex items-center gap-1.5">
        <Table2 className="w-3.5 h-3.5" /> Airtable configuration required before this workflow can be activated
      </p>
      <p className="text-[11px] text-muted-foreground">
        This workflow saves data to Airtable, but no real base/table/field mapping has been selected yet. Choose your real Airtable base and table below, then map each value to a real field.
      </p>
      {nodes.map((node) => (
        <NodeConfigCard key={node.nodeId} workflowId={workflowId} node={node} onConfigured={onConfigured} />
      ))}
    </div>
  );
}
