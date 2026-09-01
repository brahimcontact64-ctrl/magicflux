import 'server-only';

import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase-server';
import { DeploymentManager } from '@/lib/deployment/deployment-manager';
import { validateWorkflow } from '@/lib/workflow-validator';
import { validateScheduleTriggers, syncWorkflowSchedules, disableWorkflowSchedules, enableWorkflowSchedules } from '@/lib/runtime/scheduler';
import { assertTrustedUserId } from '@/lib/credentials/storage';

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
  | { success: true; status: 'active'; version: number; deploymentVersionId: string }
  | { success: false; status: 'error'; errors: string[] };

type WorkflowRow = {
  id: string;
  user_id: string;
  workflow_json: unknown;
  status: string;
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
    .select('id, user_id, workflow_json, status')
    .eq('id', workflowId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data as WorkflowRow | null) ?? null;
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

  await db.from('workflows').update({ status: 'validating', updated_at: new Date().toISOString() }).eq('id', workflowId).eq('user_id', userId);

  const structuralResult = validateWorkflow(workflow.workflow_json);
  const scheduleErrors = validateScheduleTriggers(workflow.workflow_json);
  const errors = [
    ...structuralResult.errors.map((e) => e.message),
    ...scheduleErrors,
  ];

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

  return { success: true, status: 'active', version: version.version, deploymentVersionId: version.id };
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
