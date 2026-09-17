import 'server-only';

import { validateWorkflow } from '@/lib/workflow-validator';
import { validateScheduleTriggers } from '@/lib/runtime/scheduler';
import { validateSupportedTemplateSyntax } from '@/lib/agent/template-expression-guard';
import { validateNotificationFieldAllowlist } from '@/lib/agent/notification-content-guard';
import { validateQualificationPolicyShape } from '@/lib/agent/qualification-policy-guard';
import { validateAirtableDedupeClaim } from '@/lib/agent/airtable-dedupe-guard';
import { validateSlaAcknowledgmentGating } from '@/lib/agent/sla-acknowledgment-gating-guard';
import { validateAirtableConfiguration, validateRequiredIntegrationsConnected } from '@/lib/workflow/lifecycle';

export type ReadinessCheck = { key: string; label: string; ok: boolean; messages: string[] };
export type ReadinessSummary = { ready: boolean; checks: ReadinessCheck[] };

/**
 * Phase 9.9.16 -- Part M: runs the EXACT SAME checks
 * lib/workflow/lifecycle.ts's activateWorkflow() runs, grouped into a
 * human-readable checklist, WITHOUT mutating the workflow's status or
 * claiming the 'validating' state -- purely a read-only preview so a user
 * can see what's blocking Activate before clicking it (Part K: "do not
 * make the user discover these only at runtime"). If this summary and
 * activation ever disagree, activation's own re-check is what's
 * authoritative -- this is a preview, never a second source of truth.
 */
export async function checkWorkflowReadiness(userId: string, workflowJson: unknown): Promise<ReadinessSummary> {
  const nodes = Array.isArray((workflowJson as { nodes?: unknown })?.nodes) ? ((workflowJson as { nodes: unknown[] }).nodes) : [];
  const connections = (workflowJson as { connections?: unknown })?.connections;

  const structural = validateWorkflow(workflowJson);
  const scheduleErrors = validateScheduleTriggers(workflowJson);
  const airtableErrors = await validateAirtableConfiguration(userId, workflowJson);
  const integrationErrors = await validateRequiredIntegrationsConnected(userId, workflowJson);
  const templateResult = validateSupportedTemplateSyntax(nodes);
  const notificationResult = validateNotificationFieldAllowlist(nodes);
  const qualificationResult = validateQualificationPolicyShape(nodes);
  const dedupeResult = validateAirtableDedupeClaim(nodes);
  const slaResult = validateSlaAcknowledgmentGating(nodes, connections);

  const checks: ReadinessCheck[] = [
    { key: 'structure', label: 'Workflow Structure', ok: structural.errors.length === 0, messages: structural.errors.map((e) => e.message) },
    { key: 'schedules', label: 'Scheduled Triggers', ok: scheduleErrors.length === 0, messages: scheduleErrors },
    { key: 'ai_policy', label: 'AI Policy', ok: qualificationResult.ok, messages: qualificationResult.ok ? [] : [qualificationResult.reason] },
    { key: 'airtable', label: 'Airtable', ok: airtableErrors.length === 0 && dedupeResult.ok, messages: [...airtableErrors, ...(dedupeResult.ok ? [] : [dedupeResult.reason])] },
    { key: 'notifications', label: 'Gmail / Slack', ok: templateResult.ok && notificationResult.ok, messages: [...(templateResult.ok ? [] : [templateResult.reason]), ...(notificationResult.ok ? [] : [notificationResult.reason])] },
    { key: 'sla', label: 'SLA / Acknowledgment', ok: slaResult.ok, messages: slaResult.ok ? [] : [slaResult.reason] },
    { key: 'integrations', label: 'Integrations Connected', ok: integrationErrors.length === 0, messages: integrationErrors },
  ];

  return { ready: checks.every((c) => c.ok), checks };
}
