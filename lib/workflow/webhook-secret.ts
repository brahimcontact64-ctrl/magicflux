import 'server-only';

import { randomBytes } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase-server';

/**
 * Phase 9.8.4 -- per-workflow webhook authentication.
 *
 * Root cause of the "always 401" incident: app/api/workflows/[id]/webhook/
 * route.ts fell back to a single GLOBAL env var (MAGICFLUX_WEBHOOK_SECRET)
 * whenever a workflow had no secret of its own, silently forcing full
 * HMAC-signature auth on every unconfigured webhook -- a credential no
 * external caller could ever know, and one shared across every tenant.
 *
 * The fix: every webhook-triggered workflow gets its own unguessable
 * secret, generated exactly once and persisted into the existing
 * workflow_json.security.webhook_secret field (no schema change -- this key
 * was already read by the webhook route, just never written by anything).
 * This module is the single place that generates, reads, and persists it,
 * used by: activation (lib/workflow/lifecycle.ts), the dashboard's on-read
 * backfill for already-active workflows that predate this fix, and manual
 * rotation.
 */

type WorkflowSecretRow = {
  id: string;
  workflow_json: unknown;
  active_deployment_version_id: string | null;
};

export function hasWebhookTrigger(workflowJson: unknown): boolean {
  const nodes = (workflowJson as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return false;
  return (nodes as Array<Record<string, unknown>>).some((n) => {
    const type = String(n?.type ?? '').toLowerCase();
    return type.includes('webhook') && !type.includes('trigger.');
  });
}

export function extractWebhookSecret(workflowJson: unknown): string | null {
  const wf = (workflowJson ?? {}) as Record<string, unknown>;
  const security = (wf.security ?? wf.webhook_security) as Record<string, unknown> | undefined;
  const secret = security?.webhook_secret;
  return typeof secret === 'string' && secret.length > 0 ? secret : null;
}

function withWebhookSecret(workflowJson: unknown, secret: string): Record<string, unknown> {
  const wf = { ...((workflowJson as Record<string, unknown>) ?? {}) };
  const security = { ...((wf.security as Record<string, unknown>) ?? {}) };
  security.webhook_secret = secret;
  wf.security = security;
  return wf;
}

function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

export type WebhookSecretResult = { hasWebhookTrigger: boolean; secret: string | null };

async function persistSecret(
  db: ReturnType<typeof createServiceClient>,
  userId: string,
  workflow: WorkflowSecretRow,
  secret: string,
): Promise<void> {
  const updatedJson = withWebhookSecret(workflow.workflow_json, secret);
  await db
    .from('workflows')
    .update({ workflow_json: updatedJson, updated_at: new Date().toISOString() })
    .eq('id', workflow.id)
    .eq('user_id', userId);

  // Also patch the FROZEN active deployment version in place -- that is
  // what the webhook route actually validates against for an active
  // workflow (runtime/workflow-engine.ts and the route both prefer the
  // frozen snapshot over live workflow_json). No new version, no schema
  // change: same JSONB column, same row, one field added/replaced.
  if (workflow.active_deployment_version_id) {
    const { data: version } = await db
      .from('deployment_versions')
      .select('workflow_data')
      .eq('id', workflow.active_deployment_version_id)
      .maybeSingle();
    if (version) {
      const updatedVersionData = withWebhookSecret(version.workflow_data, secret);
      await db
        .from('deployment_versions')
        .update({ workflow_data: updatedVersionData })
        .eq('id', workflow.active_deployment_version_id);
    }
  }
}

async function loadWorkflowRow(userId: string, workflowId: string): Promise<WorkflowSecretRow | null> {
  const db = createServiceClient();
  const { data } = await db
    .from('workflows')
    .select('id, workflow_json, active_deployment_version_id')
    .eq('id', workflowId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as WorkflowSecretRow | null) ?? null;
}

/**
 * Idempotent: returns the workflow's existing per-workflow webhook secret,
 * generating and persisting one only the first time this is called for a
 * workflow that has a webhook trigger and none yet. Never regenerates an
 * existing value. Safe to call on every activation and every dashboard
 * load -- this is also the backfill path for workflows that were activated
 * before this fix shipped and so have no secret at all yet.
 */
export async function ensureWebhookSecret(userId: string, workflowId: string): Promise<WebhookSecretResult> {
  const workflow = await loadWorkflowRow(userId, workflowId);
  if (!workflow || !hasWebhookTrigger(workflow.workflow_json)) {
    return { hasWebhookTrigger: false, secret: null };
  }

  const existing = extractWebhookSecret(workflow.workflow_json);
  if (existing) {
    return { hasWebhookTrigger: true, secret: existing };
  }

  const secret = generateSecret();
  const db = createServiceClient();
  await persistSecret(db, userId, workflow, secret);
  return { hasWebhookTrigger: true, secret };
}

/**
 * Always generates a fresh value, overwriting any existing one in place --
 * the old value simply stops matching from that point on (guardWebhookRequest
 * compares against whatever is currently stored), so it is invalidated
 * immediately. No new deployment version, no new workflow row.
 */
export async function rotateWebhookSecret(userId: string, workflowId: string): Promise<WebhookSecretResult> {
  const workflow = await loadWorkflowRow(userId, workflowId);
  if (!workflow || !hasWebhookTrigger(workflow.workflow_json)) {
    return { hasWebhookTrigger: false, secret: null };
  }

  const secret = generateSecret();
  const db = createServiceClient();
  await persistSecret(db, userId, workflow, secret);
  return { hasWebhookTrigger: true, secret };
}
