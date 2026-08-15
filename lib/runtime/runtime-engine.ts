import 'server-only';

import { runWorkflowExecution } from '@/lib/workflow-runtime/engine';
import { assertTrustedUserId } from '@/lib/credentials/storage';
import { validateWorkflowCredentials } from '@/lib/credentials/validation';
import { getNodeDef, validateNodeConfig } from '@/lib/node-registry';
import type { RunExecutionOptions } from '@/lib/workflow-runtime/types';
import type { RuntimeExecutionResult } from './runtime-result';

// ─── Required-credential extractor ───────────────────────────────────────────
// Reads the workflow JSON and returns the set of credential providers needed
// based on node types and the provider-registry mapping.

function extractRequiredProviders(workflowJson: unknown): string[] {
  if (!workflowJson || typeof workflowJson !== 'object') return [];
  const wf = workflowJson as Record<string, unknown>;
  const nodes = Array.isArray(wf.nodes) ? (wf.nodes as unknown[]) : [];

  // Node type → provider mapping (mirrors node-registry credentialProvider fields)
  const TYPE_TO_PROVIDER: Record<string, string> = {
    'n8n-nodes-base.openai':      'openai',
    'n8n-nodes-base.openAi':      'openai',
    'n8n-nodes-base.slack':       'slack',
    'n8n-nodes-base.slacktrigger':'slack',
    'n8n-nodes-base.airtable':    'airtable',
    'n8n-nodes-base.airtabletrigger': 'airtable',
    'n8n-nodes-base.emailsend':   'gmail',
    'n8n-nodes-base.emailSend':   'gmail',
    'n8n-nodes-base.gmail':       'gmail',
    'n8n-nodes-base.gmailtrigger':'gmail',
    'n8n-nodes-base.shopify':     'shopify',
    'n8n-nodes-base.shopifytrigger': 'shopify',
  };

  const providers = new Set<string>();
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const type = String((node as Record<string, unknown>).type ?? '');
    const provider = TYPE_TO_PROVIDER[type] ?? TYPE_TO_PROVIDER[type.toLowerCase()];
    if (provider) providers.add(provider);
  }
  return [...providers];
}

// ─── Required-parameter pre-flight ────────────────────────────────────────────
// Re-checks each node's required fields server-side. The settings panel already
// blocks saving a node with missing required fields, but that is a client-side
// UI guard only — a workflow can still reach the runtime with incomplete
// parameters (e.g. an older saved workflow, a direct API call). This mirrors
// the credential pre-flight below: block before any node executes rather than
// failing partway through a live run.

function extractMissingParameters(
  workflowJson: unknown,
): Array<{ nodeId: string; nodeName: string; field: string; message: string }> {
  if (!workflowJson || typeof workflowJson !== 'object') return [];
  const wf = workflowJson as Record<string, unknown>;
  const nodes = Array.isArray(wf.nodes) ? (wf.nodes as unknown[]) : [];

  const missing: Array<{ nodeId: string; nodeName: string; field: string; message: string }> = [];

  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const n = node as Record<string, unknown>;
    const type = String(n.type ?? '');
    const def = getNodeDef(type);
    if (!def) continue; // unregistered node type — nothing to validate against

    const parameters = (n.parameters ?? {}) as Record<string, unknown>;
    const errors = validateNodeConfig(parameters, def.fields);
    for (const err of errors) {
      missing.push({
        nodeId: String(n.id ?? n.name ?? type),
        nodeName: String(n.name ?? type),
        field: err.key,
        message: err.message,
      });
    }
  }

  return missing;
}

// ─── Production runtime facade ────────────────────────────────────────────────
// Validates credentials before delegating to the core execution engine.
// DOES NOT modify the core engine, validator, or existing execution logic.

export async function executeWorkflowForUser(
  opts: RunExecutionOptions,
): Promise<RuntimeExecutionResult> {
  assertTrustedUserId(opts.userId);

  // Pre-flight: validate all required node parameters are present
  const missingParameters = extractMissingParameters(opts.workflowJson);
  if (missingParameters.length > 0) {
    return {
      executionId: `preflight-${Date.now()}`,
      status: 'failed',
      currentNodeId: null,
      steps: [],
      finalOutput: null,
      error: `Missing required parameters: ${missingParameters
        .map((m) => `${m.nodeName}.${m.field}`)
        .join(', ')}`,
      simulated: false,
      previews: { emails: [], slackMessages: [], airtableRecords: [] },
      parameterError: true,
      missingParameters,
    };
  }

  // Pre-flight: validate all required credentials are connected
  const requiredProviders = extractRequiredProviders(opts.workflowJson);
  if (requiredProviders.length > 0) {
    const validations = await validateWorkflowCredentials(requiredProviders, opts.userId);
    const missing = validations.filter((v) => !v.connected).map((v) => v.provider);

    if (missing.length > 0) {
      // Return a failed EngineResult rather than throwing — keeps caller code simple
      return {
        executionId: `preflight-${Date.now()}`,
        status: 'failed',
        currentNodeId: null,
        steps: [],
        finalOutput: null,
        error: `Missing credentials for: ${missing.join(', ')}. Connect them in Settings → Credentials.`,
        simulated: false,
        previews: { emails: [], slackMessages: [], airtableRecords: [] },
        credentialError: true,
        missingCredentialProviders: missing,
      };
    }
  }

  // Delegate to the existing, unmodified execution engine
  const result = await runWorkflowExecution(opts);
  return result;
}

// ─── Test-mode shortcut ───────────────────────────────────────────────────────
// Skips credential pre-flight entirely (test mode simulates all nodes).

export async function testWorkflowExecution(
  opts: RunExecutionOptions,
): Promise<RuntimeExecutionResult> {
  assertTrustedUserId(opts.userId);
  return runWorkflowExecution({ ...opts, mode: 'test' });
}
