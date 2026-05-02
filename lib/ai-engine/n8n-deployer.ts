export interface N8nConfig {
  apiUrl: string;
  apiKey: string;
}

export interface WorkflowDeployPayload {
  name: string;
  nodes: object[];
  connections: object;
  settings?: object;
  active?: boolean;
}

export interface N8nCredentialPayload {
  name: string;
  type: string;
  data: Record<string, unknown>;
}

export interface N8nCredentialResult {
  id: string;
  name: string;
  type: string;
}

export interface TestRunResult {
  executionId: string;
  status: 'success' | 'failed' | 'timeout' | 'skipped';
  message: string;
  nodeStatuses?: Record<string, 'success' | 'failed'>;
  startedAt?: string;
  stoppedAt?: string;
}

export interface DeployResult {
  workflowId: string;
  workflowUrl: string;
  /** 'draft' = created inactive, waiting for credential linking before activation */
  status: 'draft' | 'active' | 'error';
  error?: string;
}

export interface N8nExecution {
  id: string;
  workflowId: string;
  finished: boolean;
  mode: string;
  startedAt: string;
  stoppedAt?: string;
  status: 'running' | 'success' | 'failed' | 'waiting';
}

export interface N8nWorkflowStatus {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  executionCount?: number;
}

function n8nHeaders(config: N8nConfig): Record<string, string> {
  return {
    'X-N8N-API-KEY': config.apiKey,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

function n8nUrl(config: N8nConfig, path: string): string {
  const base = config.apiUrl.replace(/\/$/, '');
  return `${base}/api/v1${path}`;
}

async function n8nFetch<T>(
  config: N8nConfig,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(n8nUrl(config, path), {
    ...options,
    headers: {
      ...n8nHeaders(config),
      ...(options.headers as Record<string, string> || {})
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`n8n API error ${res.status}: ${text || res.statusText}`);
  }

  return res.json() as Promise<T>;
}

export async function createWorkflow(
  config: N8nConfig,
  payload: WorkflowDeployPayload
): Promise<DeployResult> {
  try {
    const data = await n8nFetch<{ id: string; name: string }>(config, '/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: payload.name,
        nodes: payload.nodes,
        connections: payload.connections,
        settings: payload.settings || { executionOrder: 'v1' },
        active: false
      })
    });

    const workflowUrl = `${config.apiUrl.replace(/\/$/, '')}/workflow/${data.id}`;

    return {
      workflowId: data.id,
      workflowUrl,
      status: 'draft'
    };
  } catch (err) {
    return {
      workflowId: '',
      workflowUrl: '',
      status: 'error',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function deployWorkflow(
  config: N8nConfig,
  workflowId: string
): Promise<void> {
  // n8n workflows are deployed when created; this activates webhook registration
  await n8nFetch(config, `/workflows/${workflowId}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: false })
  });
}

export async function activateWorkflow(
  config: N8nConfig,
  workflowId: string
): Promise<void> {
  await n8nFetch(config, `/workflows/${workflowId}/activate`, {
    method: 'POST'
  });
}

export async function deactivateWorkflow(
  config: N8nConfig,
  workflowId: string
): Promise<void> {
  await n8nFetch(config, `/workflows/${workflowId}/deactivate`, {
    method: 'POST'
  });
}

export async function getWorkflowStatus(
  config: N8nConfig,
  workflowId: string
): Promise<N8nWorkflowStatus> {
  return n8nFetch<N8nWorkflowStatus>(config, `/workflows/${workflowId}`);
}

export async function listWorkflows(
  config: N8nConfig
): Promise<N8nWorkflowStatus[]> {
  const data = await n8nFetch<{ data: N8nWorkflowStatus[] }>(config, '/workflows?limit=100');
  return data.data || [];
}

export async function deleteWorkflow(
  config: N8nConfig,
  workflowId: string
): Promise<void> {
  await n8nFetch(config, `/workflows/${workflowId}`, { method: 'DELETE' });
}

export async function listExecutions(
  config: N8nConfig,
  workflowId: string,
  limit = 20
): Promise<N8nExecution[]> {
  const data = await n8nFetch<{ data: N8nExecution[] }>(
    config,
    `/executions?workflowId=${workflowId}&limit=${limit}`
  );
  return data.data || [];
}

export async function getExecution(
  config: N8nConfig,
  executionId: string
): Promise<N8nExecution> {
  return n8nFetch<N8nExecution>(config, `/executions/${executionId}`);
}

/** Create a credential in n8n via the credentials API. Returns the credential ID. */
export async function createCredential(
  config: N8nConfig,
  payload: N8nCredentialPayload
): Promise<N8nCredentialResult> {
  return n8nFetch<N8nCredentialResult>(config, '/credentials', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

/**
 * Patch workflow nodes to inject real credential IDs.
 * credentialMap: { n8nCredentialType → { id, name } }
 */
export async function patchWorkflowCredentials(
  config: N8nConfig,
  workflowId: string,
  credentialMap: Record<string, { id: string; name: string }>
): Promise<void> {
  const workflow = await n8nFetch<{ id: string; name: string; nodes: Array<Record<string, unknown>>; connections: unknown; settings: unknown }>(
    config, `/workflows/${workflowId}`
  );

  const updatedNodes = workflow.nodes.map(node => {
    // Determine which credential type this node needs based on its type
    const credType = NODE_TYPE_TO_CREDENTIAL[node.type as string];
    if (!credType || !credentialMap[credType]) return node;
    return {
      ...node,
      credentials: {
        [credType]: {
          id: credentialMap[credType].id,
          name: credentialMap[credType].name
        }
      }
    };
  });

  await n8nFetch(config, `/workflows/${workflowId}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...workflow,
      nodes: updatedNodes
    })
  });
}

/**
 * Maps n8n node types to their credential type name.
 * Used to inject credentials into the right nodes after provisioning.
 */
export const NODE_TYPE_TO_CREDENTIAL: Record<string, string> = {
  'n8n-nodes-base.shopifyTrigger': 'shopifyApi',
  'n8n-nodes-base.shopify':        'shopifyApi',
  'n8n-nodes-base.slack':          'slackApi',
  'n8n-nodes-base.emailSend':      'smtp',
  'n8n-nodes-base.airtable':       'airtableTokenApi',
  'n8n-nodes-base.googleSheets':   'googleSheetsOAuth2Api',
  'n8n-nodes-base.hubspot':        'hubspotApi',
  'n8n-nodes-base.twilio':         'twilioApi',
};

/**
 * Trigger a manual test execution of a workflow.
 * For webhook-triggered workflows, this simulates the trigger with a sample payload.
 * Returns the execution result after polling for completion (up to 30s).
 */
export async function runTestExecution(
  config: N8nConfig,
  workflowId: string,
  triggerNodeName?: string
): Promise<TestRunResult> {
  try {
    // Trigger manual execution
    const exec = await n8nFetch<{ id: string }>(config, `/workflows/${workflowId}/run`, {
      method: 'POST',
      body: JSON.stringify({
        startNodes: triggerNodeName ? [triggerNodeName] : undefined,
        destinationNode: undefined
      })
    });

    const executionId = exec.id;
    if (!executionId) {
      return { executionId: '', status: 'failed', message: 'No execution ID returned from n8n' };
    }

    // Poll for completion (max 30s, 3s intervals)
    const maxAttempts = 10;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const result = await n8nFetch<{
          id: string;
          finished: boolean;
          status: string;
          startedAt: string;
          stoppedAt?: string;
          data?: { resultData?: { runData?: Record<string, Array<{ error?: unknown }>> } };
        }>(config, `/executions/${executionId}`);

        if (result.finished) {
          const nodeStatuses: Record<string, 'success' | 'failed'> = {};
          const runData = result.data?.resultData?.runData ?? {};
          for (const [nodeName, runs] of Object.entries(runData)) {
            nodeStatuses[nodeName] = runs.some(r => r.error) ? 'failed' : 'success';
          }

          const hasFailed = Object.values(nodeStatuses).some(s => s === 'failed');
          return {
            executionId,
            status: hasFailed ? 'failed' : 'success',
            message: hasFailed
              ? `Execution completed with node errors. Check n8n for details.`
              : 'Test execution completed successfully.',
            nodeStatuses,
            startedAt: result.startedAt,
            stoppedAt: result.stoppedAt
          };
        }
      } catch {
        // Execution not yet available — keep polling
      }
    }

    return {
      executionId,
      status: 'timeout',
      message: 'Test execution is still running after 30 seconds. Check n8n for results.'
    };
  } catch (err) {
    return {
      executionId: '',
      status: 'failed',
      message: err instanceof Error ? err.message : 'Test execution failed'
    };
  }
}

/**
 * Fetch the resume/approval URL for a Wait node in an active workflow.
 * n8n exposes this as a webhook URL visible in the workflow data after activation.
 */
export async function fetchApprovalWebhookUrl(
  config: N8nConfig,
  workflowId: string
): Promise<string | null> {
  try {
    const workflow = await n8nFetch<{
      nodes: Array<{ type: string; webhookId?: string; parameters?: Record<string, unknown> }>
    }>(config, `/workflows/${workflowId}`);

    const waitNode = workflow.nodes.find(n =>
      n.type === 'n8n-nodes-base.wait' &&
      (n.parameters?.resume === 'webhook')
    );

    if (!waitNode?.webhookId) return null;

    const base = config.apiUrl.replace(/\/$/, '');
    return `${base}/webhook/${waitNode.webhookId}/approval`;
  } catch {
    return null;
  }
}

/**
 * Patch the Slack/email notification node to include the approval URL in the message text.
 * Called after activation when approval URL is available.
 */
export async function injectApprovalUrlIntoNotifications(
  config: N8nConfig,
  workflowId: string,
  approvalUrl: string
): Promise<boolean> {
  try {
    const workflow = await n8nFetch<{
      id: string; name: string;
      nodes: Array<Record<string, unknown>>;
      connections: unknown; settings: unknown;
    }>(config, `/workflows/${workflowId}`);

    let patched = false;
    const updatedNodes = workflow.nodes.map(node => {
      const params = node.parameters as Record<string, unknown> | undefined;
      if (!params) return node;

      // Inject into Slack message text
      if (node.type === 'n8n-nodes-base.slack' && typeof params.text === 'string') {
        patched = true;
        return { ...node, parameters: { ...params, text: `${params.text}\n\nApproval URL: ${approvalUrl}` } };
      }
      // Inject into email body
      if (node.type === 'n8n-nodes-base.emailSend' && typeof params.message === 'string') {
        patched = true;
        return { ...node, parameters: { ...params, message: `${params.message}<br><br><strong>Approval URL:</strong> <a href="${approvalUrl}">${approvalUrl}</a>` } };
      }
      return node;
    });

    if (!patched) return false;

    await n8nFetch(config, `/workflows/${workflowId}`, {
      method: 'PUT',
      body: JSON.stringify({ ...workflow, nodes: updatedNodes })
    });
    return true;
  } catch {
    return false;
  }
}

export function isN8nConfigured(): boolean {
  return !!(
    process.env.N8N_API_URL &&
    process.env.N8N_API_KEY
  );
}

export function getN8nConfig(): N8nConfig | null {
  if (!isN8nConfigured()) return null;
  return {
    apiUrl: process.env.N8N_API_URL!,
    apiKey: process.env.N8N_API_KEY!
  };
}
