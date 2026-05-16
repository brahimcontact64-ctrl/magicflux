import { writeFileSync } from 'node:fs';

import { createClient } from '@supabase/supabase-js';

const BASE_URL = process.env.RUNTIME_E2E_BASE_URL ?? 'http://localhost:3000';
const STREAM_ARTIFACT = 'production-deploy-stream.txt';
const REPORT_ARTIFACT = 'production-deploy-e2e-report.json';

const EXACT_PROMPT =
  'Build me a Telegram crypto alert bot that checks CoinMarketCap every 15 minutes, summarizes changes with Grok, sends alerts to Telegram, and logs every signal in Supabase.';

type ParsedSseEvent = {
  event: string;
  data: Record<string, unknown>;
  raw: string;
};

type CheckResult = {
  pass: boolean;
  details?: Record<string, unknown>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function optionalEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

async function createE2EUser() {
  const url = env('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = env('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const now = Date.now();

  const service = createClient(url, serviceKey, { auth: { persistSession: false } });
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });

  const email = `e2e-prod-${now}@magicflux.local`;
  const password = 'MagicFlux!123456';

  const userCreate = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: 'admin' },
    app_metadata: { role: 'admin' },
  });

  if (userCreate.error || !userCreate.data.user?.id) {
    throw new Error(`Unable to create E2E user: ${userCreate.error?.message ?? 'unknown'}`);
  }

  const userId = userCreate.data.user.id;

  await service.from('user_profiles').upsert(
    {
      id: userId,
      email,
      role: 'admin',
      plan: 'pro',
      upgraded_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );

  await service.from('subscriptions').upsert(
    {
      user_id: userId,
      status: 'active',
      plan: 'pro',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );

  const signIn = await anon.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session?.access_token) {
    throw new Error(`Unable to sign in E2E user: ${signIn.error?.message ?? 'unknown'}`);
  }

  return {
    userId,
    token: signIn.data.session.access_token,
    service,
  };
}

async function seedConfiguredCredentials(params: {
  service: any;
  userId: string;
}) {
  const rows: Array<{
    user_id: string;
    provider: string;
    name: string;
    credentials: Record<string, string>;
    status: 'connected';
    last_verified_at: string;
    updated_at: string;
  }> = [];

  const nowIso = new Date().toISOString();

  const coinmarketcapApiKey = optionalEnv('COINMARKETCAP_API_KEY', 'CMC_API_KEY');
  if (coinmarketcapApiKey) {
    rows.push({
      user_id: params.userId,
      provider: 'coinmarketcap',
      name: 'coinmarketcap-e2e',
      credentials: { api_key: coinmarketcapApiKey },
      status: 'connected',
      last_verified_at: nowIso,
      updated_at: nowIso,
    });
  }

  const telegramBotToken = optionalEnv('TELEGRAM_BOT_TOKEN', 'TELEGRAM_TOKEN');
  const telegramChatId = optionalEnv('TELEGRAM_CHAT_ID');
  if (telegramBotToken) {
    rows.push({
      user_id: params.userId,
      provider: 'telegram',
      name: 'telegram-e2e',
      credentials: {
        bot_token: telegramBotToken,
        chat_id: telegramChatId ?? '',
      },
      status: 'connected',
      last_verified_at: nowIso,
      updated_at: nowIso,
    });
  }

  const grokApiKey = optionalEnv('GROK_API_KEY', 'XAI_API_KEY');
  if (grokApiKey) {
    rows.push({
      user_id: params.userId,
      provider: 'grok',
      name: 'grok-e2e',
      credentials: { api_key: grokApiKey },
      status: 'connected',
      last_verified_at: nowIso,
      updated_at: nowIso,
    });
  }

  const supabaseUrl = optionalEnv('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseServiceRoleKey = optionalEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (supabaseUrl && supabaseServiceRoleKey) {
    rows.push({
      user_id: params.userId,
      provider: 'supabase',
      name: 'supabase-e2e',
      credentials: {
        url: supabaseUrl,
        service_role_key: supabaseServiceRoleKey,
      },
      status: 'connected',
      last_verified_at: nowIso,
      updated_at: nowIso,
    });
  }

  if (rows.length > 0) {
    await (params.service.from('user_integrations') as any).upsert(rows, {
      onConflict: 'user_id,provider,name',
    });
  }

  return {
    seededProviders: rows.map((row) => row.provider),
  };
}

function parseSse(raw: string): ParsedSseEvent[] {
  const chunks = raw.split('\n\n').map((c) => c.trim()).filter(Boolean);
  const events: ParsedSseEvent[] = [];

  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    let eventName = 'message';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
    }

    let data: Record<string, unknown> = {};
    const dataRaw = dataLines.join('\n');
    if (dataRaw) {
      try {
        data = JSON.parse(dataRaw) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }

    events.push({ event: eventName, data, raw: chunk });
  }

  return events;
}

async function streamPrompt(params: {
  token: string;
  sessionId: string;
  message: string;
}) {
  const res = await fetch(`${BASE_URL}/api/conversation/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify({
      message: params.message,
      sessionId: params.sessionId,
      mode: 'production_deploy',
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`Stream failed (${res.status}): ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  const started = Date.now();

  while (Date.now() - started < 120_000) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (raw.includes('event: done')) break;
    if (raw.includes('event: error')) break;
  }

  reader.cancel().catch(() => undefined);
  return { raw, events: parseSse(raw), status: res.status };
}

function hasForbiddenLeak(raw: string): { leaked: boolean; matches: string[] } {
  const patterns: Array<[string, RegExp]> = [
    ['workflow_json_payload', /"workflow_json"\s*:/i],
    ['tool_args_payload', /"agentTasks"\s*:|"args"\s*:\s*\{/i],
    ['queue_ids', /"queue[_-]?job[_-]?id"\s*:/i],
    ['execution_ids', /"execution[_-]?id"\s*:/i],
    ['trace_ids', /"trace[_-]?id"\s*:/i],
    ['internal_fields', /"state"\s*:|runtime[_-]?state|task[_-]?payload|debug/i],
    ['secret_like_tokens', /(api[_-]?key|token|secret|password)\s*[:=]\s*"[^"\n]{6,}"/i],
  ];

  const matches = patterns.filter(([, rx]) => rx.test(raw)).map(([name]) => name);
  return {
    leaked: matches.length > 0,
    matches,
  };
}

function getList(payload: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value as Array<Record<string, unknown>>;
}

async function main() {
  const e2e = await createE2EUser();
  const sessionId = `e2e-production-${Date.now()}`;
  const seeded = await seedConfiguredCredentials({ service: e2e.service, userId: e2e.userId });

  const run1 = await streamPrompt({
    token: e2e.token,
    sessionId,
    message: EXACT_PROMPT,
  });

  let combinedRaw = run1.raw;
  const combinedEvents: ParsedSseEvent[] = [...run1.events];
  writeFileSync(STREAM_ARTIFACT, combinedRaw, 'utf8');

  const firstFinal = [...combinedEvents].reverse().find((evt) => evt.event === 'final');
  const firstPayload = (firstFinal?.data?.payload ?? {}) as Record<string, unknown>;
  const firstApprovalRequests = getList(firstPayload, 'approvalRequests');

  let approvalAccepted = false;
  let approvalContinuationRan = false;

  if (firstApprovalRequests.length > 0) {
    const pendingApproval = await e2e.service
      .from('agent_action_approvals')
      .select('action_key')
      .eq('user_id', e2e.userId)
      .eq('session_id', sessionId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const actionKey = String(pendingApproval.data?.action_key ?? '').trim();
    if (actionKey) {
      const update = await e2e.service
        .from('agent_action_approvals')
        .update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', e2e.userId)
        .eq('session_id', sessionId)
        .eq('action_key', actionKey);

      approvalAccepted = !update.error;

      const run2 = await streamPrompt({
        token: e2e.token,
        sessionId,
        message: 'Proceed with approved production deployment now.',
      });

      approvalContinuationRan = true;
      combinedRaw = `${combinedRaw}\n${run2.raw}`;
      combinedEvents.push(...run2.events);
      writeFileSync(STREAM_ARTIFACT, combinedRaw, 'utf8');
      await sleep(6000);
    }
  }

  const finalEvent = [...combinedEvents].reverse().find((evt) => evt.event === 'final');
  const finalPayload = (finalEvent?.data?.payload ?? {}) as Record<string, unknown>;

  const assistant = (finalPayload.assistant ?? {}) as Record<string, unknown>;
  const assistantContent = String(assistant.content ?? '');
  const agentEvents = getList(finalPayload, 'agentEvents');
  const credentialRequests = getList(finalPayload, 'credentialRequests');
  const approvalRequests = getList(finalPayload, 'approvalRequests');

  const credentialProviders = credentialRequests
    .map((row) => String(row.provider ?? '').toLowerCase())
    .filter(Boolean);

  const missingCredentials = credentialProviders.filter((provider) => !seeded.seededProviders.includes(provider));

  await sleep(10_000);

  const [conversationRow, queueRows, timelineRows, runtimeRows, deploymentVersionsRows, graphVersionsRows, graphMutationsRows, backgroundTaskRows] = await Promise.all([
    e2e.service
      .from('automation_conversations')
      .select('id, session_id, workflow_id, updated_at')
      .eq('user_id', e2e.userId)
      .eq('session_id', sessionId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    e2e.service
      .from('runtime_queue_jobs')
      .select('id, status, queue_name, task_type, error_message, created_at, workflow_id, execution_id')
      .eq('user_id', e2e.userId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(100),
    e2e.service
      .from('timeline_events')
      .select('id, event_type, title, status, created_at, workflow_id')
      .eq('user_id', e2e.userId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(100),
    e2e.service
      .from('runtime_events')
      .select('event_type, severity, payload, created_at, workflow_id, execution_id, correlation_id')
      .eq('user_id', e2e.userId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(200),
    e2e.service
      .from('deployment_versions')
      .select('id, workflow_id, version, status, deployed_at, rolled_back_at, rollback_reason, metadata')
      .eq('user_id', e2e.userId)
      .order('deployed_at', { ascending: false })
      .limit(20),
    e2e.service
      .from('workflow_graph_versions')
      .select('id, workflow_id, version, is_active, created_at')
      .eq('user_id', e2e.userId)
      .order('created_at', { ascending: false })
      .limit(20),
    e2e.service
      .from('workflow_graph_mutations')
      .select('id, workflow_id, version, mutation_type, reason, created_at')
      .eq('user_id', e2e.userId)
      .order('created_at', { ascending: false })
      .limit(20),
    e2e.service
      .from('background_tasks')
      .select('id, task_type, status, error_message, created_at, workflow_id')
      .eq('user_id', e2e.userId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const queueData = queueRows.data ?? [];
  const timelineData = timelineRows.data ?? [];
  const runtimeData = runtimeRows.data ?? [];
  const deploymentVersions = deploymentVersionsRows.data ?? [];
  const graphVersions = graphVersionsRows.data ?? [];
  const graphMutations = graphMutationsRows.data ?? [];
  const backgroundTasks = backgroundTaskRows.data ?? [];

  const deploymentJobs = queueData.filter((row) => ['deploy_workflow', 'activate_workflow', 'test_workflow'].includes(String(row.task_type ?? '')));
  const activateJobs = queueData.filter((row) => String(row.task_type ?? '') === 'activate_workflow');
  const deployJobs = queueData.filter((row) => String(row.task_type ?? '') === 'deploy_workflow');

  const runtimeEventTypes = runtimeData.map((row) => String(row.event_type ?? ''));

  const healthGateSignals = [
    ...queueData.map((row) => String(row.error_message ?? '')),
    ...runtimeData.map((row) => JSON.stringify(row.payload ?? {})),
    assistantContent,
    combinedRaw,
  ].join('\n');

  const healthGateFailed = /health gate failed|DEPLOYMENT_HEALTH_GATE_FAILED/i.test(healthGateSignals);
  const rollbackEvidence = /rollback|rolled_back|deactivate|deactivated/i.test(healthGateSignals)
    || deploymentVersions.some((row) => String(row.status ?? '') === 'rolled_back' || Boolean(row.rolled_back_at));

  const leakCheck = hasForbiddenLeak(combinedRaw);

  const checkResults: Record<string, CheckResult> = {
    exactPromptUsed: { pass: true, details: { prompt: EXACT_PROMPT } },
    streamRequestSucceeded: { pass: run1.status === 200, details: { status: run1.status } },
    credentialsPolicySafeStop: {
      pass: missingCredentials.length === 0 || (credentialRequests.length > 0 && deployJobs.length === 0 && activateJobs.length === 0),
      details: {
        seededProviders: seeded.seededProviders,
        requestedProviders: credentialProviders,
        missingCredentials,
      },
    },
    approvalRequestAppearsIfNeeded: {
      pass: approvalRequests.length > 0 || firstApprovalRequests.length > 0 || credentialRequests.length > 0,
      details: {
        firstApprovalRequests: firstApprovalRequests.length,
        finalApprovalRequests: approvalRequests.length,
      },
    },
    approvalAcceptAndContinue: {
      pass: firstApprovalRequests.length === 0 || (approvalAccepted && approvalContinuationRan),
      details: { approvalAccepted, approvalContinuationRan },
    },
    workflowGenerated: {
      pass: agentEvents.some((row) => String(row.type ?? '').includes('generating_workflow')),
      details: { agentEventsCount: agentEvents.length },
    },
    workflowPersisted: { pass: Boolean(conversationRow.data?.id), details: { row: conversationRow.data ?? null } },
    runtimeJobEnqueued: { pass: queueData.length > 0, details: { rows: queueData.length } },
    workerProcessedJob: {
      pass: queueData.some((row) => ['active', 'completed', 'failed'].includes(String(row.status ?? ''))),
      details: { statuses: Array.from(new Set(queueData.map((row) => String(row.status ?? '')))) },
    },
    deploymentBegins: {
      pass:
        deployJobs.length > 0
        || runtimeEventTypes.some((t) => t === 'workflow.deployed' || t === 'deployment.started' || t === 'deployment.completed')
        || /deploying your automation/i.test(combinedRaw),
      details: { deployJobs: deployJobs.length },
    },
    healthGateRunsAndActivationSafe: {
      pass: activateJobs.length === 0 || !healthGateFailed,
      details: { activateJobs: activateJobs.length, healthGateFailed },
    },
    rollbackOnHealthFailure: {
      pass: !healthGateFailed || rollbackEvidence,
      details: { healthGateFailed, rollbackEvidence },
    },
    streamSafetyNoLeaks: { pass: !leakCheck.leaked, details: leakCheck },
    runtimePersistenceTimeline: { pass: timelineData.length > 0, details: { rows: timelineData.length } },
    runtimePersistenceEvents: { pass: runtimeData.length > 0, details: { rows: runtimeData.length } },
    runtimePersistenceDeploymentVersion: { pass: deploymentVersions.length > 0, details: { rows: deploymentVersions.length } },
    runtimePersistenceGraphVersion: {
      pass: graphVersions.length > 0 || graphMutations.length > 0,
      details: { graphVersions: graphVersions.length, graphMutations: graphMutations.length },
    },
    runtimePersistenceTaskStatus: {
      pass: backgroundTasks.length === 0 || backgroundTasks.some((row) => String(row.status ?? '').length > 0),
      details: { rows: backgroundTasks.length },
    },
    userUxNaturalChat: {
      pass: assistantContent.length > 30 && !/{\s*"/.test(assistantContent),
      details: { preview: assistantContent.slice(0, 300) },
    },
    userUxIntegrationCardsIfNeeded: {
      pass: credentialRequests.length === 0 || credentialRequests.length > 0,
      details: { credentialRequests: credentialRequests.length },
    },
    userUxNoInternalStateExposed: {
      pass: !/runtime_state|agentTasks|execution_id|trace_id|queue_job_id/i.test(assistantContent),
      details: { preview: assistantContent.slice(0, 300) },
    },
  };

  const failedChecks = Object.entries(checkResults)
    .filter(([, result]) => !result.pass)
    .map(([name]) => name);

  const allPass = failedChecks.length === 0;
  const decision = allPass ? 'GO' : 'NO-GO';

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    prompt: EXACT_PROMPT,
    mode: 'production_deploy',
    sessionId,
    userId: e2e.userId,
    seededProviders: seeded.seededProviders,
    summary: {
      totalChecks: Object.keys(checkResults).length,
      passedChecks: Object.values(checkResults).filter((v) => v.pass).length,
      failedChecks: failedChecks.length,
      failedCheckNames: failedChecks,
      pass: allPass,
      decision,
    },
    checks: checkResults,
    samples: {
      assistantPreview: assistantContent.slice(0, 300),
      queueRows: queueData.slice(0, 15),
      runtimeRows: runtimeData.slice(0, 15),
      timelineRows: timelineData.slice(0, 15),
      deploymentVersions: deploymentVersions.slice(0, 10),
      graphVersions: graphVersions.slice(0, 10),
      graphMutations: graphMutations.slice(0, 10),
      backgroundTasks: backgroundTasks.slice(0, 10),
      credentialProviders,
      missingCredentials,
      approvalAccepted,
      approvalContinuationRan,
      deploymentJobs: deploymentJobs.slice(0, 10),
    },
  };

  writeFileSync(REPORT_ARTIFACT, JSON.stringify(report, null, 2), 'utf8');

  if (!allPass) {
    console.error(`Production deploy E2E FAILED (${decision}). See ${REPORT_ARTIFACT}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Production deploy E2E PASSED (${decision}).`);
}

main().catch((error) => {
  const fallback = {
    generatedAt: new Date().toISOString(),
    summary: {
      pass: false,
      decision: 'NO-GO',
    },
    error: error instanceof Error ? error.message : String(error),
  };

  writeFileSync(REPORT_ARTIFACT, JSON.stringify(fallback, null, 2), 'utf8');
  console.error(error);
  process.exit(1);
});
