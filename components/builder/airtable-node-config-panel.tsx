'use client';

import { useCallback, useEffect, useState } from 'react';
import { AirtableConfigPanel, type AirtableNodeNeedingConfig } from '@/components/workflows/AirtableConfigPanel';
import { extractAirtableNodeConfig, isAirtableNodeType } from '@/lib/airtable/node-params';
import { computeAirtableNodeStatus } from '@/lib/airtable/node-config-status';
import { supabase } from '@/lib/supabase-client';
import type { WorkflowGraphSummary } from '@/lib/agent/workflow-graph';

/**
 * Phase 9.9.8 -- Builder Action Configuration UX.
 *
 * The Builder's "Configure Save to Airtable (Cold)" cards (deriveIntegrationCards(),
 * lib/builder/runtime-state.ts) only ever showed a provider-level "connect
 * credentials" prompt -- there was no way to open/configure an individual
 * Airtable action node's real base/table/field mapping from the Builder at
 * all; that capability only existed on the Dashboard workflow detail page
 * (components/workflows/AirtableConfigPanel.tsx, Phase 9.9.3). This wires
 * the SAME certified component into the Builder, for every Airtable node
 * independently (not just ones missing configuration), computing an
 * explicit status per node so Hot/Warm/Cold never get confused for one
 * another:
 *
 *   - credential_missing: Airtable isn't connected yet at all.
 *   - unconfigured: connected, but this node has no base/table selected yet
 *     (generation deliberately leaves these empty -- lib/agent/airtable-config-guard.ts).
 *   - configured: base/table selected AND every currently-mapped field name
 *     still exists on Airtable's real live schema right now.
 *   - schema_changed: base/table selected, but a previously-mapped field
 *     name no longer exists on the real table (renamed/deleted since).
 *
 * Reuses the exact same server-side pieces the Dashboard page already uses
 * and that already do the real work correctly: GET /api/workflows/[id] (this
 * user's own persisted workflow_json), GET /api/integrations/airtable/{bases,
 * fields} (server-side schema discovery, Airtable token never leaves the
 * server), and PATCH /api/workflows/[id]/airtable-config (re-verifies the
 * mapping against Airtable's real schema server-side before ever persisting
 * it into the node's own parameters.fields, in the exact format
 * lib/workflow-runtime/node-handlers/airtable.ts already reads at
 * execution time). No second mapping format, no new persistence path.
 */
async function authHeaders(): Promise<HeadersInit | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export function BuilderAirtableConfigPanel({
  workflowId,
  graph,
  airtableConnected,
}: {
  workflowId: string | null | undefined;
  graph?: WorkflowGraphSummary;
  airtableConnected: boolean;
}) {
  const [nodes, setNodes] = useState<AirtableNodeNeedingConfig[] | null>(null);
  const [workflowMeta, setWorkflowMeta] = useState<{ id: string; name: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const hasAirtableNodes = (graph?.nodes ?? []).some((n) => isAirtableNodeType(n.type));

  const load = useCallback(async () => {
    if (!hasAirtableNodes) {
      setNodes(null);
      setWorkflowMeta(null);
      setLoadError(null);
      return;
    }

    // Phase 9.9.8A -- a workflow with Airtable nodes visible in the chat but
    // no persistedWorkflowId yet (the founder's own generation turn hasn't
    // finished saving) must say so explicitly rather than silently
    // rendering nothing, which production testing found indistinguishable
    // from a genuine bug.
    if (!workflowId) {
      setNodes(null);
      setWorkflowMeta(null);
      setLoadError('still_saving');
      return;
    }

    const headers = await authHeaders();
    if (!headers) {
      setNodes(null);
      setWorkflowMeta(null);
      setLoadError('session_expired');
      return;
    }

    try {
      const res = await fetch(`/api/workflows/${workflowId}`, { headers, cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.workflow) {
        setNodes(null);
        setWorkflowMeta(null);
        setLoadError('load_failed');
        return;
      }
      setLoadError(null);
      // Phase 9.9.8A -- resolves the duplicate-workflow ambiguity: this is
      // the exact persisted row (id + name) every save below targets, shown
      // to the founder so it's never a guess which of several
      // similarly-named drafts is actually being edited.
      setWorkflowMeta({ id: String(body.workflow.id ?? workflowId), name: String(body.workflow.name ?? 'Untitled workflow') });

      const rawNodes: Array<Record<string, unknown>> = Array.isArray(body.workflow.workflow_json?.nodes)
        ? body.workflow.workflow_json.nodes
        : [];
      const airtableNodes = rawNodes.filter((n) => isAirtableNodeType(n.type));

      const results: AirtableNodeNeedingConfig[] = await Promise.all(
        airtableNodes.map(async (n): Promise<AirtableNodeNeedingConfig> => {
          const nodeId = String(n.id ?? n.name ?? '');
          const nodeName = String(n.name ?? 'Save to Airtable');
          const config = extractAirtableNodeConfig(n as { parameters?: unknown });

          // Only a node that's already got a base/table selected needs a
          // live-schema check at all -- re-verifying because a field may
          // have been renamed or deleted in Airtable itself since this was
          // last configured, the same live check the pre-activation gate
          // re-runs at deploy time (lib/workflow/lifecycle.ts's
          // validateAirtableConfiguration()).
          let liveFieldNames: string[] | null = null;
          if (airtableConnected && config.baseId && config.tableId) {
            try {
              const fieldsRes = await fetch(
                `/api/integrations/airtable/fields?baseId=${encodeURIComponent(config.baseId)}&tableId=${encodeURIComponent(config.tableId)}`,
                { headers, cache: 'no-store' }
              );
              if (fieldsRes.ok) {
                const fieldsBody = await fieldsRes.json().catch(() => null) as { fields?: Array<{ name: string }> } | null;
                liveFieldNames = (fieldsBody?.fields ?? []).map((f) => f.name);
              }
            } catch {
              // liveFieldNames stays null -- computeAirtableNodeStatus fails this toward 'schema_changed'.
            }
          }

          const status = computeAirtableNodeStatus({
            airtableConnected,
            baseId: config.baseId,
            tableId: config.tableId,
            fieldKeys: config.fieldKeys,
            liveFieldNames,
          });

          return {
            nodeId,
            nodeName,
            fieldKeys: config.fieldKeys,
            status,
            ...(config.baseId ? { baseId: config.baseId } : {}),
            ...(config.tableId ? { tableId: config.tableId } : {}),
          };
        })
      );

      setNodes(results);
    } catch {
      setNodes(null);
      setWorkflowMeta(null);
      setLoadError('load_failed');
    }
  }, [workflowId, hasAirtableNodes, airtableConnected]);

  useEffect(() => {
    void load();
    // refreshKey deliberately re-triggers this exact effect after a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  if (!hasAirtableNodes) return null;

  if (loadError === 'still_saving') {
    return (
      <div className="rounded-lg border border-blue-500/25 bg-blue-500/8 p-3 text-xs text-muted-foreground">
        Still saving your workflow — Airtable configuration will appear here in a moment.
      </div>
    );
  }

  if (loadError === 'session_expired') {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
        Your session expired — refresh the page to configure Airtable here.
      </div>
    );
  }

  if (loadError === 'load_failed') return null;

  // Phase 9.9.8A -- render SOMETHING the instant Airtable nodes are known to
  // exist, instead of staying invisible while the workflow/schema fetches
  // are in flight. Production testing found the panel popping in silently
  // after the chat had already auto-scrolled to the bottom indistinguishable
  // from it simply not being there at all.
  if (!nodes) {
    return (
      <div className="rounded-lg border border-border bg-muted/10 p-3 text-xs text-muted-foreground">
        Loading Airtable configuration…
      </div>
    );
  }

  if (nodes.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {workflowMeta ? (
        <p className="text-[11px] text-muted-foreground px-1">
          Editing: <span className="font-medium text-foreground">{workflowMeta.name}</span>{' '}
          <span className="font-mono">({workflowMeta.id.slice(0, 8)}…)</span> — every save below targets this exact workflow.
        </p>
      ) : null}
      <AirtableConfigPanel
        workflowId={workflowId!}
        nodes={nodes}
        onConfigured={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
}
