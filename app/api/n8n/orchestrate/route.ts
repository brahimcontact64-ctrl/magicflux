import { NextRequest, NextResponse } from 'next/server';
import {
  createWorkflow, createCredential, patchWorkflowCredentials,
  activateWorkflow, getN8nConfig,
} from '@/lib/ai-engine/n8n-deployer';
import {
  getUserFromRequest, checkDeployRateLimit,
  createServiceClient,
} from '@/lib/supabase-server';
import { canDeployWorkflow } from '@/lib/billing/plan-limits';

export type OrchestrationStage =
  | 'creating_workflow'
  | 'provisioning_credentials'
  | 'injecting_credentials'
  | 'activating'
  | 'complete'
  | 'failed';

export interface CredentialInput {
  type: string;
  service: string;
  data: Record<string, unknown>;
}

export interface OrchestrationResult {
  stage: OrchestrationStage;
  workflowId?: string;
  workflowUrl?: string;
  activated: boolean;
  deployedAsDraft?: boolean;
  testStatus: 'not_tested';
  testMessage: string;
  warnings: string[];
  error?: string;
}

const OAUTH_ONLY_TYPES = new Set(['googleSheetsOAuth2Api']);

const ALLOWED_CREDENTIAL_TYPES = new Set([
  'slackApi', 'smtp', 'twilioApi', 'airtableTokenApi',
  'shopifyApi', 'hubspotApi', 'googleSheetsOAuth2Api',
]);

function safeError(service: string) {
  return `Failed to provision ${service} credentials in n8n. Check your n8n instance and try again.`;
}

function buildWarnings(credentials: CredentialInput[], hasWaitNode: boolean): string[] {
  const w: string[] = [];
  w.push('Automated test execution is not supported by the n8n Public API. Trigger your workflow manually in n8n to test it.');
  if (hasWaitNode) {
    w.push('This workflow contains a Wait/Approval node. Copy the resume URL from the Wait node inside n8n after the workflow first runs.');
  }
  credentials.filter(c => OAUTH_ONLY_TYPES.has(c.type)).forEach(c => {
    w.push(`${c.service} requires completing OAuth inside n8n. Open n8n → Credentials → find "${c.service}" → click "Sign in with Google".`);
  });
  return w;
}

function enforceHttps(apiUrl: string): string | null {
  if (process.env.NODE_ENV !== 'production') return null;
  if (apiUrl.includes('localhost') || apiUrl.includes('127.0.0.1')) return null;
  if (apiUrl.startsWith('http://')) {
    return 'N8N_API_URL must use HTTPS in production.';
  }
  return null;
}

export async function POST(req: NextRequest) {
  // 1. Authenticate — verify JWT, never trust client-supplied userId
  const authUser = await getUserFromRequest(req);
  if (!authUser) {
    return NextResponse.json({ error: 'Authentication required. Please sign in.' }, { status: 401 });
  }

  // 2. Plan gate — Pro/Business only. Phase 9.3.1 Step E: uses the same
  // canonical, FK-joined entitlement resolver as the native activation
  // gate (lib/billing/plan-limits.ts). Previously called this file's own
  // getUserPlan() (lib/supabase-server.ts), which trusted the raw,
  // unverified subscriptions.plan text column — the same loose pattern as
  // the client-only display badge — and only ever recognized the literal
  // string 'pro', silently denying a legitimate Business-tier customer.
  const deployCheck = await canDeployWorkflow(authUser.id);
  if (!deployCheck.allowed) {
    return NextResponse.json(
      { error: deployCheck.reason ?? 'Upgrade required. Deploy to n8n is available on paid plans.' },
      { status: 403 }
    );
  }

  // 3. Rate limit — 5 deploys / 60s per user
  const allowed = await checkDeployRateLimit(authUser.id);
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many deploy requests. Wait a minute before trying again.' },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => ({})) as {
    workflow?: { name: string; nodes: object[]; connections: object; settings?: object };
    credentials?: CredentialInput[];
    sessionId?: string;
  };

  const { workflow, credentials = [], sessionId } = body;

  // 4. Input validation
  if (!workflow?.name || !Array.isArray(workflow?.nodes) || !workflow?.connections) {
    return NextResponse.json({ error: 'workflow.name, nodes, and connections are required.' }, { status: 400 });
  }
  if (typeof workflow.name !== 'string' || workflow.name.length > 200) {
    return NextResponse.json({ error: 'Invalid workflow name.' }, { status: 400 });
  }
  const badCred = credentials.find(c => !ALLOWED_CREDENTIAL_TYPES.has(c.type));
  if (badCred) {
    return NextResponse.json({ error: `Unsupported credential type: ${badCred.type}` }, { status: 400 });
  }

  const config = getN8nConfig();
  if (!config) {
    return NextResponse.json({ error: 'n8n is not configured on this server. Contact support.' }, { status: 503 });
  }

  const httpsErr = enforceHttps(config.apiUrl);
  if (httpsErr) return NextResponse.json({ error: httpsErr }, { status: 400 });

  const hasWaitNode = (workflow.nodes as Array<Record<string, unknown>>).some(
    n => n.type === 'n8n-nodes-base.wait' &&
         (n.parameters as Record<string, unknown>)?.resume === 'webhook'
  );

  // Prefix name with brand + short userId for basic tenant isolation
  const isolatedName = `MagicFlux_${authUser.id.slice(0, 8)}_${workflow.name}`;

  const result: OrchestrationResult = {
    stage: 'creating_workflow',
    activated: false,
    testStatus: 'not_tested',
    testMessage: 'Workflow deployed and activated. Test it by triggering its webhook or running it manually in n8n.',
    warnings: buildWarnings(credentials, hasWaitNode),
  };

  const db = createServiceClient();

  try {
    // 5. Create workflow
    const deployResult = await createWorkflow(config, {
      name: isolatedName,
      nodes: workflow.nodes,
      connections: workflow.connections,
      settings: workflow.settings,
    });

    if (deployResult.status === 'error' || !deployResult.workflowId) {
      return NextResponse.json({
        ...result, stage: 'failed',
        error: 'Failed to create workflow in n8n. Check your n8n instance connection.',
      }, { status: 500 });
    }

    result.workflowId = deployResult.workflowId;
    result.workflowUrl = deployResult.workflowUrl;
    result.stage = 'provisioning_credentials';

    // Persist with authenticated user_id
    db.from('workflow_executions').insert({
      session_id: sessionId || `session-${Date.now()}`,
      user_id: authUser.id,
      n8n_workflow_id: deployResult.workflowId,
      n8n_instance_url: config.apiUrl,
      status: 'pending',
      workflow_name: isolatedName,
    }).then(() => {}, () => {});

    db.from('workflow_deployments').insert({
      user_id: authUser.id,
      session_id: sessionId || `session-${Date.now()}`,
      template_id: 'live_deploy',
      template_name: workflow.name,
      industry: 'custom',
      deployment_mode: 'self_deploy',
      status: 'deploying',
      n8n_workflow_id: deployResult.workflowId,
      n8n_instance_url: config.apiUrl,
    }).then(() => {}, () => {});

    if (credentials.length === 0) {
      return NextResponse.json({
        ...result, stage: 'complete', activated: false, deployedAsDraft: true,
        testMessage: 'No credentials provided — deployed as inactive draft. Link credentials in n8n and activate manually.',
      });
    }

    // 6. Provision credentials
    const credentialMap: Record<string, { id: string; name: string }> = {};
    for (const cred of credentials) {
      try {
        const created = await createCredential(config, {
          name: `MagicFlux_${authUser.id.slice(0, 8)}_${cred.service}_${workflow.name}`,
          type: cred.type,
          data: cred.data,
        });
        credentialMap[cred.type] = { id: created.id, name: created.name };
      } catch {
        return NextResponse.json({
          ...result, stage: 'failed', deployedAsDraft: true,
          error: safeError(cred.service),
        }, { status: 207 });
      }
    }

    result.stage = 'injecting_credentials';

    // 7. Inject credentials into nodes
    try {
      await patchWorkflowCredentials(config, deployResult.workflowId, credentialMap);
    } catch {
      return NextResponse.json({
        ...result, stage: 'failed', deployedAsDraft: true,
        error: 'Credential wiring failed. Workflow deployed as draft — link credentials manually in n8n.',
      }, { status: 207 });
    }

    result.stage = 'activating';

    // 8. Skip activation for OAuth credentials
    if (credentials.some(c => OAUTH_ONLY_TYPES.has(c.type))) {
      db.from('workflow_executions')
        .update({ orchestration_stage: 'complete', credential_types_provisioned: Object.keys(credentialMap) })
        .eq('n8n_workflow_id', deployResult.workflowId)
        .eq('user_id', authUser.id)
        .then(() => {}, () => {});

      return NextResponse.json({
        ...result, stage: 'complete', activated: false, deployedAsDraft: true,
        testMessage: 'Workflow deployed with credentials. Complete OAuth in n8n, then activate manually.',
      });
    }

    // 9. Activate
    try {
      await activateWorkflow(config, deployResult.workflowId);
    } catch {
      return NextResponse.json({
        ...result, stage: 'failed', deployedAsDraft: true,
        error: 'Workflow deployed with credentials but could not be activated. Activate it manually in n8n.',
      }, { status: 207 });
    }

    db.from('workflow_executions').update({
      status: 'active',
      activated_at: new Date().toISOString(),
      orchestration_stage: 'complete',
      credential_types_provisioned: Object.keys(credentialMap),
      live_deploy_at: new Date().toISOString(),
      test_status: 'not_tested',
      test_message: result.testMessage,
    }).eq('n8n_workflow_id', deployResult.workflowId).eq('user_id', authUser.id).then(() => {}, () => {});

    db.from('workflow_deployments')
      .update({ status: 'active' })
      .eq('n8n_workflow_id', deployResult.workflowId)
      .eq('user_id', authUser.id)
      .then(() => {}, () => {});

    result.stage = 'complete';
    result.activated = true;
    return NextResponse.json({ ...result });

  } catch {
    return NextResponse.json({
      ...result, stage: 'failed', deployedAsDraft: true,
      error: 'An unexpected error occurred during deployment. Check your n8n instance and try again.',
    }, { status: 500 });
  }
}
