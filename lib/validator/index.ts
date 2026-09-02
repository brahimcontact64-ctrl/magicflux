/**
 * Workflow Validator
 * Validates composed workflows before deployment.
 * Checks structure, connections, credentials, and deployment readiness.
 *
 * Deploy gate: score must be >= 80.
 * Activation gate: all required credentials must be linked in n8n first.
 */

import { BLOCKS, ComposedWorkflow, CREDENTIAL_TYPE_MAP } from '../blocks';
import { AutomationPlan, N8nWorkflow } from '../planner';
import { checkNodeCapability } from '@/lib/workflow-runtime/node-capabilities';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  code: string;
  severity: ValidationSeverity;
  message: string;
  nodeId?: string;
  nodeName?: string;
  autoFixable: boolean;
  fix?: string;
}

/** Per-credential requirement for the UI and activation gate */
export interface CredentialRequirement {
  service: string;
  n8nCredentialType: string;
  description: string;
  setupUrl?: string;
  nodeNames: string[];
}

export interface ValidationResult {
  valid: boolean;
  score: number;
  runtimeCompatible: boolean;
  importable: boolean;
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  infos: ValidationIssue[];
  summary: string;
  deploymentReady: boolean;
  /** Credentials that must be created in n8n before activation */
  credentialsRequired: CredentialRequirement[];
  /** Legacy flat list for backward compat */
  credentialsMissing: string[];
  estimatedSetupTime: string;
  activationBlocked: boolean;
  activationBlockReason: string;
}

// ─── VALIDATION RULES ────────────────────────────────────────────────────────

function checkHasTrigger(plan: AutomationPlan, issues: ValidationIssue[]): boolean {
  if (!plan.trigger.blockId) {
    issues.push({
      code: 'NO_TRIGGER',
      severity: 'error',
      message: 'Workflow has no trigger node. Every workflow must start with a trigger.',
      autoFixable: false
    });
    return false;
  }
  return true;
}

function checkHasActions(plan: AutomationPlan, issues: ValidationIssue[]): boolean {
  if (plan.steps.length === 0) {
    issues.push({
      code: 'NO_ACTIONS',
      severity: 'error',
      message: 'Workflow has no action steps. Add at least one action (e.g., send email, save to Airtable).',
      autoFixable: false
    });
    return false;
  }
  return true;
}

function checkUnsupportedBlocks(plan: AutomationPlan, issues: ValidationIssue[]): void {
  const allBlockIds = [plan.trigger.blockId, ...plan.steps.map(s => s.blockId)];
  for (const blockId of allBlockIds) {
    if (!BLOCKS[blockId]) {
      issues.push({
        code: 'UNSUPPORTED_BLOCK',
        severity: 'error',
        message: `Block "${blockId}" is not in the approved registry. Only registered blocks may be used.`,
        nodeId: blockId,
        autoFixable: false
      });
    }
  }
}

function checkConnections(composition: ComposedWorkflow, issues: ValidationIssue[]): void {
  const instanceIds = new Set(composition.blocks.map(b => b.instanceId));

  for (const conn of composition.connections) {
    if (!instanceIds.has(conn.fromInstanceId)) {
      issues.push({
        code: 'ORPHAN_CONNECTION_FROM',
        severity: 'error',
        message: `Connection references non-existent source node: ${conn.fromInstanceId}`,
        autoFixable: true,
        fix: 'Remove orphaned connection'
      });
    }
    if (!instanceIds.has(conn.toInstanceId)) {
      issues.push({
        code: 'ORPHAN_CONNECTION_TO',
        severity: 'error',
        message: `Connection references non-existent target node: ${conn.toInstanceId}`,
        autoFixable: true,
        fix: 'Remove orphaned connection'
      });
    }
  }

  for (const block of composition.blocks) {
    const hasIncoming = block.instanceId === 'trigger_0' ||
      composition.connections.some(c => c.toInstanceId === block.instanceId);

    if (!hasIncoming && block.instanceId !== 'trigger_0') {
      issues.push({
        code: 'DISCONNECTED_NODE',
        severity: 'warning',
        message: `Node "${block.block.name}" has no incoming connections and is not the trigger.`,
        nodeId: block.instanceId,
        nodeName: block.block.name,
        autoFixable: false,
        fix: 'Connect this node to the workflow or remove it'
      });
    }
  }
}

function checkDuplicateSingletons(plan: AutomationPlan, issues: ValidationIssue[]): void {
  const blockIdCounts: Record<string, number> = {};
  const allBlockIds = [plan.trigger.blockId, ...plan.steps.map(s => s.blockId)];

  for (const id of allBlockIds) {
    blockIdCounts[id] = (blockIdCounts[id] || 0) + 1;
  }

  for (const [blockId, count] of Object.entries(blockIdCounts)) {
    const block = BLOCKS[blockId];
    if (block?.singleton && count > 1) {
      issues.push({
        code: 'DUPLICATE_SINGLETON',
        severity: 'error',
        message: `"${block.name}" can only appear once per workflow but appears ${count} times.`,
        nodeId: blockId,
        nodeName: block.name,
        autoFixable: true,
        fix: `Remove duplicate "${block.name}" nodes`
      });
    }
  }
}

function collectCredentialRequirements(plan: AutomationPlan): CredentialRequirement[] {
  const allBlockIds = [plan.trigger.blockId, ...plan.steps.map(s => s.blockId)];
  const seen = new Set<string>();
  const requirements: CredentialRequirement[] = [];

  for (const blockId of allBlockIds) {
    const block = BLOCKS[blockId];
    if (!block) continue;

    for (const dep of block.dependencies) {
      if (!seen.has(dep.service)) {
        seen.add(dep.service);
        requirements.push({
          service: dep.service,
          n8nCredentialType: CREDENTIAL_TYPE_MAP[dep.service] ?? dep.service,
          description: dep.description,
          setupUrl: dep.setupUrl,
          nodeNames: [block.name]
        });
      } else {
        const existing = requirements.find(r => r.service === dep.service);
        if (existing && !existing.nodeNames.includes(block.name)) {
          existing.nodeNames.push(block.name);
        }
      }
    }
  }

  return requirements;
}

function checkN8nWorkflowStructure(n8nJson: N8nWorkflow, issues: ValidationIssue[]): void {
  if (!n8nJson.nodes || n8nJson.nodes.length === 0) {
    issues.push({
      code: 'EMPTY_N8N_WORKFLOW',
      severity: 'error',
      message: 'The generated n8n workflow JSON has no nodes.',
      autoFixable: false
    });
    return;
  }

  for (const node of n8nJson.nodes) {
    if (!node.type) {
      issues.push({
        code: 'NODE_MISSING_TYPE',
        severity: 'error',
        message: `Node "${node.name}" has no type defined.`,
        nodeId: node.id,
        nodeName: node.name,
        autoFixable: false
      });
    }

    // Detect any leftover fake credential IDs embedded in nodes
    if (node.credentials) {
      for (const [credKey, credVal] of Object.entries(node.credentials as Record<string, unknown>)) {
        const val = credVal as { id?: string; name?: string };
        if (val?.id && /^cred_/.test(val.id)) {
          issues.push({
            code: 'FAKE_CREDENTIAL_ID',
            severity: 'error',
            message: `Node "${node.name}" has a fake credential ID "${val.id}" embedded. Remove it — credentials must be linked in n8n manually.`,
            nodeId: node.id,
            nodeName: node.name,
            autoFixable: false,
            fix: 'Remove credentials field from this node and link credentials in n8n UI'
          });
        }
      }
    }

    if (!node.position || node.position.length !== 2) {
      issues.push({
        code: 'NODE_MISSING_POSITION',
        severity: 'warning',
        message: `Node "${node.name}" has no valid position.`,
        nodeId: node.id,
        nodeName: node.name,
        autoFixable: true,
        fix: 'Position will be auto-assigned'
      });
    }
  }
}

function checkWorkflowComplexity(plan: AutomationPlan, issues: ValidationIssue[]): void {
  if (plan.estimatedNodes > 12) {
    issues.push({
      code: 'HIGH_COMPLEXITY',
      severity: 'info',
      message: `Workflow has ${plan.estimatedNodes} nodes — consider splitting into sub-workflows for maintainability.`,
      autoFixable: false
    });
  }

  if (plan.steps.filter(s => s.blockId === 'wait_delay').length > 3) {
    issues.push({
      code: 'MANY_DELAYS',
      severity: 'info',
      message: 'Multiple delay nodes detected. Ensure your n8n instance is configured for persistent execution.',
      autoFixable: false
    });
  }
}

function checkRequiredParams(plan: AutomationPlan, issues: ValidationIssue[]): void {
  const allBlockIds = [plan.trigger.blockId, ...plan.steps.map(s => s.blockId)];

  for (const blockId of allBlockIds) {
    const block = BLOCKS[blockId];
    if (!block) continue;

    for (const param of block.params) {
      if (param.required && !param.defaultValue && !param.envVar) {
        issues.push({
          code: 'MISSING_REQUIRED_PARAM',
          severity: 'warning',
          message: `"${block.name}" requires "${param.label}" but has no default or environment variable.`,
          nodeId: blockId,
          nodeName: block.name,
          autoFixable: false,
          fix: `Set ${param.label} in your .env file or n8n credentials`
        });
      }
    }
  }
}

// ─── RUNTIME COMPATIBILITY CHECK ─────────────────────────────────────────────

function checkRuntimeCompatibility(n8nJson: N8nWorkflow): {
  importable: boolean;
  runtimeCompatible: boolean;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];

  // Check required top-level fields for n8n import
  if (!n8nJson.name) {
    issues.push({ code: 'MISSING_WORKFLOW_NAME', severity: 'error', message: 'Workflow has no name.', autoFixable: false });
  }
  if (typeof n8nJson.active !== 'boolean') {
    issues.push({ code: 'MISSING_ACTIVE_FLAG', severity: 'error', message: 'Workflow missing required "active" boolean field.', autoFixable: false });
  }
  if (!n8nJson.settings?.executionOrder) {
    issues.push({ code: 'MISSING_EXECUTION_ORDER', severity: 'warning', message: 'Workflow missing settings.executionOrder — n8n may default to legacy mode.', autoFixable: false });
  }

  // Verify nodes array is valid
  const nodeNames = new Set<string>();
  for (const node of (n8nJson.nodes || [])) {
    if (nodeNames.has(node.name)) {
      issues.push({
        code: 'DUPLICATE_NODE_NAME',
        severity: 'error',
        message: `Two nodes share the name "${node.name}". n8n uses node names as connection keys — duplicates will break routing.`,
        nodeName: node.name,
        autoFixable: false
      });
    }
    nodeNames.add(node.name);

    // Phase 9.4.3 Step E: this validator's own capability truth previously
    // came only from checkUnsupportedBlocks() -- "is this blockId
    // registered in lib/blocks" -- a structural check that says nothing
    // about whether the certified runtime can actually execute it. lib/blocks
    // legitimately still defines blocks (approval_node -> wait+resume:
    // 'webhook', google_sheets_append, hubspot_create_contact, twilio_sms)
    // that lib/workflow-runtime/node-capabilities.ts explicitly blocks --
    // upstream, lib/planner's assertNodesAreCapable() already prevents fresh
    // generation from ever emitting one, but this scorer must not
    // independently disagree and call a blocked node "deployment ready" if
    // it's ever reached some other way (a saved/edited plan re-validated,
    // a future call site). Same authoritative source, checked directly.
    const capability = checkNodeCapability({ type: node.type, parameters: node.parameters });
    if (!capability.capable) {
      issues.push({
        code: 'CAPABILITY_UNAVAILABLE',
        severity: 'error',
        message: capability.userMessage,
        nodeName: node.name,
        autoFixable: false,
      });
    }
  }

  // Verify connections reference existing node names
  const connectionKeys = Object.keys(n8nJson.connections || {});
  for (const fromName of connectionKeys) {
    if (!nodeNames.has(fromName)) {
      issues.push({
        code: 'DANGLING_CONNECTION_KEY',
        severity: 'error',
        message: `Connections map references node name "${fromName}" which does not exist in nodes array. Workflow will fail to import cleanly.`,
        autoFixable: false
      });
    }
    const mainArr = n8nJson.connections[fromName]?.main ?? [];
    for (const portArr of mainArr) {
      for (const conn of (portArr || [])) {
        if (!nodeNames.has(conn.node)) {
          issues.push({
            code: 'DANGLING_CONNECTION_TARGET',
            severity: 'error',
            message: `Connection from "${fromName}" points to "${conn.node}" which does not exist.`,
            autoFixable: false
          });
        }
      }
    }
  }

  const hasErrors = issues.some(i => i.severity === 'error');
  return {
    importable: !hasErrors,
    runtimeCompatible: !hasErrors && issues.filter(i => i.severity === 'warning').length === 0,
    issues
  };
}

// ─── SCORING ─────────────────────────────────────────────────────────────────

function computeDeploymentScore(issues: ValidationIssue[], plan: AutomationPlan): number {
  let score = 100;

  for (const issue of issues) {
    if (issue.severity === 'error') score -= 25;
    else if (issue.severity === 'warning') score -= 8;
    else if (issue.severity === 'info') score -= 2;
  }

  if (plan.steps.length >= 2 && plan.steps.length <= 8) score += 5;
  if (plan.integrations.length > 0) score += 3;

  return Math.max(0, Math.min(100, score));
}

function computeSetupTime(plan: AutomationPlan, credCount: number): string {
  const baseMinutes = plan.estimatedNodes * 5;
  const credMinutes = credCount * 15;
  const total = baseMinutes + credMinutes;
  if (total < 30) return `~${total} minutes`;
  if (total < 60) return '~30-45 minutes';
  if (total < 120) return '~1 hour';
  return `~${Math.ceil(total / 60)} hours`;
}

function generateSummary(score: number, errors: number, warnings: number, credCount: number): string {
  if (errors > 0) return `${errors} error${errors > 1 ? 's' : ''} must be fixed before deployment.`;
  if (credCount > 0 && score >= 80) return `Ready to deploy as draft. ${credCount} credential${credCount > 1 ? 's' : ''} must be connected before activation.`;
  if (score >= 90) return 'Workflow is ready to deploy. All checks passed.';
  if (score >= 80) return `Workflow is deployable with ${warnings} warning${warnings > 1 ? 's' : ''}. Configure credentials before activating.`;
  return `Workflow needs attention — score ${score}/100. Resolve issues before deploying.`;
}

// ─── MAIN VALIDATOR ──────────────────────────────────────────────────────────

export function validateWorkflow(
  plan: AutomationPlan,
  composition: ComposedWorkflow,
  n8nJson: N8nWorkflow
): ValidationResult {
  const structuralIssues: ValidationIssue[] = [];

  checkHasTrigger(plan, structuralIssues);
  checkHasActions(plan, structuralIssues);
  checkUnsupportedBlocks(plan, structuralIssues);
  checkConnections(composition, structuralIssues);
  checkDuplicateSingletons(plan, structuralIssues);
  checkRequiredParams(plan, structuralIssues);
  checkWorkflowComplexity(plan, structuralIssues);
  checkN8nWorkflowStructure(n8nJson, structuralIssues);

  const runtimeCheck = checkRuntimeCompatibility(n8nJson);
  const allIssues = [...structuralIssues, ...runtimeCheck.issues];

  const credentialsRequired = collectCredentialRequirements(plan);

  const errors = allIssues.filter(i => i.severity === 'error');
  const warnings = allIssues.filter(i => i.severity === 'warning');
  const infos = allIssues.filter(i => i.severity === 'info');

  const score = computeDeploymentScore(allIssues, plan);
  const valid = errors.length === 0;
  const deploymentReady = valid && score >= 80;

  // Activation requires all credentials to be connected — always blocked
  // until that manual step. Phase 9.4.3: corrected from "linked in n8n" --
  // activation is the certified native runtime
  // (/api/workflows/[id]/lifecycle), not n8n.
  const activationBlocked = credentialsRequired.length > 0;
  const activationBlockReason = activationBlocked
    ? `${credentialsRequired.length} credential${credentialsRequired.length > 1 ? 's' : ''} must be connected before this workflow can be activated: ${credentialsRequired.map(c => c.service).join(', ')}`
    : '';

  const estimatedSetupTime = computeSetupTime(plan, credentialsRequired.length);
  const summary = generateSummary(score, errors.length, warnings.length, credentialsRequired.length);

  return {
    valid,
    score,
    runtimeCompatible: runtimeCheck.runtimeCompatible,
    importable: runtimeCheck.importable,
    issues: allIssues,
    errors,
    warnings,
    infos,
    summary,
    deploymentReady,
    credentialsRequired,
    credentialsMissing: credentialsRequired.map(c => c.service),
    estimatedSetupTime,
    activationBlocked,
    activationBlockReason
  };
}

export function autoRepair(
  plan: AutomationPlan,
  validation: ValidationResult
): { repairedPlan: AutomationPlan; appliedFixes: string[] } {
  const appliedFixes: string[] = [];
  let repairedPlan = { ...plan };

  for (const issue of validation.issues.filter(i => i.autoFixable)) {
    if (issue.code === 'DUPLICATE_SINGLETON') {
      const seen = new Set<string>();
      repairedPlan.steps = repairedPlan.steps.filter(s => {
        if (seen.has(s.blockId)) return false;
        seen.add(s.blockId);
        return true;
      });
      appliedFixes.push(`Removed duplicate ${issue.nodeName} nodes`);
    }
  }

  return { repairedPlan, appliedFixes };
}
