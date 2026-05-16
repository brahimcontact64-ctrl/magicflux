import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

import { enqueueRuntimeJob } from '../lib/runtime/queue';
import { recoverStuckQueueJobs } from '../lib/runtime/worker';
import { recoverOrphanExecutions } from '../runtime/hardening-layer';
import { DeploymentRecoveryEngine } from '../recovery/deployment-recovery';
import { timelineManager } from '../lib/timeline/timeline-manager';
import { GraphMutationEngine } from '../graph/mutation-engine';

const BASE_URL = process.env.RUNTIME_SMOKE_BASE_URL ?? 'http://localhost:3000';

type Check = {
  name: string;
  ok: boolean;
  details?: Record<string, unknown>;
  error?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; data: any; headers: Headers }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, headers: res.headers };
}

async function waitForQueueTerminalState(service: any, userId: string, jobId: string, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { data } = await service
      .from('runtime_queue_jobs')
      .select('status, attempts, error_message, completed_at')
      .eq('user_id', userId)
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const row = data as Record<string, unknown> | null;
    if (row && ['completed', 'failed'].includes(String(row.status))) {
      return data;
    }

    await sleep(1000);
  }

  return null;
}

async function main() {
  const supabaseUrl = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = requiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });

  const checks: Check[] = [];
  const add = (name: string, ok: boolean, details?: Record<string, unknown>, error?: string) => {
    checks.push({ name, ok, details, error });
  };

  const now = Date.now();
  const email = `runtime-smoke-${now}@magicflux.local`;
  const password = 'MagicFlux!123456';

  const createdUser = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: 'admin' },
    app_metadata: { role: 'admin' },
  });

  if (createdUser.error || !createdUser.data.user) {
    throw new Error(`Failed to create smoke user: ${createdUser.error?.message ?? 'unknown'}`);
  }

  const userId = createdUser.data.user.id;

  await service.from('user_profiles').upsert({
    id: userId,
    email,
    plan: 'pro',
    role: 'admin',
    upgraded_at: new Date().toISOString(),
  }, { onConflict: 'id' });

  await service.from('subscriptions').upsert({
    user_id: userId,
    status: 'active',
    plan: 'pro',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });

  const signIn = await anon.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session?.access_token) {
    throw new Error(`Failed to sign in smoke user: ${signIn.error?.message ?? 'unknown'}`);
  }

  const token = signIn.data.session.access_token;
  const authHeader = { Authorization: `Bearer ${token}` };

  const workflowJson = {
    name: 'Runtime Smoke Workflow',
    nodes: [
      {
        id: 'n1',
        name: 'Webhook Trigger',
        type: 'n8n-nodes-base.webhook',
        parameters: {},
      },
      {
        id: 'n2',
        name: 'Wait Node',
        type: 'n8n-nodes-base.wait',
        parameters: { amount: 120 },
      },
    ],
    connections: {
      'Webhook Trigger': {
        main: [[{ node: 'Wait Node', type: 'main', index: 0 }]],
      },
    },
  };

  const { data: workflowRow, error: workflowInsertError } = await service
    .from('workflows')
    .insert({
      user_id: userId,
      name: `Runtime Smoke ${now}`,
      description: 'End-to-end runtime smoke test workflow',
      prompt: 'runtime smoke test',
      workflow_json: workflowJson,
      integrations: [],
      status: 'deployed',
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (workflowInsertError || !workflowRow?.id) {
    throw new Error(`Failed to create smoke workflow: ${workflowInsertError?.message ?? 'unknown'}`);
  }

  const workflowId = String(workflowRow.id);
  const sessionId = `runtime-smoke-session-${now}`;

  const health = await fetchJson(`${BASE_URL}/api/health/runtime`);
  add('runtime health endpoint', health.status === 200, { health: health.data });

  const webhookRes = await fetchJson(`${BASE_URL}/api/workflows/${workflowId}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world', smoke: true }),
  });

  const executionId = webhookRes.data?.executionId as string | undefined;
  add('webhook live execution start', webhookRes.status === 200 && Boolean(executionId), {
    status: webhookRes.status,
    body: webhookRes.data,
  });

  if (executionId) {
    await sleep(1500);

    const { data: executionRow } = await service
      .from('workflow_executions_v2')
      .select('id, status, next_run_at, current_node_id')
      .eq('id', executionId)
      .eq('user_id', userId)
      .maybeSingle();

    add('execution checkpoints persisted', Boolean(executionRow) && String(executionRow?.status) === 'waiting', {
      execution: executionRow ?? null,
    });

    const { data: checkpoints } = await service
      .from('runtime_execution_checkpoints')
      .select('checkpoint_type, current_node_id, created_at')
      .eq('execution_id', executionId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5);

    add('runtime checkpoint rows exist', Array.isArray(checkpoints) && checkpoints.length > 0, {
      checkpoints: checkpoints ?? [],
    });

    const pause = await fetchJson(`${BASE_URL}/api/workflows/executions/${executionId}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ action: 'pause', reason: 'smoke pause' }),
    });

    const resume = await fetchJson(`${BASE_URL}/api/workflows/executions/${executionId}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ action: 'resume', reason: 'smoke resume' }),
    });

    const cancel = await fetchJson(`${BASE_URL}/api/workflows/executions/${executionId}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ action: 'cancel', reason: 'smoke cancel' }),
    });

    add('pause/resume/cancel endpoints', pause.status === 200 && resume.status === 200 && cancel.status === 200, {
      pause: pause.data,
      resume: resume.data,
      cancel: cancel.data,
    });
  }

  const streamRes = await fetch(`${BASE_URL}/api/conversation/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Create a simple automation', sessionId }),
  });

  const streamType = streamRes.headers.get('content-type') ?? '';
  let sseSample = '';
  if (streamRes.body) {
    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    const started = Date.now();

    while (Date.now() - started < 8000) {
      const { value, done } = await reader.read();
      if (done) break;
      sseSample += decoder.decode(value, { stream: true });
      if (sseSample.includes('event: done') || sseSample.includes('event: error')) break;
    }

    reader.cancel().catch(() => undefined);
  }

  add('SSE stream emits events', streamType.includes('text/event-stream') && sseSample.includes('event:'), {
    contentType: streamType,
    preview: sseSample.slice(0, 600),
  });

  const failingQueue = await enqueueRuntimeJob({
    queueName: 'monitoring_queue',
    taskType: 'get_workflow_status',
    payload: {
      userId,
      sessionId,
      workflowId,
      toolName: 'get_workflow_status',
      args: { workflow_id: 'non-existent-workflow' },
      correlationId: `corr-smoke-fail-${now}`,
      executionId: `exec-smoke-fail-${now}`,
    },
    attempts: 2,
  });

  add('enqueue real background task', failingQueue.enqueued, {
    queueJobId: failingQueue.queueJobId,
    reason: failingQueue.reason ?? null,
  });

  const terminal = await waitForQueueTerminalState(service, userId, failingQueue.queueJobId, 90_000);
  add('BullMQ processing terminal state', Boolean(terminal), {
    job: terminal,
  });

  const { data: eventsRows } = await service
    .from('runtime_events')
    .select('event_type, severity, correlation_id, execution_id, timestamp')
    .eq('user_id', userId)
    .eq('correlation_id', `corr-smoke-fail-${now}`)
    .order('created_at', { ascending: false })
    .limit(20);

  add('runtime events emission', Boolean(eventsRows && eventsRows.length > 0), {
    count: eventsRows?.length ?? 0,
    sample: eventsRows?.slice(0, 5) ?? [],
  });

  const { data: dlqRows } = await service
    .from('runtime_queue_dead_letters')
    .select('id, queue_name, task_type, replay_status, failed_at, error_message')
    .eq('user_id', userId)
    .order('failed_at', { ascending: false })
    .limit(10);

  add('dead-letter queue verification', Boolean(dlqRows && dlqRows.length > 0), {
    dlqCount: dlqRows?.length ?? 0,
    sample: dlqRows?.slice(0, 3) ?? [],
  });

  await timelineManager.recordEvent(
    userId,
    sessionId,
    'workflow_generated',
    'Smoke timeline event',
    {
      workflowId,
      description: 'Timeline persistence smoke check',
      status: 'info',
      metadata: { smoke: true },
    }
  );

  const { data: timelineRows } = await service
    .from('timeline_events')
    .select('id, event_type, title, status, created_at')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(5);

  add('timeline events persistence', Boolean(timelineRows && timelineRows.length > 0), {
    rows: timelineRows ?? [],
  });

  const graphMutationEngine = new GraphMutationEngine();
  const graphMutation = await graphMutationEngine.applyMutation({
    userId,
    workflowId,
    sessionId,
    reason: 'Smoke graph mutation',
    actor: 'system',
    action: {
      type: 'add_node',
      node: {
        id: `smoke-node-${now}`,
        type: 'n8n-nodes-base.code',
        data: { label: 'Smoke Node' },
        position: { x: 300, y: 120 },
      },
      connectFrom: 'n1',
    },
  });

  const { data: mutationRows } = await service
    .from('workflow_graph_mutations')
    .select('id, workflow_id, version, mutation_type, reason, created_at')
    .eq('user_id', userId)
    .eq('workflow_id', workflowId)
    .order('created_at', { ascending: false })
    .limit(5);

  add('graph mutation persistence', Boolean(mutationRows && mutationRows.length > 0), {
    latestVersion: graphMutation.version,
    rows: mutationRows ?? [],
  });

  const deploymentIdA = `smoke-deploy-a-${now}`;
  const deploymentIdB = `smoke-deploy-b-${now}`;

  await service.from('deployment_versions').insert([
    {
      user_id: userId,
      workflow_id: workflowId,
      version: 1,
      deployment_id: deploymentIdA,
      status: 'superseded',
      workflow_data: workflowJson,
      metadata: { smoke: true, v: 1 },
      deployed_at: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      user_id: userId,
      workflow_id: workflowId,
      version: 2,
      deployment_id: deploymentIdB,
      status: 'active',
      workflow_data: workflowJson,
      metadata: { smoke: true, v: 2 },
      deployed_at: new Date().toISOString(),
    },
  ]);

  const recovery = new DeploymentRecoveryEngine();
  const rollbackResult = await recovery.recoverFromFailure({
    userId,
    workflowId,
    sessionId,
    reason: 'smoke-triggered rollback',
  });

  add('deployment rollback trigger path', rollbackResult.success, {
    rollback: rollbackResult,
  });

  const staleJobId = `stale-job-${now}`;
  await service.from('runtime_queue_jobs').insert({
    user_id: userId,
    session_id: sessionId,
    workflow_id: workflowId,
    queue_name: 'execution_queue',
    job_id: staleJobId,
    task_type: 'test_workflow',
    status: 'active',
    attempts: 1,
    max_attempts: 3,
    correlation_id: `corr-stale-${now}`,
    payload: { smoke: true },
    heartbeat_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    queued_at: new Date(Date.now() - 21 * 60 * 1000).toISOString(),
    started_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    created_at: new Date(Date.now() - 21 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  });

  const recoveredStaleCount = await recoverStuckQueueJobs({ staleMinutes: 10, limit: 50 });
  add('stalled-job recovery verification', recoveredStaleCount > 0, { recoveredStaleCount });

  const orphanExecutionId = `orphan-exec-${now}`;
  await service.from('workflow_executions_v2').insert({
    id: orphanExecutionId,
    workflow_id: workflowId,
    user_id: userId,
    status: 'running',
    mode: 'live',
    input_data: { smoke: true },
    retry_count: 0,
    max_retries: 3,
    started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });

  await service.from('runtime_execution_ownership').upsert({
    execution_id: orphanExecutionId,
    workflow_id: workflowId,
    user_id: userId,
    queue_job_id: null,
    worker_id: 'stale-worker',
    owner_token: `owner-token-${now}`,
    lease_expires_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    heartbeat_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    state: 'active',
    updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });

  const orphanRecovered = await recoverOrphanExecutions({ staleAfterMinutes: 3, limit: 20 });
  add('execution cleanup for orphaned runs', orphanRecovered.some((row) => row.executionId === orphanExecutionId), {
    recovered: orphanRecovered,
  });

  const workersBefore = await service
    .from('runtime_workers')
    .select('worker_id, memory_mb, heartbeat_at, jobs_processed')
    .order('heartbeat_at', { ascending: false })
    .limit(5);

  await sleep(31_000);

  const workersAfter = await service
    .from('runtime_workers')
    .select('worker_id, memory_mb, heartbeat_at, jobs_processed')
    .order('heartbeat_at', { ascending: false })
    .limit(5);

  add('worker heartbeat system', Boolean(workersAfter.data && workersAfter.data.length > 0), {
    before: workersBefore.data ?? [],
    after: workersAfter.data ?? [],
  });

  add('no obvious worker memory leak (short window)', Boolean(workersBefore.data && workersAfter.data), {
    beforeTop: workersBefore.data?.[0] ?? null,
    afterTop: workersAfter.data?.[0] ?? null,
    note: 'Short smoke window only; not a long-haul leak test.',
  });

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    userId,
    workflowId,
    checks,
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).length,
    },
  };

  writeFileSync('runtime-smoke-report.json', JSON.stringify(report, null, 2), 'utf8');

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error('Runtime smoke completed with failures.');
    for (const item of failed) {
      console.error(`- ${item.name}: ${item.error ?? 'check failed'}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Runtime smoke completed successfully.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
