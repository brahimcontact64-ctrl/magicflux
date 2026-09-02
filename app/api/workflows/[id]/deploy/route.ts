import { NextRequest, NextResponse } from 'next/server';
import { classifyError } from '@/lib/security/safe-error';

import { createServiceClient, getUserFromRequest } from '@/lib/supabase-server';
import { getN8nConfig, createWorkflow, activateWorkflow, deactivateWorkflow } from '@/lib/ai-engine/n8n-deployer';
import { injectCredentialsIntoWorkflow } from '@/lib/integrations';
import { getWorkflowIntegrationStatus } from '@/lib/user-integrations';
import { getPlanLimits, canDeployWorkflow } from '@/lib/billing/plan-limits';
import { DeploymentHealthMonitor } from '@/deployment/health-monitor';

type Ctx = { params: { id: string } };

type WorkflowShape = {
  name?: string;
  nodes?: object[];
  connections?: object;
  settings?: object;
};

export async function POST(req: NextRequest, { params }: Ctx) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const { data: subscription, error: subscriptionError } = await db
    .from('subscriptions')
    .select('status')
    .eq('user_id', user.id)
    .maybeSingle();

  if (subscriptionError) {
    const safe = classifyError(subscriptionError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  if (subscription?.status !== 'active') {
    return NextResponse.json(
      { error: 'PRO_REQUIRED', redirect: '/pricing' },
      { status: 403 }
    );
  }

    // Check if plan allows deployment
    const deployCheck = await canDeployWorkflow(user.id);
    if (!deployCheck.allowed) {
      return NextResponse.json({
        error: 'PRO_REQUIRED',
        message: deployCheck.reason,
        redirect: '/pricing',
      }, { status: 403 });
    }

  const config = getN8nConfig();
  const healthMonitor = new DeploymentHealthMonitor();

  const { data: workflow, error: workflowError } = await db
    .from('workflows')
    .select('id, name, workflow_json')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (workflowError) {
    const safe = classifyError(workflowError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });

  const raw = (workflow.workflow_json ?? {}) as WorkflowShape;
  if (!raw.nodes || !raw.connections) {
    return NextResponse.json({ error: 'Workflow JSON is incomplete' }, { status: 400 });
  }

  const integrationStatus = await getWorkflowIntegrationStatus(user.id, raw);
  const missingIntegrations = integrationStatus.missing_integrations;
  const invalidIntegrations = integrationStatus.invalid_integrations;

  if (missingIntegrations.length > 0 || invalidIntegrations.length > 0) {
    const blocked = Array.from(new Set([...missingIntegrations, ...invalidIntegrations]));
    return NextResponse.json(
      {
        error: 'SETUP_REQUIRED',
        redirect: '/settings/integrations',
        missingIntegrations,
        invalidIntegrations,
        blockingMessage: `You must connect: ${blocked.join(', ')}`,
      },
      { status: 422 }
    );
  }

  const prepared = injectCredentialsIntoWorkflow(raw, integrationStatus.user_integrations) as WorkflowShape;

  let created: { workflowId?: string; workflowUrl?: string; status?: string; error?: string } = {};
  let deployedVia: 'n8n' | 'local' = 'local';

  if (config) {
    created = await createWorkflow(config, {
      name: prepared.name ?? workflow.name,
      nodes: (prepared.nodes ?? []) as object[],
      connections: (prepared.connections ?? {}) as object,
      settings: prepared.settings,
    });

    if (created.status === 'error' || !created.workflowId) {
      return NextResponse.json({ error: created.error ?? 'Failed to deploy workflow' }, { status: 500 });
    }

    await activateWorkflow(config, created.workflowId);

    const health = await healthMonitor.checkDeployment({
      userId: user.id,
      workflowId: params.id,
      n8n: config,
      n8nWorkflowId: created.workflowId,
    });

    if (!health.healthy) {
      await deactivateWorkflow(config, created.workflowId).catch(() => undefined);
      return NextResponse.json({
        error: 'DEPLOYMENT_HEALTH_GATE_FAILED',
        message: health.message,
      }, { status: 502 });
    }

    deployedVia = 'n8n';
  }

  const { data: updated, error: updateError } = await db
    .from('workflows')
    .update({
      status: 'deployed',
      n8n_workflow_id: deployedVia === 'n8n' ? created.workflowId ?? null : null,
      deployed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .eq('user_id', user.id)
    .select('id, name, description, prompt, workflow_json, integrations, status, n8n_workflow_id, deployed_at, created_at, updated_at')
    .maybeSingle();

  if (updateError) {
    const safe = classifyError(updateError);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
    ?? process.env.NEXT_PUBLIC_APP_URL
    ?? `https://${req.headers.get('host') ?? 'localhost:3000'}`;
  const localWebhookUrl = `${baseUrl}/api/workflows/${params.id}/webhook`;

  return NextResponse.json({
    success: true,
    workflow: updated,
    workflowUrl: created.workflowUrl ?? null,
    deployMode: deployedVia,
    webhookUrl: localWebhookUrl,
  });
}
