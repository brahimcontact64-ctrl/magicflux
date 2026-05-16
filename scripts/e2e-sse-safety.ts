import { writeFileSync } from 'node:fs';

import { createClient } from '@supabase/supabase-js';

const BASE_URL = process.env.RUNTIME_E2E_BASE_URL ?? 'http://localhost:3000';

const EXACT_PROMPT =
  'Build me a Telegram crypto alert bot that checks CoinMarketCap every 15 minutes, summarizes changes with Grok, sends alerts to Telegram, and logs every signal in Supabase.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ParsedSseEvent = {
  event: string;
  data: Record<string, unknown>;
  raw: string;
};

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

async function createE2EUser() {
  const url = env('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = env('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const now = Date.now();

  const service = createClient(url, serviceKey, { auth: { persistSession: false } });
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });

  const email = `e2e-sse-${now}@magicflux.local`;
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
  mode: 'safe_preview' | 'staging_deploy' | 'production_deploy';
  message?: string;
}): Promise<{ raw: string; events: ParsedSseEvent[] }> {
  const res = await fetch(`${BASE_URL}/api/conversation/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify({
      message: params.message ?? EXACT_PROMPT,
      sessionId: params.sessionId,
      mode: params.mode,
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

  while (Date.now() - started < 90_000) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (raw.includes('event: done')) break;
    if (raw.includes('event: error')) break;
  }

  reader.cancel().catch(() => undefined);
  return { raw, events: parseSse(raw) };
}

function hasForbiddenLeak(raw: string): { leaked: boolean; matches: string[] } {
  const patterns: Array<[string, RegExp]> = [
    ['workflow_json_payload', /\"workflow_json\"\s*:/i],
    ['tool_args_payload', /\"agentTasks\"\s*:|\"args\"\s*:\s*\{/i],
    ['internal_fields', /\"state\"\s*:|runtime[_-]?state|provider[_-]?metadata|task[_-]?payload|debug/i],
    ['execution_ids', /\"execution[_-]?id\"\s*:/i],
    ['queue_ids', /\"queue[_-]?job[_-]?id\"\s*:/i],
    ['provider_metadata', /\"provider[_-]?metadata\"\s*:/i],
  ];

  const matches = patterns.filter(([, rx]) => rx.test(raw)).map(([name]) => name);
  return {
    leaked: matches.length > 0,
    matches,
  };
}

async function main() {
  const e2e = await createE2EUser();
  const sessionId = `e2e-sse-${Date.now()}`;

  const staging = await streamPrompt({
    token: e2e.token,
    sessionId,
    mode: 'staging_deploy',
  });

  writeFileSync('tmp-e2e-sse.txt', staging.raw, 'utf8');

  const firstFinal = [...staging.events].reverse().find((evt) => evt.event === 'final');
  const firstPayload = (firstFinal?.data?.payload ?? {}) as Record<string, unknown>;
  const firstApprovals = Array.isArray(firstPayload.approvalRequests) ? firstPayload.approvalRequests : [];

  if (firstApprovals.length > 0) {
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
      await e2e.service
        .from('agent_action_approvals')
        .update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', e2e.userId)
        .eq('session_id', sessionId)
        .eq('action_key', actionKey);

      const deployFollowup = await streamPrompt({
        token: e2e.token,
        sessionId,
        mode: 'staging_deploy',
        message: 'Proceed with the approved deployment now.',
      });

      writeFileSync('tmp-e2e-sse.txt', `${staging.raw}\n${deployFollowup.raw}`, 'utf8');
      staging.raw = `${staging.raw}\n${deployFollowup.raw}`;
      staging.events.push(...deployFollowup.events);

      await sleep(5000);
    }
  }

  const finalEvent = [...staging.events].reverse().find((evt) => evt.event === 'final');
  const finalPayload = (finalEvent?.data?.payload ?? {}) as Record<string, unknown>;
  const safeAssistant = (finalPayload.assistant ?? {}) as Record<string, unknown>;
  const safeEvents = Array.isArray(finalPayload.agentEvents) ? finalPayload.agentEvents : [];
  const safeCreds = Array.isArray(finalPayload.credentialRequests) ? finalPayload.credentialRequests : [];
  const safeWorkflowPreview = (finalPayload.workflowPreview ?? null) as Record<string, unknown> | null;
  const safeDeployment = (finalPayload.deploymentStatus ?? null) as Record<string, unknown> | null;

  const leakCheck = hasForbiddenLeak(staging.raw);

  const allWorkflowPreviews = staging.events
    .filter((evt) => evt.event === 'tool_event')
    .map((evt) => (evt.data.workflowPreview ?? null) as Record<string, unknown> | null)
    .filter((row): row is Record<string, unknown> => Boolean(row));

  const workflowPreviewIntegrations = allWorkflowPreviews
    .flatMap((preview) => (Array.isArray(preview.integrations) ? preview.integrations : []))
    .map((v) => String(v).toLowerCase());

  const hasExpectedIntegrations =
    workflowPreviewIntegrations.some((integration) => integration.includes('telegram')) &&
    workflowPreviewIntegrations.length >= 3;

  const [conversationRow, queueRows, timelineRows] = await Promise.all([
    e2e.service
      .from('automation_conversations')
      .select('id, session_id')
      .eq('user_id', e2e.userId)
      .eq('session_id', sessionId)
      .limit(1)
      .maybeSingle(),
    e2e.service
      .from('runtime_queue_jobs')
      .select('status, queue_name, task_type, created_at')
      .eq('user_id', e2e.userId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(50),
    e2e.service
      .from('timeline_events')
      .select('id, event_type, title, created_at')
      .eq('user_id', e2e.userId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(30),
  ]);

  const queueData = queueRows.data ?? [];
  const deploymentRelatedJobs = queueData.filter((row) =>
    ['deploy_workflow', 'activate_workflow', 'test_workflow'].includes(String(row.task_type ?? ''))
  );

  const checks = {
    graphAppears:
      Boolean(safeWorkflowPreview && Number(safeWorkflowPreview.nodeCount ?? 0) > 0) ||
      allWorkflowPreviews.some((preview) => Number(preview.nodeCount ?? 0) > 0),
    integrationsRequested: safeCreds.length > 0 || hasExpectedIntegrations,
    workflowSaved: Boolean(conversationRow.data?.id),
    runtimeJobEnqueued: deploymentRelatedJobs.length > 0,
    workerProcessedJob: deploymentRelatedJobs.some((row) => ['active', 'completed', 'failed'].includes(String(row.status ?? ''))),
    timelineUpdated: (timelineRows.data ?? []).length > 0,
    noRawJsonLeaks: !leakCheck.leaked,
    deploymentGatedState:
      safeEvents.some((row) => String((row as Record<string, unknown>).type ?? '').includes('approval')) ||
      safeEvents.some((row) => String((row as Record<string, unknown>).type ?? '').includes('policy')) ||
      Boolean(safeDeployment?.status) ||
      safeCreds.length > 0,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    prompt: EXACT_PROMPT,
    mode: 'staging_deploy',
    sessionId,
    userId: e2e.userId,
    checks,
    leakCheck,
    safePayloadPreview: {
      assistant: {
        content: String(safeAssistant.content ?? '').slice(0, 300),
      },
      agentEventsCount: safeEvents.length,
      credentialRequestsCount: safeCreds.length,
      workflowPreview: safeWorkflowPreview,
      deploymentStatus: safeDeployment,
    },
    queueSample: queueData.slice(0, 10),
    timelineSample: (timelineRows.data ?? []).slice(0, 10),
    summary: {
      totalChecks: Object.keys(checks).length,
      passedChecks: Object.values(checks).filter(Boolean).length,
      failedChecks: Object.values(checks).filter((v) => !v).length,
      pass: Object.values(checks).every(Boolean),
    },
  };

  writeFileSync('e2e-sse-safety-report.json', JSON.stringify(report, null, 2), 'utf8');

  if (!report.summary.pass) {
    console.error('E2E SSE safety FAILED. See e2e-sse-safety-report.json and tmp-e2e-sse.txt');
    process.exitCode = 1;
    return;
  }

  console.log('E2E SSE safety PASSED.');
}

main().catch((error) => {
  const fallback = {
    generatedAt: new Date().toISOString(),
    summary: {
      pass: false,
    },
    error: error instanceof Error ? error.message : String(error),
  };

  writeFileSync('e2e-sse-safety-report.json', JSON.stringify(fallback, null, 2), 'utf8');
  console.error(error);
  process.exit(1);
});
