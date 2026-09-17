'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase-client';

/**
 * Phase 9.9.16 -- Part B/L: the shared fetch/save primitive every new
 * node-config editor (AI policy, Human Review, notification content, SLA)
 * is built on. Mirrors components/builder/airtable-node-config-panel.tsx's
 * established self-sufficiency pattern: a panel that fetches its OWN fresh
 * copy of `workflow_json` (the one canonical config source, Part B) rather
 * than trusting a possibly-stale prop from a parent page, and always saves
 * with the exact `updated_at` it just read so the server can detect a
 * concurrent edit (Part L) instead of silently overwriting one.
 */

export type WorkflowConfigDraft = {
  id: string;
  name: string;
  nodes: Record<string, unknown>[];
  connections: unknown;
  updatedAt: string;
};

async function authHeaders(): Promise<HeadersInit | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export function useWorkflowConfigDraft(workflowId: string | null) {
  const [draft, setDraft] = useState<WorkflowConfigDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const reload = useCallback(async () => {
    if (!workflowId) {
      setDraft(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadFailed(false);
    try {
      const headers = await authHeaders();
      if (!headers) throw new Error('no session');
      const res = await fetch(`/api/workflows/${workflowId}`, { headers, cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.workflow) throw new Error('load failed');
      const wf = body.workflow as { id: string; name?: string; workflow_json?: { nodes?: unknown; connections?: unknown }; updated_at: string };
      setDraft({
        id: wf.id,
        name: wf.name ?? 'Untitled workflow',
        nodes: Array.isArray(wf.workflow_json?.nodes) ? (wf.workflow_json!.nodes as Record<string, unknown>[]) : [],
        connections: wf.workflow_json?.connections,
        updatedAt: wf.updated_at,
      });
    } catch {
      setDraft(null);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => { void reload(); }, [reload]);

  /** Posts to one of the node-config PATCH sub-routes with the draft's own last-known updatedAt attached. Returns the parsed response body either way so the caller can render a precise error (including a 409 conflict). */
  const save = useCallback(async (subroute: string, body: Record<string, unknown>): Promise<{ ok: true; updatedAt: string; node: Record<string, unknown> } | { ok: false; status: number; error: string; latestUpdatedAt?: string | null }> => {
    if (!workflowId || !draft) return { ok: false, status: 400, error: 'Workflow not loaded yet.' };
    const headers = await authHeaders();
    if (!headers) return { ok: false, status: 401, error: 'Session expired -- sign in again.' };
    const res = await fetch(`/api/workflows/${workflowId}/${subroute}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ ...body, expectedUpdatedAt: draft.updatedAt }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, error: payload?.error ?? 'Save failed.', latestUpdatedAt: payload?.latestUpdatedAt ?? null };
    }
    await reload();
    return { ok: true, updatedAt: payload.updatedAt, node: payload.node };
  }, [workflowId, draft, reload]);

  return { draft, loading, loadFailed, reload, save };
}
