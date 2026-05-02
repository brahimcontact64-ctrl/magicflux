import { NextRequest, NextResponse } from 'next/server';
import {
  createWorkflow, activateWorkflow,
  deactivateWorkflow, getWorkflowStatus, listWorkflows,
  listExecutions, getN8nConfig
} from '@/lib/ai-engine/n8n-deployer';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const workflowId = searchParams.get('workflowId');
  const action = searchParams.get('action');

  const config = getN8nConfig();

  if (!config) {
    return NextResponse.json({
      configured: false,
      message: 'n8n integration not configured. Set N8N_API_URL and N8N_API_KEY environment variables.'
    });
  }

  try {
    if (action === 'list') {
      const workflows = await listWorkflows(config);
      return NextResponse.json({ configured: true, workflows });
    }

    if (action === 'status' && workflowId) {
      const status = await getWorkflowStatus(config, workflowId);
      return NextResponse.json({ configured: true, status });
    }

    if (action === 'executions' && workflowId) {
      const limit = parseInt(searchParams.get('limit') || '20');
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
  const body = await req.json().catch(() => ({}));
  const { action, workflowId, workflow, payload, credentialsLinked } = body as {
    action: 'create' | 'activate' | 'deactivate';
    workflowId?: string;
    workflow?: { name: string; nodes: object[]; connections: object; settings?: object };
    payload?: { name: string; nodes: object[]; connections: object; settings?: object };
    /** Set to true only when the caller has confirmed credentials are linked in n8n */
    credentialsLinked?: boolean;
  };

  const config = getN8nConfig();
  if (!config) {
    return NextResponse.json(
      {
        error: 'n8n not configured',
        docs: 'Set N8N_API_URL and N8N_API_KEY environment variables.',
        result: null
      },
      { status: 503 }
    );
  }

  const wf = workflow || payload;

  try {
    if (action === 'create') {
      if (!wf?.name || !wf?.nodes || !wf?.connections) {
        return NextResponse.json({ error: 'workflow.name, nodes, and connections required' }, { status: 400 });
      }
      // Always created as inactive draft — credentials must be linked before activation
      const result = await createWorkflow(config, {
        name: wf.name,
        nodes: wf.nodes,
        connections: wf.connections,
        settings: wf.settings
      });
      return NextResponse.json({
        success: true,
        result,
        deployedAsDraft: true,
        message: result.status === 'draft'
          ? 'Workflow created as inactive draft. Link credentials in n8n, then activate.'
          : result.error
      });
    }

    if (action === 'activate') {
      if (!workflowId) return NextResponse.json({ error: 'workflowId required' }, { status: 400 });
      if (!credentialsLinked) {
        return NextResponse.json(
          {
            error: 'activation_blocked',
            message: 'Activation requires credentials to be linked in n8n first. Set credentialsLinked: true once done.'
          },
          { status: 422 }
        );
      }
      await activateWorkflow(config, workflowId);
      return NextResponse.json({ success: true, result: { message: `Workflow ${workflowId} activated` } });
    }

    if (action === 'deactivate') {
      if (!workflowId) return NextResponse.json({ error: 'workflowId required' }, { status: 400 });
      await deactivateWorkflow(config, workflowId);
      return NextResponse.json({ success: true, result: { message: `Workflow ${workflowId} deactivated` } });
    }

    return NextResponse.json({ error: 'Unknown action. Use: create | activate | deactivate' }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, result: null }, { status: 500 });
  }
}
