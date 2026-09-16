'use client';

import { useCallback, useEffect, useState } from 'react';
import { AirtableConfigPanel, type AirtableNodeNeedingConfig } from '@/components/workflows/AirtableConfigPanel';
import { extractAirtableNodeConfig, isAirtableNodeType } from '@/lib/airtable/node-params';
import { computeAirtableNodeStatus } from '@/lib/airtable/node-config-status';
import { computeWorkflowIdentityStatus } from '@/lib/builder/workflow-identity-status';
import { supabase } from '@/lib/supabase-client';

/**
 * Phase 9.9.8 -- Builder Action Configuration UX.
 * Phase 9.9.8B -- root-cause fix for "Still saving your workflow" never
 * resolving: this panel was previously rendered inside ChatInterface, bound
 * to the CONVERSATIONAL agent's own persistedWorkflowId (lib/agent/
 * executor.ts's ensurePersistedWorkflowDraft(), linked via
 * automation_conversations.workflow_id). But the workflow this page's
 * "Output" section actually tests/activates (plannerResult / savedWorkflowId
 * in app/builder/page.tsx, saved via the separate POST /api/workflows path
 * triggered by onPlannerReadyAction) is a SECOND, independently-generated
 * and independently-persisted result -- the founder's real, already-existing
 * draft has NO automation_conversations link at all (confirmed read-only:
 * zero rows reference it), meaning it was produced by this second path, not
 * the first. Rendering the panel against the first system's id/graph while
 * the founder is actually looking at the second system's result meant the
 * id could never arrive, no matter how long the founder waited.
 *
 * Fixed by rendering this panel where the REAL, tested/activatable result
 * and its persisted id live together (app/builder/page.tsx's Output
 * section: plannerResult.n8nJson for the graph, savedWorkflowId for the id,
 * both already the single source of truth "Run Simulated Test"/"Review &
 * Activate" use) instead of re-deriving a second, disconnected identity.
 *
 * Server-side pieces reused unchanged: GET /api/workflows/[id] (this user's
 * own persisted workflow_json), GET /api/integrations/airtable/{bases,
 * fields} (server-side schema discovery, token never leaves the server),
 * and PATCH /api/workflows/[id]/airtable-config (re-verifies the mapping
 * against Airtable's real schema server-side before persisting into the
 * node's own parameters.fields, the exact format
 * lib/workflow-runtime/node-handlers/airtable.ts reads at execution time).
 */
async function authHeaders(): Promise<HeadersInit | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export function BuilderAirtableConfigPanel({
  workflowId,
  saveState,
  airtableConnected,
}: {
  /** The exact persisted row id for the current result (app/builder/page.tsx's savedWorkflowId, recovered from localStorage across a refresh), or null. */
  workflowId: string | null;
  /** The save attempt's own lifecycle -- drives the explicit saving/persisted/failed states (Phase 9.9.8B). */
  saveState: 'idle' | 'saving' | 'saved' | 'failed';
  airtableConnected: boolean;
}) {
  const [nodes, setNodes] = useState<AirtableNodeNeedingConfig[] | null>(null);
  const [workflowMeta, setWorkflowMeta] = useState<{ id: string; name: string } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Phase 9.9.8B -- deliberately does NOT take a separate "graph"/node-list
  // prop from the caller. The one and only thing needed to know everything
  // about this workflow -- including whether it even HAS an Airtable node --
  // is its own persisted id, fetched fresh below. This is what makes the
  // panel self-sufficient across a page refresh: as long as workflowId is
  // recovered (see app/builder/page.tsx's localStorage restore), this panel
  // needs nothing else from the rest of the page's (possibly not yet
  // restored) React state to find and show its own real Airtable nodes.
  const hasResult = saveState !== 'idle' || Boolean(workflowId);
  const identity = computeWorkflowIdentityStatus({ hasResult, workflowId, saveState });

  const load = useCallback(async () => {
    if (identity !== 'persisted' || !workflowId) {
      setNodes(null);
      setWorkflowMeta(null);
      setLoadFailed(false);
      return;
    }

    const headers = await authHeaders();
    if (!headers) {
      setNodes(null);
      setWorkflowMeta(null);
      setLoadFailed(true);
      return;
    }

    try {
      const res = await fetch(`/api/workflows/${workflowId}`, { headers, cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.workflow) {
        setNodes(null);
        setWorkflowMeta(null);
        setLoadFailed(true);
        return;
      }
      setLoadFailed(false);
      // Phase 9.9.8A/B -- resolves the duplicate-workflow ambiguity: this is
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
      setLoadFailed(true);
    }
  }, [identity, workflowId, airtableConnected]);

  useEffect(() => {
    void load();
    // refreshKey deliberately re-triggers this exact effect after a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  // Phase 9.9.8B -- explicit, terminating states (no more indefinite
  // generic "still saving"). 'no_workflow' never renders (nothing to
  // configure yet); 'saving' and 'persistence_failed' are both real,
  // distinct, visible outcomes.
  if (identity === 'no_workflow') return null;

  if (identity === 'saving') {
    return (
      <div className="rounded-lg border border-blue-500/25 bg-blue-500/8 p-3 text-xs text-muted-foreground">
        Saving your workflow — Airtable configuration will appear here as soon as it's saved.
      </div>
    );
  }

  if (identity === 'persistence_failed') {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-muted-foreground">
        This workflow could not be saved, so Airtable configuration isn't available yet. Try generating it again.
      </div>
    );
  }

  // identity === 'persisted' from here on.

  if (loadFailed) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
        Could not load this workflow's Airtable configuration. Refresh and try again.
      </div>
    );
  }

  // Phase 9.9.8A -- render SOMETHING the instant Airtable nodes are known to
  // exist, instead of staying invisible while the workflow/schema fetches
  // are in flight.
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
