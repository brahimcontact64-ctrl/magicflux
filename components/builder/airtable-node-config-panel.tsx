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
  const [refreshKey, setRefreshKey] = useState(0);

  const hasAirtableNodes = (graph?.nodes ?? []).some((n) => isAirtableNodeType(n.type));

  const load = useCallback(async () => {
    if (!workflowId || !hasAirtableNodes) {
      setNodes(null);
      return;
    }

    const headers = await authHeaders();
    if (!headers) {
      setNodes(null);
      return;
    }

    try {
      const res = await fetch(`/api/workflows/${workflowId}`, { headers, cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.workflow) {
        setNodes(null);
        return;
      }

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
    }
  }, [workflowId, hasAirtableNodes, airtableConnected]);

  useEffect(() => {
    void load();
    // refreshKey deliberately re-triggers this exact effect after a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  if (!workflowId || !nodes || nodes.length === 0) return null;

  return (
    <AirtableConfigPanel
      workflowId={workflowId}
      nodes={nodes}
      onConfigured={() => setRefreshKey((k) => k + 1)}
    />
  );
}
