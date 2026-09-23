import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';
import { isExecutableStatus } from '@/lib/workflow/lifecycle';

/**
 * Phase 9.9.21 -- Part 6: "Test Connection" needs a safe way to (a) know a
 * real inbound event arrived at the REAL production webhook URL, without
 * (b) ever dispatching it to a real execution (real emails/Slack messages/
 * Airtable records) unless the owner explicitly chose that.
 *
 * Deliberately stores its state inside the EXISTING workflow_json.security
 * JSONB object -- the exact same no-schema-change convention
 * lib/workflow/webhook-secret.ts already established for the webhook
 * secret itself -- rather than a new table/column, per this engagement's
 * standing "stop before any schema migration" rule (see the Phase 9.9.12
 * acknowledgments migration's own header comment for precedent). No
 * migration, no approval gate, no new surface for RLS to get wrong.
 *
 * Safety-critical invariant, enforced in app/api/workflows/[id]/webhook/
 * route.ts, not here: test mode is only ever CONSULTED when the workflow's
 * status is NOT executable (isExecutableStatus() is false). An ACTIVE
 * workflow's real dispatch path is completely untouched by this module --
 * startTestMode() below refuses to arm test mode for an executable
 * workflow in the first place, so Workflow #1 (or any other live workflow)
 * can never have its real traffic silently swallowed by a stale test flag.
 */

export type TestEvent = {
  receivedAt: string;
  authenticated: boolean;
  valid: boolean;
  missingFields: string[];
  presentFields: string[];
};

export type TestModeState = {
  active: boolean;
  until: string | null;
  lastEvent: TestEvent | null;
};

type WorkflowRow = {
  id: string;
  workflow_json: unknown;
  active_deployment_version_id: string | null;
};

function readSecurity(workflowJson: unknown): Record<string, unknown> {
  const wf = (workflowJson ?? {}) as Record<string, unknown>;
  return { ...((wf.security as Record<string, unknown>) ?? {}) };
}

export function extractTestModeState(workflowJson: unknown): TestModeState {
  const security = readSecurity(workflowJson);
  const until = typeof security.test_mode_until === 'string' ? security.test_mode_until : null;
  const active = until !== null && new Date(until).getTime() > Date.now();
  const lastEvent = (security.last_test_event as TestEvent | undefined) ?? null;
  return { active, until: active ? until : null, lastEvent };
}

function withSecurityPatch(workflowJson: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const wf = { ...((workflowJson as Record<string, unknown>) ?? {}) };
  wf.security = { ...readSecurity(workflowJson), ...patch };
  return wf;
}

async function loadWorkflowRow(userId: string, workflowId: string): Promise<(WorkflowRow & { status: string }) | null> {
  const db = createServiceClient();
  const { data } = await db
    .from('workflows')
    .select('id, workflow_json, active_deployment_version_id, status')
    .eq('id', workflowId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as (WorkflowRow & { status: string }) | null) ?? null;
}

async function persist(db: ReturnType<typeof createServiceClient>, workflow: WorkflowRow, patch: Record<string, unknown>): Promise<void> {
  const updatedJson = withSecurityPatch(workflow.workflow_json, patch);
  await db.from('workflows').update({ workflow_json: updatedJson, updated_at: new Date().toISOString() }).eq('id', workflow.id);

  // Test mode only ever applies to a non-executable workflow (see the
  // module header), which by definition has no frozen active deployment
  // version that real traffic is dispatched from -- but a workflow CAN be
  // paused (isExecutableStatus() false) while still carrying an
  // active_deployment_version_id from a prior activation, so this keeps
  // that frozen copy's security object consistent too, matching
  // webhook-secret.ts's own persistSecret() precedent.
  if (workflow.active_deployment_version_id) {
    const { data: version } = await db
      .from('deployment_versions')
      .select('workflow_data')
      .eq('id', workflow.active_deployment_version_id)
      .maybeSingle();
    if (version) {
      const updatedVersionData = withSecurityPatch(version.workflow_data, patch);
      await db.from('deployment_versions').update({ workflow_data: updatedVersionData }).eq('id', workflow.active_deployment_version_id);
    }
  }
}

export type ConnectionTestResult =
  | { ok: true; hasWebhookTrigger: boolean; status: string; state: TestModeState }
  | { ok: false; error: string };

export async function getConnectionTestState(userId: string, workflowId: string): Promise<ConnectionTestResult> {
  const workflow = await loadWorkflowRow(userId, workflowId);
  if (!workflow) return { ok: false, error: 'Workflow not found' };
  return { ok: true, hasWebhookTrigger: true, status: workflow.status, state: extractTestModeState(workflow.workflow_json) };
}

const DEFAULT_TTL_MINUTES = 15;
const MAX_TTL_MINUTES = 60;

export async function startTestMode(userId: string, workflowId: string, ttlMinutes = DEFAULT_TTL_MINUTES): Promise<ConnectionTestResult> {
  const workflow = await loadWorkflowRow(userId, workflowId);
  if (!workflow) return { ok: false, error: 'Workflow not found' };

  // The core safety guarantee (see module header) -- never even write a
  // test_mode_until onto a workflow whose real webhook dispatch is live.
  if (isExecutableStatus(workflow.status)) {
    return { ok: false, error: 'Test Connection is only available while the workflow is not yet active -- an active workflow\'s real traffic is never paused for testing. Pause it first, or test before activating.' };
  }

  const clampedTtl = Math.min(Math.max(1, ttlMinutes), MAX_TTL_MINUTES);
  const until = new Date(Date.now() + clampedTtl * 60 * 1000).toISOString();

  const db = createServiceClient();
  await persist(db, workflow, { test_mode_until: until, last_test_event: null });

  return { ok: true, hasWebhookTrigger: true, status: workflow.status, state: { active: true, until, lastEvent: null } };
}

export async function stopTestMode(userId: string, workflowId: string): Promise<ConnectionTestResult> {
  const workflow = await loadWorkflowRow(userId, workflowId);
  if (!workflow) return { ok: false, error: 'Workflow not found' };

  const db = createServiceClient();
  await persist(db, workflow, { test_mode_until: null });

  return { ok: true, hasWebhookTrigger: true, status: workflow.status, state: extractTestModeState(withSecurityPatch(workflow.workflow_json, { test_mode_until: null })) };
}

/**
 * Called directly from the PUBLIC (unauthenticated) webhook route, given
 * the workflow row it already loaded -- never re-fetches, never requires a
 * userId (the caller here is the external platform, not the owner).
 */
export async function recordTestEvent(
  db: ReturnType<typeof createServiceClient>,
  workflow: WorkflowRow,
  event: TestEvent,
): Promise<void> {
  await persist(db, workflow, { last_test_event: event });
}
