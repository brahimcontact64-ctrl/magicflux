import 'server-only';

import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase-server';
import { DeploymentManager } from '@/lib/deployment/deployment-manager';
import { validateWorkflow } from '@/lib/workflow-validator';
import { validateScheduleTriggers, syncWorkflowSchedules, disableWorkflowSchedules, enableWorkflowSchedules } from '@/lib/runtime/scheduler';
import { assertTrustedUserId } from '@/lib/credentials/storage';
import { getConnectedAirtableToken, getWorkflowIntegrationStatus } from '@/lib/user-integrations';
import { ensureWebhookSecret } from '@/lib/workflow/webhook-secret';
import { extractAirtableNodeConfig, isAirtableNodeType } from '@/lib/airtable/node-params';
import { validateAirtableMapping } from '@/lib/airtable/schema';
import { validateSupportedTemplateSyntax } from '@/lib/agent/template-expression-guard';
import { validateNotificationFieldAllowlist } from '@/lib/agent/notification-content-guard';
import { validateQualificationPolicyShape } from '@/lib/agent/qualification-policy-guard';
import { validateAirtableDedupeClaim } from '@/lib/agent/airtable-dedupe-guard';
import { validateSlaAcknowledgmentGating } from '@/lib/agent/sla-acknowledgment-gating-guard';

/**
 * Production workflow lifecycle: draft -> validating -> active -> paused /
 * disabled -> archived, plus error.
 *
 * Version freezing deliberately reuses DeploymentManager.recordDeployment()
 * (lib/deployment/deployment-manager.ts) — it already computes the next
 * version number, marks the previous active deployment_versions row
 * superseded, and inserts the new frozen workflow_data snapshot atomically
 * enough for this scale. Activation just points workflows.status/
 * active_deployment_version_id at the result instead of building a second
 * version-freeze mechanism.
 */

export type LifecycleStatus = 'draft' | 'validating' | 'active' | 'paused' | 'disabled' | 'error' | 'archived' | 'deployed';

export type ActivationResult =
  | { success: true; status: 'active'; version: number; deploymentVersionId: string; alreadyActive?: boolean }
  | { success: false; status: 'error'; errors: string[] };

type WorkflowRow = {
  id: string;
  user_id: string;
  workflow_json: unknown;
  status: string;
  updated_at: string;
};

// Exported (Phase 9.1.5) so callers — specifically the lifecycle route's
// entitlement gate — can check ownership/existence BEFORE running an
// account-level check like canDeployWorkflow(), which knows nothing about
// a specific workflow. Checking entitlement first would leak "you'd need
// Pro for this" (403) for a workflow the caller doesn't even own, instead
// of the existing IDOR-safe "not found" (404).
export async function loadWorkflow(userId: string, workflowId: string): Promise<WorkflowRow | null> {
  const db = createServiceClient();
  const { data } = await db
    .from('workflows')
    .select('id, user_id, workflow_json, status, updated_at')
    .eq('id', workflowId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as WorkflowRow | null) ?? null;
}

/** Deterministic JSON stringify (sorted object keys) for structural equality checks that must not be fooled by key ordering. */
// Phase 9.9.17A -- Part G: exported so the workflow GET route can tell the
// Dashboard whether the draft actually differs from what's deployed
// ("Up to date" vs "Unpublished changes"), using the EXACT SAME comparison
// publishNewVersion() itself uses to decide whether publishing would be a
// no-op -- never a second, potentially-inconsistent diff implementation.
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

/**
 * Phase 9.9.3 -- pre-activation Airtable schema gate. "Save to Airtable"
 * must never be claimed deploy-ready with an unverified/invented/missing
 * base, table, or field mapping. For every Airtable node in the workflow:
 *   - baseId/tableId must be non-empty (a founder must have completed the
 *     Builder's real schema-picker configuration step -- see
 *     app/api/workflows/[id]/airtable-config) -- an empty value here means
 *     "never configured," which is exactly generation's own leftover state
 *     when a real base/table was never invented in the first place.
 *   - the configured base/table/fields are re-verified against Airtable's
 *     REAL live schema right now, not trusted from whenever they were last
 *     saved -- a founder could have renamed/deleted a field or table in
 *     Airtable itself since configuring it.
 * Returns a list of human-readable errors (empty = fully configured and verified).
 */
// Phase 9.9.16 -- Part M: exported (logic unchanged) so the new read-only
// /api/workflows/[id]/readiness route can run the exact same checks
// activation runs, before the user ever clicks Activate, without
// duplicating this logic a second time.
export async function validateAirtableConfiguration(userId: string, workflowJson: unknown): Promise<string[]> {
  const nodes = Array.isArray((workflowJson as { nodes?: unknown })?.nodes)
    ? ((workflowJson as { nodes: unknown[] }).nodes as Array<{ id?: string; name?: string; type?: string; parameters?: unknown }>)
    : [];
  const airtableNodes = nodes.filter((n) => isAirtableNodeType(n.type));
  if (airtableNodes.length === 0) return [];

  // Phase 9.9.4B -- unified with the same canonical lookup Settings/runtime
  // use (getUserIntegrations()'s legacy+bridged merge), not the unrelated
  // dynamic-provider credential store this previously (and incorrectly)
  // queried directly.
  let token: string | null;
  try {
    token = await getConnectedAirtableToken(userId);
  } catch {
    token = null;
  }

  const errors: string[] = [];
  for (const node of airtableNodes) {
    const label = String(node.name ?? node.id ?? 'Airtable step');
    const config = extractAirtableNodeConfig(node);

    if (!config.baseId || !config.tableId) {
      errors.push(`"${label}" has no Airtable base/table configured yet -- open this workflow's Airtable configuration step and select a real base and table before activating.`);
      continue;
    }

    if (!token) {
      errors.push(`"${label}" requires a connected Airtable account to verify its base/table/fields before activation.`);
      continue;
    }

    const validation = await validateAirtableMapping(token, config.baseId, config.tableId, config.fieldKeys);
    if (!validation.ok) {
      errors.push(`"${label}": ${validation.reason}`);
    }
  }

  return errors;
}

/**
 * Phase 9.9.14 -- Part J: closes a gap Airtable already closed for itself
 * (validateAirtableConfiguration above) but every OTHER provider (Slack,
 * Gmail, etc.) did not have at all -- a workflow with a Slack or Gmail node
 * could activate successfully with NO integration connected, and the very
 * first live execution would fail at runtime with no way this could have
 * been caught earlier. Reuses getWorkflowIntegrationStatus() (the SAME
 * generic, provider-agnostic function the Builder/deploy/live-test routes
 * already use to compute "what does this workflow need vs. what's
 * connected") rather than inventing a second, Slack/Gmail-specific check --
 * this covers every current and future provider uniformly. Airtable is
 * excluded here since validateAirtableConfiguration above already gives a
 * more specific, schema-verified error for it.
 */
export async function validateRequiredIntegrationsConnected(userId: string, workflowJson: unknown): Promise<string[]> {
  const status = await getWorkflowIntegrationStatus(userId, workflowJson);
  const missing = status.missing_integrations.filter((p) => p !== 'airtable');
  return missing.map((provider) => `This workflow requires a connected "${provider}" integration, but none is connected -- connect it in Settings before activating.`);
}

/**
 * Phase 9.9.17A -- Part D: the exact same guard suite activateWorkflow()
 * has always run (structure, schedules, Airtable schema, integrations,
 * template syntax, notification safety, qualification policy, dedupe),
 * extracted so publishNewVersion() below can reuse it byte-for-byte rather
 * than defining a second, potentially-weaker "republish validation."
 * Pure read/validate -- makes no database writes and never touches
 * workflows.status.
 */
async function runActivationGuards(userId: string, workflowJson: unknown): Promise<string[]> {
  const structuralResult = validateWorkflow(workflowJson);
  const scheduleErrors = validateScheduleTriggers(workflowJson);
  const airtableErrors = await validateAirtableConfiguration(userId, workflowJson);
  const requiredIntegrationErrors = await validateRequiredIntegrationsConnected(userId, workflowJson);
  const templateSyntaxNodes = Array.isArray((workflowJson as { nodes?: unknown })?.nodes)
    ? ((workflowJson as { nodes: unknown[] }).nodes)
    : [];
  const templateSyntaxResult = validateSupportedTemplateSyntax(templateSyntaxNodes);
  const templateSyntaxErrors = templateSyntaxResult.ok ? [] : [templateSyntaxResult.reason];
  const notificationContentResult = validateNotificationFieldAllowlist(templateSyntaxNodes);
  const notificationContentErrors = notificationContentResult.ok ? [] : [notificationContentResult.reason];
  const qualificationPolicyResult = validateQualificationPolicyShape(templateSyntaxNodes);
  const qualificationPolicyErrors = qualificationPolicyResult.ok ? [] : [qualificationPolicyResult.reason];
  const airtableDedupeResult = validateAirtableDedupeClaim(templateSyntaxNodes);
  const airtableDedupeErrors = airtableDedupeResult.ok ? [] : [airtableDedupeResult.reason];
  const connections = (workflowJson as { connections?: unknown })?.connections;
  const slaResult = validateSlaAcknowledgmentGating(templateSyntaxNodes, connections);
  const slaErrors = slaResult.ok ? [] : [slaResult.reason];

  return [
    ...structuralResult.errors.map((e) => e.message),
    ...scheduleErrors,
    ...airtableErrors,
    ...requiredIntegrationErrors,
    ...templateSyntaxErrors,
    ...notificationContentErrors,
    ...qualificationPolicyErrors,
    ...airtableDedupeErrors,
    ...slaErrors,
  ];
}

/**
 * Validates and activates a workflow: freezes the current workflow_json into
 * a new deployment_versions row (status='active', superseding any prior
 * active version), points workflows.active_deployment_version_id at it, and
 * registers any schedule-trigger nodes. Only ever succeeds for a workflow
 * that passes lib/workflow-validator (the same validator that guarantees a
 * workflow can execute safely in runtime/workflow-engine.ts) AND has valid
 * cron expressions on every schedule-trigger node.
 *
 * On failure, the workflow is marked status='error' with deployment_error
 * set to the joined validation messages — activation never fails silently.
 *
 * Phase 9.9.17A -- Part D: this function's own brief `status: 'validating'`
 * window (below) is harmless for a workflow's FIRST activation (draft ->
 * active) -- nothing was serving traffic yet. It must never be used to
 * republish an ALREADY-active workflow's changed draft -- see
 * publishNewVersion() below, which runs the identical guard suite without
 * ever making the row non-executable, for exactly that case.
 */
export async function activateWorkflow(userId: string, workflowId: string): Promise<ActivationResult> {
  assertTrustedUserId(userId);
  const db = createServiceClient();

  const workflow = await loadWorkflow(userId, workflowId);
  if (!workflow) {
    return { success: false, status: 'error', errors: ['Workflow not found'] };
  }
  if (workflow.status === 'archived') {
    return { success: false, status: 'error', errors: ['Archived workflows cannot be activated. Restore to draft first.'] };
  }

  // Phase 9.8.1 -- idempotency, content-aware. A repeated Approve + Deploy
  // click (or a client retry after a success response was lost) on the
  // SAME already-active reviewed content must be a harmless no-op, never a
  // second frozen version -- this directly answers the Phase 9.8
  // requirement that "repeated activation of the same reviewed version
  // must not create duplicate deployment versions/jobs." Deliberately
  // content-based, not just status-based: a workflow can be edited via
  // PATCH /api/workflows/[id] while still 'active' (that route never
  // resets status), so a genuinely edited-then-reactivated workflow must
  // still freeze a real new version -- only a byte-for-byte-unchanged
  // re-click is idempotent.
  if (isExecutableStatus(workflow.status)) {
    const { data: activeVersion } = await db
      .from('deployment_versions')
      .select('id, version, workflow_data')
      .eq('workflow_id', workflowId)
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeVersion && stableJson(activeVersion.workflow_data) === stableJson(workflow.workflow_json)) {
      // Phase 9.8.4 -- backfill path: a workflow activated before per-workflow
      // webhook secrets existed reaches this idempotent early-return on every
      // repeat Approve+Deploy click without ever touching the "freeze a new
      // version" code below, so it must provision its secret here too, not
      // only on first-ever activation.
      await ensureWebhookSecret(userId, workflowId);
      return { success: true, status: 'active', version: activeVersion.version, deploymentVersionId: activeVersion.id, alreadyActive: true };
    }
    // No matching frozen version, or content has changed since it was
    // frozen -- fall through and freeze a real new one.
  }

  // Atomic claim: only one concurrent caller can move this workflow out of
  // a state eligible for (re)activation. A concurrent second call (a rapid
  // double-click arriving before the first has finished validating)
  // affects zero rows here -- current status is already 'validating' -- and
  // is reported as "already in progress" instead of racing ahead to freeze
  // a second deployment_versions row for the same click.
  const { data: claimed } = await db
    .from('workflows')
    .update({ status: 'validating', updated_at: new Date().toISOString() })
    .eq('id', workflowId)
    .eq('user_id', userId)
    .neq('status', 'validating')
    .select('id')
    .maybeSingle();

  if (!claimed) {
    return { success: false, status: 'error', errors: ['Activation is already in progress for this workflow.'] };
  }

  const errors = await runActivationGuards(userId, workflow.workflow_json);

  if (errors.length > 0) {
    await db
      .from('workflows')
      .update({ status: 'error', deployment_error: errors.join('; '), updated_at: new Date().toISOString() })
      .eq('id', workflowId)
      .eq('user_id', userId);
    return { success: false, status: 'error', errors };
  }

  const deploymentManager = new DeploymentManager();
  const version = await deploymentManager.recordDeployment(
    userId,
    workflowId,
    `native-${randomUUID()}`,
    workflow.workflow_json,
    { metadata: { activatedNatively: true } },
  );

  const now = new Date().toISOString();
  await db
    .from('workflows')
    .update({
      status: 'active',
      active_deployment_version_id: version.id,
      activated_at: now,
      deployment_error: null,
      updated_at: now,
    })
    .eq('id', workflowId)
    .eq('user_id', userId);

  await syncWorkflowSchedules({ userId, workflowId, workflowJson: workflow.workflow_json });

  // Phase 9.8.4 -- provision this workflow's own webhook secret (if it has
  // a webhook trigger and doesn't have one yet) now that activation has
  // frozen a deployment version to patch it into. Idempotent: never
  // regenerates an existing secret.
  await ensureWebhookSecret(userId, workflowId);

  return { success: true, status: 'active', version: version.version, deploymentVersionId: version.id };
}

export type PublishResult =
  | { success: true; alreadyUpToDate: true; version: number; deploymentVersionId: string }
  | { success: true; alreadyUpToDate: false; version: number; deploymentVersionId: string; supersededVersionId: string | null }
  | { success: false; reason: 'not_executable'; message: string }
  | { success: false; reason: 'validation_failed'; errors: string[] }
  | { success: false; reason: 'stale_draft'; latestUpdatedAt: string }
  | { success: false; reason: 'conflict'; message: string };

/**
 * Phase 9.9.17A -- Part A/D/E/F: publishes the current draft as a new,
 * immutable deployment version for a workflow that is ALREADY active,
 * without ever making it non-executable in between.
 *
 * Contrast with activateWorkflow() above: that function's brief
 * `status: 'validating'` claim is safe only for a workflow's first
 * activation (nothing was serving traffic yet). This function is for the
 * opposite case -- v1 is live, RIGHT NOW, and must keep serving webhook
 * traffic for the entire duration of validation. It therefore:
 *   - never writes to `workflows.status` at all (Part D -- no interval
 *     where the workflow becomes non-executable merely because a new
 *     draft is being validated; isExecutableStatus() stays true
 *     throughout, so the webhook route in-flight the whole time keeps
 *     resolving the CURRENT active_deployment_version_id -- v1 -- exactly
 *     as it already does for every other request);
 *   - runs the identical runActivationGuards() suite (Part D: no weaker
 *     "republish validation");
 *   - makes ZERO database writes at all on a validation failure (Part B/J:
 *     v1 remains untouched, draft remains editable, zero side effects);
 *   - requires the caller's own last-known `expectedUpdatedAt` and
 *     verifies it twice -- once before validating (fail fast on an
 *     already-stale draft) and again, atomically, on the final cutover
 *     write (Part E/F: this is what makes "two Publish clicks from the
 *     same starting revision" and "the draft changed mid-publish"
 *     resolve to at most one successful transition, the same CAS pattern
 *     already certified in lib/workflow/node-config-save.ts).
 *
 * The version-number race between two genuinely concurrent publishers is
 * closed by the pre-existing `UNIQUE (workflow_id, version)` constraint on
 * deployment_versions -- confirmed live via `pg_indexes` before writing
 * this function, not assumed. No migration is required.
 */
export async function publishNewVersion(userId: string, workflowId: string, expectedUpdatedAt: string): Promise<PublishResult> {
  assertTrustedUserId(userId);
  const db = createServiceClient();

  const workflow = await loadWorkflow(userId, workflowId);
  if (!workflow) return { success: false, reason: 'not_executable', message: 'Workflow not found.' };
  if (!isExecutableStatus(workflow.status)) {
    return { success: false, reason: 'not_executable', message: `This workflow is currently "${workflow.status}" -- use Activate, not Publish, to bring it live for the first time.` };
  }
  if (workflow.updated_at !== expectedUpdatedAt) {
    return { success: false, reason: 'stale_draft', latestUpdatedAt: workflow.updated_at };
  }

  const { data: activeVersion } = await db
    .from('deployment_versions')
    .select('id, version, workflow_data')
    .eq('workflow_id', workflowId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Part K test 10 -- an identical draft never creates an unnecessary new
  // version, exactly like activateWorkflow()'s own idempotency check.
  if (activeVersion && stableJson(activeVersion.workflow_data) === stableJson(workflow.workflow_json)) {
    return { success: true, alreadyUpToDate: true, version: activeVersion.version, deploymentVersionId: activeVersion.id };
  }

  // Part D -- the identical guard suite, run while the row is still fully
  // 'active'/executable. No status write happens before, during, or after
  // this call on either success or failure.
  const errors = await runActivationGuards(userId, workflow.workflow_json);
  if (errors.length > 0) {
    return { success: false, reason: 'validation_failed', errors };
  }

  // Cutover. recordDeployment() itself is not wrapped in a single DB
  // transaction, but the pre-existing UNIQUE(workflow_id, version)
  // constraint makes a version-number collision between two genuinely
  // concurrent publishers fail loudly (a constraint-violation exception)
  // rather than silently succeed with two simultaneously-active rows --
  // caught below and reported as a clean conflict, never left to surface
  // as a raw 500.
  const deploymentManager = new DeploymentManager();
  let version;
  try {
    version = await deploymentManager.recordDeployment(
      userId,
      workflowId,
      `native-${randomUUID()}`,
      workflow.workflow_json,
      { metadata: { publishedWhileActive: true } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('duplicate key') || message.includes('unique constraint')) {
      return { success: false, reason: 'conflict', message: 'Another publish just completed for this workflow. Reload to see the latest deployed version before publishing again.' };
    }
    throw err;
  }

  // Final CAS: only point the canonical workflow row at the new version if
  // nothing else has changed it since we started (Part E/F). If this loses
  // the race, the new deployment_versions row we just created simply sits
  // inert -- never pointed to by active_deployment_version_id, so it never
  // goes live. No corruption, just one wasted (but harmless) version slot.
  const now = new Date().toISOString();
  const { data: cutover } = await db
    .from('workflows')
    .update({ active_deployment_version_id: version.id, activated_at: now, deployment_error: null, updated_at: now })
    .eq('id', workflowId)
    .eq('user_id', userId)
    .eq('updated_at', expectedUpdatedAt)
    .select('id')
    .maybeSingle();

  if (!cutover) {
    return { success: false, reason: 'conflict', message: 'This workflow was changed elsewhere while your publish was validating. Reload to see the latest version before publishing again.' };
  }

  await syncWorkflowSchedules({ userId, workflowId, workflowJson: workflow.workflow_json });
  await ensureWebhookSecret(userId, workflowId);

  return { success: true, alreadyUpToDate: false, version: version.version, deploymentVersionId: version.id, supersededVersionId: activeVersion?.id ?? null };
}

async function setStatus(userId: string, workflowId: string, status: LifecycleStatus): Promise<{ success: boolean; error?: string }> {
  assertTrustedUserId(userId);
  const db = createServiceClient();
  const { data, error } = await db
    .from('workflows')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', workflowId)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Workflow not found' };
  return { success: true };
}

/** Stops future triggers (webhook, schedule) without touching executions already in progress. */
export async function pauseWorkflow(userId: string, workflowId: string): Promise<{ success: boolean; error?: string }> {
  const result = await setStatus(userId, workflowId, 'paused');
  if (result.success) await disableWorkflowSchedules(userId, workflowId);
  return result;
}

/** Resumes a paused workflow — re-enables triggers using the already-frozen active version (does not re-validate or re-freeze). */
export async function resumeWorkflow(userId: string, workflowId: string): Promise<{ success: boolean; error?: string }> {
  const workflow = await loadWorkflow(userId, workflowId);
  if (!workflow) return { success: false, error: 'Workflow not found' };
  if (workflow.status !== 'paused') return { success: false, error: `Cannot resume from status "${workflow.status}" — only paused workflows can be resumed` };

  const result = await setStatus(userId, workflowId, 'active');
  if (result.success) await enableWorkflowSchedules(userId, workflowId);
  return result;
}

/** Deactivates a workflow — stops future triggers, does not corrupt in-progress executions (they keep running against their pinned version). */
export async function deactivateWorkflow(userId: string, workflowId: string): Promise<{ success: boolean; error?: string }> {
  const result = await setStatus(userId, workflowId, 'disabled');
  if (result.success) await disableWorkflowSchedules(userId, workflowId);
  return result;
}

/** Archives a workflow — terminal state, cannot execute. */
export async function archiveWorkflow(userId: string, workflowId: string): Promise<{ success: boolean; error?: string }> {
  const result = await setStatus(userId, workflowId, 'archived');
  if (result.success) await disableWorkflowSchedules(userId, workflowId);
  return result;
}

/** True for any status that permits triggering a new execution (webhook, schedule, or manual live-test). */
export function isExecutableStatus(status: string): boolean {
  return status === 'active' || status === 'deployed';
}
