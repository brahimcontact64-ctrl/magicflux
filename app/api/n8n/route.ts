import { NextRequest, NextResponse } from 'next/server';
import {
  createWorkflow, activateWorkflow,
  deactivateWorkflow, getWorkflowStatus,
  listExecutions, getN8nConfig
} from '@/lib/ai-engine/n8n-deployer';
import { classifyError } from '@/lib/security/safe-error';
import {
  createServiceClient,
  getUserFromRequest,
} from '@/lib/supabase-server';
import {
  injectCredentialsIntoWorkflow,
  requiredProvidersFromWorkflow,
  type IntegrationProvider,
} from '@/lib/integrations';
import { decryptIntegrationCredentials } from '@/lib/security/encryption';

// Verifies that an n8n workflow ID belongs to the authenticated user.
// Queries workflows.n8n_workflow_id + workflows.user_id — the only source of truth
// for the n8nWorkflowId ↔ tenant binding.
async function verifyN8nWorkflowOwnership(
  userId: string,
  n8nWorkflowId: string
): Promise<boolean> {
  if (!n8nWorkflowId || typeof n8nWorkflowId !== 'string') return false;
  const db = createServiceClient();
  const { data } = await db
    .from('workflows')
    .select('id')
    .eq('n8n_workflow_id', n8nWorkflowId)
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  return data !== null;
}

export async function GET(req: NextRequest) {
  // Authentication required — no public GET endpoints on this route.
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const workflowId = searchParams.get('workflowId');
  const action = searchParams.get('action');

  const config = getN8nConfig();
  if (!config) {
    return NextResponse.json({
      configured: false,
      message: 'n8n integration not configured. Set N8N_API_URL and N8N_API_KEY environment variables.',
    });
  }

  const db = createServiceClient();

  try {
    if (action === 'list') {
      // Never call listWorkflows(config) — that returns every tenant's workflows.
      // Return only this user's workflows that have been deployed to n8n.
      const { data: userWorkflows, error } = await db
        .from('workflows')
        .select('id, name, n8n_workflow_id, status, deployed_at, updated_at')
        .eq('user_id', user.id)
        .not('n8n_workflow_id', 'is', null)
        .order('updated_at', { ascending: false });

      if (error) return NextResponse.json({ error: 'Failed to load workflows' }, { status: 500 });
      return NextResponse.json({ configured: true, workflows: userWorkflows ?? [] });
    }

    if (action === 'status' && workflowId) {
      const owned = await verifyN8nWorkflowOwnership(user.id, workflowId);
      if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const status = await getWorkflowStatus(config, workflowId);
      return NextResponse.json({ configured: true, status });
    }

    if (action === 'executions' && workflowId) {
      const owned = await verifyN8nWorkflowOwnership(user.id, workflowId);
      if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const limitRaw = parseInt(searchParams.get('limit') ?? '20', 10);
      const limit = Math.min(100, Math.max(1, isNaN(limitRaw) ? 20 : limitRaw));
      const executions = await listExecutions(config, workflowId, limit);
      return NextResponse.json({ configured: true, executions });
    }

    return NextResponse.json({ configured: true, message: 'n8n integration is configured and connected.' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Authentication required — must be verified before any action is dispatched.
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { action, workflowId, workflow, payload } = body as {
    action: 'create' | 'activate' | 'deactivate';
    workflowId?: string;
    workflow?: { name: string; nodes: object[]; connections: object; settings?: object };
    payload?: { name: string; nodes: object[]; connections: object; settings?: object };
  };

  const config = getN8nConfig();
  if (!config) {
    return NextResponse.json(
      { error: 'n8n not configured', docs: 'Set N8N_API_URL and N8N_API_KEY environment variables.', result: null },
      { status: 503 }
    );
  }

  const wf = workflow || payload;

  try {
    if (action === 'create') {
      if (!wf?.name || !wf?.nodes || !wf?.connections) {
        return NextResponse.json({ error: 'workflow.name, nodes, and connections required' }, { status: 400 });
      }

      const db = createServiceClient();
      const { data: integrationRows, error: integrationsError } = await db
        .from('user_integrations')
        .select('provider, credentials')
        .eq('user_id', user.id)
        .eq('status', 'connected');

      if (integrationsError) {
        const safe = classifyError(integrationsError); return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
      }

      const requiredProviders = requiredProvidersFromWorkflow(wf);
      const connectedProviders = new Set(
        (integrationRows ?? []).map(row => row.provider as IntegrationProvider)
      );
      const missingIntegrations = requiredProviders.filter(provider => !connectedProviders.has(provider));

      if (missingIntegrations.length > 0) {
        return NextResponse.json(
          { error: `Missing required integrations: ${missingIntegrations.join(', ')}`, missingIntegrations },
          { status: 422 }
        );
      }

      const preparedWorkflow = injectCredentialsIntoWorkflow(
        wf,
        (integrationRows ?? []).map(row => ({
          provider: row.provider as IntegrationProvider,
          credentials: decryptIntegrationCredentials(row.credentials as Record<string, unknown>),
        }))
      ) as { name: string; nodes: object[]; connections: object; settings?: object };

      const result = await createWorkflow(config, {
        name: preparedWorkflow.name,
        nodes: preparedWorkflow.nodes,
        connections: preparedWorkflow.connections,
        settings: preparedWorkflow.settings,
      });
      return NextResponse.json({
        success: true,
        result,
        deployedAsDraft: true,
        message: result.status === 'draft'
          ? 'Workflow created as inactive draft. Link credentials in n8n, then activate.'
          : result.error,
      });
    }

    if (action === 'activate') {
      if (!workflowId) return NextResponse.json({ error: 'workflowId required' }, { status: 400 });

      // Ownership verified against DB — the body's workflowId is never trusted directly.
      const owned = await verifyN8nWorkflowOwnership(user.id, workflowId);
      if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      await activateWorkflow(config, workflowId);
      return NextResponse.json({ success: true, result: { message: `Workflow ${workflowId} activated` } });
    }

    if (action === 'deactivate') {
      if (!workflowId) return NextResponse.json({ error: 'workflowId required' }, { status: 400 });

      // Ownership verified against DB — the body's workflowId is never trusted directly.
      const owned = await verifyN8nWorkflowOwnership(user.id, workflowId);
      if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      await deactivateWorkflow(config, workflowId);
      return NextResponse.json({ success: true, result: { message: `Workflow ${workflowId} deactivated` } });
    }

    return NextResponse.json({ error: 'Unknown action. Use: create | activate | deactivate' }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, result: null }, { status: 500 });
  }
}
