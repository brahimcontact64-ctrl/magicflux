import "server-only";

import { createHash, randomUUID } from 'crypto';

import { createServiceClient } from '@/lib/supabase-server';
import { appendExecutionEvent } from '@/lib/runtime/event-store';
import { reclaimExpiredConcurrencyReservations } from '@/lib/runtime/concurrency-guard';

export type LockAcquireResult = {
  acquired: boolean;
  version?: number;
  reason?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function addSeconds(date: Date, seconds: number): string {
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function buildExecutionIdempotencyKey(params: {
  workflowId: string;
  mode: 'test' | 'live';
  inputData: Record<string, unknown>;
  explicitKey?: string;
}): string {
  if (params.explicitKey) return params.explicitKey;
  const raw = `${params.workflowId}:${params.mode}:${stableStringify(params.inputData)}`;
  return createHash('sha256').update(raw).digest('hex');
}

export async function findExecutionByIdempotencyKey(params: {
  userId: string;
  idempotencyKey: string;
}): Promise<
  | {
      executionId: string;
      status: string;
      outputData: unknown;
      currentNodeId: string | null;
      errorMessage: string | null;
      nextRunAt: string | null;
    }
  | null
> {
  const db = createServiceClient();

  const { data: lock } = await db
    .from('runtime_execution_locks')
    .select('execution_id, user_id')
    .eq('idempotency_key', params.idempotencyKey)
    .eq('user_id', params.userId)
    .limit(1)
    .maybeSingle();

  if (!lock?.execution_id) return null;

  const { data: exec } = await db
    .from('workflow_executions_v2')
    .select('id, status, output_data, current_node_id, error_message, next_run_at')
    .eq('id', lock.execution_id)
    .eq('user_id', params.userId)
    .limit(1)
    .maybeSingle();

  if (!exec) return null;

  return {
    executionId: exec.id,
    status: String(exec.status ?? 'running'),
    outputData: exec.output_data ?? null,
    currentNodeId: (exec.current_node_id as string | null) ?? null,
    errorMessage: (exec.error_message as string | null) ?? null,
    nextRunAt: (exec.next_run_at as string | null) ?? null,
  };
}

export async function acquireExecutionLock(params: {
  executionId: string;
  userId: string;
  workflowId: string;
  ownerId: string;
  idempotencyKey?: string;
  leaseSeconds?: number;
}): Promise<LockAcquireResult> {
  const db = createServiceClient();
  const leaseSeconds = params.leaseSeconds ?? 45;
  const now = new Date();

  const { data: existing } = await db
    .from('runtime_execution_locks')
    .select('lock_version, owner_id, lease_expires_at')
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId)
    .limit(1)
    .maybeSingle();

  if (!existing) {
    const { error } = await db.from('runtime_execution_locks').insert({
      execution_id: params.executionId,
      user_id: params.userId,
      workflow_id: params.workflowId,
      idempotency_key: params.idempotencyKey ?? null,
      owner_id: params.ownerId,
      lock_version: 1,
      lease_expires_at: addSeconds(now, leaseSeconds),
      last_status: 'running',
      metadata: {},
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    if (error) {
      return { acquired: false, reason: error.message };
    }

    return { acquired: true, version: 1 };
  }

  const leaseExpiresAt = new Date(String(existing.lease_expires_at));
  const ownedByOther = existing.owner_id && existing.owner_id !== params.ownerId;
  if (ownedByOther && leaseExpiresAt > now) {
    return { acquired: false, reason: 'Execution lease already held by another worker' };
  }

  const nextVersion = Number(existing.lock_version ?? 1) + 1;
  const { error: updateError } = await db
    .from('runtime_execution_locks')
    .update({
      owner_id: params.ownerId,
      lock_version: nextVersion,
      lease_expires_at: addSeconds(now, leaseSeconds),
      updated_at: nowIso(),
    })
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId)
    .eq('lock_version', Number(existing.lock_version ?? 1));

  if (updateError) {
    return { acquired: false, reason: updateError.message };
  }

  return { acquired: true, version: nextVersion };
}

export async function renewExecutionLock(params: {
  executionId: string;
  userId: string;
  ownerId: string;
  leaseSeconds?: number;
}): Promise<boolean> {
  const db = createServiceClient();
  const leaseSeconds = params.leaseSeconds ?? 45;
  const { error } = await db
    .from('runtime_execution_locks')
    .update({
      lease_expires_at: addSeconds(new Date(), leaseSeconds),
      updated_at: nowIso(),
    })
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId)
    .eq('owner_id', params.ownerId);

  return !error;
}

export async function releaseExecutionLock(params: {
  executionId: string;
  userId: string;
  ownerId: string;
  status: 'waiting' | 'completed' | 'failed' | 'cancelled';
}): Promise<void> {
  const db = createServiceClient();
  await db
    .from('runtime_execution_locks')
    .update({
      last_status: params.status,
      owner_id: null,
      lease_expires_at: nowIso(),
      updated_at: nowIso(),
    })
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId)
    .eq('owner_id', params.ownerId);
}

export async function acquireNodeMutex(params: {
  executionId: string;
  workflowId: string;
  userId: string;
  nodeId: string;
  ownerId: string;
  leaseSeconds?: number;
}): Promise<LockAcquireResult> {
  const db = createServiceClient();
  const leaseSeconds = params.leaseSeconds ?? 30;
  const now = new Date();

  const { data: existing } = await db
    .from('runtime_node_mutexes')
    .select('owner_id, lease_expires_at, lock_version')
    .eq('execution_id', params.executionId)
    .eq('node_id', params.nodeId)
    .limit(1)
    .maybeSingle();

  if (!existing) {
    const { error } = await db.from('runtime_node_mutexes').insert({
      execution_id: params.executionId,
      workflow_id: params.workflowId,
      user_id: params.userId,
      node_id: params.nodeId,
      owner_id: params.ownerId,
      lock_version: 1,
      lease_expires_at: addSeconds(now, leaseSeconds),
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    if (error) return { acquired: false, reason: error.message };
    return { acquired: true, version: 1 };
  }

  const leaseExpiresAt = new Date(String(existing.lease_expires_at));
  const ownedByOther = existing.owner_id && existing.owner_id !== params.ownerId;
  if (ownedByOther && leaseExpiresAt > now) {
    return { acquired: false, reason: 'Node mutex already held' };
  }

  const nextVersion = Number(existing.lock_version ?? 1) + 1;
  const { error } = await db
    .from('runtime_node_mutexes')
    .update({
      owner_id: params.ownerId,
      lock_version: nextVersion,
      lease_expires_at: addSeconds(now, leaseSeconds),
      updated_at: nowIso(),
    })
    .eq('execution_id', params.executionId)
    .eq('node_id', params.nodeId)
    .eq('lock_version', Number(existing.lock_version ?? 1));

  if (error) return { acquired: false, reason: error.message };
  return { acquired: true, version: nextVersion };
}

export async function releaseNodeMutex(params: {
  executionId: string;
  nodeId: string;
  ownerId: string;
}): Promise<void> {
  const db = createServiceClient();
  await db
    .from('runtime_node_mutexes')
    .delete()
    .eq('execution_id', params.executionId)
    .eq('node_id', params.nodeId)
    .eq('owner_id', params.ownerId);
}

export type OwnershipValidationResult =
  | { valid: true }
  | { valid: false; reason: 'OWNER_REPLACED' | 'LEASE_EXPIRED' | 'FENCED_OUT' | 'NOT_FOUND' };

export async function claimExecutionOwnership(params: {
  executionId: string;
  workflowId: string;
  userId: string;
  queueJobId?: string;
  workerId: string;
  leaseSeconds?: number;
}): Promise<{ claimed: boolean; ownerToken?: string; fencingToken?: number }> {
  const db = createServiceClient();
  const leaseSeconds = params.leaseSeconds ?? 45;
  const now = new Date();

  const { data: existing } = await db
    .from('runtime_execution_ownership')
    .select('worker_id, lease_expires_at, owner_token, fencing_token')
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId)
    .limit(1)
    .maybeSingle();

  if (existing) {
    const leaseExpiresAt = new Date(String(existing.lease_expires_at));
    if (existing.worker_id !== params.workerId && leaseExpiresAt > now) {
      return { claimed: false };
    }
  }

  const ownerToken = randomUUID();
  const existingFencingToken = Number((existing as Record<string, unknown> | null)?.fencing_token ?? 0);
  const nextFencingToken = existingFencingToken + 1;

  if (existing) {
    // Optimistic update: reject if a concurrent takeover incremented the token first.
    const { error } = await db
      .from('runtime_execution_ownership')
      .update({
        worker_id: params.workerId,
        owner_token: ownerToken,
        queue_job_id: params.queueJobId ?? null,
        lease_expires_at: addSeconds(now, leaseSeconds),
        heartbeat_at: nowIso(),
        state: 'active',
        fencing_token: nextFencingToken,
        updated_at: nowIso(),
      })
      .eq('execution_id', params.executionId)
      .eq('user_id', params.userId)
      .eq('fencing_token', existingFencingToken);

    if (error) return { claimed: false };
  } else {
    const { error } = await db.from('runtime_execution_ownership').insert({
      execution_id: params.executionId,
      workflow_id: params.workflowId,
      user_id: params.userId,
      queue_job_id: params.queueJobId ?? null,
      worker_id: params.workerId,
      owner_token: ownerToken,
      lease_expires_at: addSeconds(now, leaseSeconds),
      heartbeat_at: nowIso(),
      state: 'active',
      fencing_token: 1,
      metadata: {},
      updated_at: nowIso(),
    });

    if (error) return { claimed: false };
    void appendExecutionEvent({
      executionId: params.executionId,
      workflowId: params.workflowId,
      userId: params.userId,
      workerId: params.workerId,
      eventType: 'ownership_claimed',
      fencingToken: 1,
      payload: { worker_id: params.workerId, fencing_token: 1 },
    }).catch(() => undefined);
    return { claimed: true, ownerToken, fencingToken: 1 };
  }

  void appendExecutionEvent({
    executionId: params.executionId,
    workflowId: params.workflowId,
    userId: params.userId,
    workerId: params.workerId,
    eventType: 'ownership_claimed',
    fencingToken: nextFencingToken,
    payload: { worker_id: params.workerId, fencing_token: nextFencingToken },
  }).catch(() => undefined);
  return { claimed: true, ownerToken, fencingToken: nextFencingToken };
}

export async function validateExecutionOwnership(params: {
  executionId: string;
  userId: string;
  workerId: string;
  ownerToken: string;
  fencingToken: number;
}): Promise<OwnershipValidationResult> {
  const db = createServiceClient();
  const now = new Date();

  const { data } = await db
    .from('runtime_execution_ownership')
    .select('worker_id, owner_token, lease_expires_at, fencing_token, state')
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId)
    .limit(1)
    .maybeSingle();

  if (!data) return { valid: false, reason: 'NOT_FOUND' };

  const dbFencingToken = Number((data as Record<string, unknown>).fencing_token ?? 0);
  if (dbFencingToken > params.fencingToken) {
    void appendExecutionEvent({
      executionId: params.executionId,
      userId: params.userId,
      workerId: params.workerId,
      eventType: 'split_brain_prevented',
      fencingToken: dbFencingToken,
      payload: {
        stale_worker_id: params.workerId,
        authoritative_fencing_token: dbFencingToken,
        stale_fencing_token: params.fencingToken,
      },
    }).catch(() => undefined);
    return { valid: false, reason: 'FENCED_OUT' };
  }

  if (data.worker_id !== params.workerId || data.owner_token !== params.ownerToken) {
    return { valid: false, reason: 'OWNER_REPLACED' };
  }

  const leaseExpiresAt = new Date(String(data.lease_expires_at));
  if (leaseExpiresAt <= now) {
    return { valid: false, reason: 'LEASE_EXPIRED' };
  }

  return { valid: true };
}

export async function renewExecutionOwnership(params: {
  executionId: string;
  userId: string;
  workerId: string;
  ownerToken: string;
  leaseSeconds?: number;
}): Promise<boolean> {
  const db = createServiceClient();
  const leaseSeconds = params.leaseSeconds ?? 45;
  const { error } = await db
    .from('runtime_execution_ownership')
    .update({
      lease_expires_at: addSeconds(new Date(), leaseSeconds),
      heartbeat_at: nowIso(),
      updated_at: nowIso(),
    })
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId)
    .eq('worker_id', params.workerId)
    .eq('owner_token', params.ownerToken)
    .eq('state', 'active');

  return !error;
}

export async function releaseExecutionOwnership(params: {
  executionId: string;
  userId: string;
  workerId: string;
  ownerToken: string;
  state?: 'released' | 'orphaned' | 'failed_over';
}): Promise<void> {
  const db = createServiceClient();
  await db
    .from('runtime_execution_ownership')
    .update({
      state: params.state ?? 'released',
      lease_expires_at: nowIso(),
      heartbeat_at: nowIso(),
      updated_at: nowIso(),
    })
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId)
    .eq('worker_id', params.workerId)
    .eq('owner_token', params.ownerToken);

  const releaseEventType =
    params.state === 'orphaned' ? 'ownership_expired' as const :
    params.state === 'failed_over' ? 'ownership_replaced' as const :
    null;
  if (releaseEventType) {
    void appendExecutionEvent({
      executionId: params.executionId,
      userId: params.userId,
      workerId: params.workerId,
      eventType: releaseEventType,
      payload: { worker_id: params.workerId, state: params.state },
    }).catch(() => undefined);
  }
}

export async function recoverOrphanExecutions(params: {
  staleAfterMinutes?: number;
  limit?: number;
}): Promise<Array<{ executionId: string; userId: string; workflowId: string }>> {
  // Proactively reclaim any concurrency reservation left behind by a worker
  // that crashed before its finally-block release ran. Cheap, idempotent —
  // safe to run on every orphan-recovery sweep alongside the existing checks.
  await reclaimExpiredConcurrencyReservations().catch(() => 0);

  const db = createServiceClient();
  const staleAfterMinutes = params.staleAfterMinutes ?? 3;
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60 * 1000).toISOString();
  const now = new Date();

  const { data: ownership } = await db
    .from('runtime_execution_ownership')
    .select('execution_id, user_id, workflow_id, lease_expires_at, heartbeat_at, state')
    .eq('state', 'active')
    .limit(params.limit ?? 50);

  const rows = ((ownership ?? []) as Array<{
    execution_id: string;
    user_id: string;
    workflow_id: string;
    lease_expires_at?: string;
    heartbeat_at?: string;
  }>).filter((row) => {
    const leaseExpired = row.lease_expires_at ? new Date(row.lease_expires_at) < now : true;
    const heartbeatStale = row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() < cutoff : true;
    return leaseExpired || heartbeatStale;
  });

  const recovered: Array<{ executionId: string; userId: string; workflowId: string }> = [];
  for (const row of rows) {
    await db
      .from('runtime_execution_ownership')
      .update({
        state: 'orphaned',
        updated_at: nowIso(),
      })
      .eq('execution_id', row.execution_id)
      .eq('user_id', row.user_id)
      .eq('state', 'active');

    await db
      .from('workflow_executions_v2')
      .update({
        status: 'waiting',
        error_message: 'Recovered orphan execution. Awaiting resume.',
        updated_at: nowIso(),
      })
      .eq('id', row.execution_id)
      .eq('user_id', row.user_id)
      .eq('status', 'running');

    recovered.push({
      executionId: row.execution_id,
      userId: row.user_id,
      workflowId: row.workflow_id,
    });
  }

  return recovered;
}

export async function cleanupExpiredRuntimeLocks(): Promise<void> {
  const db = createServiceClient();
  const now = nowIso();
  await db.from('runtime_node_mutexes').delete().lt('lease_expires_at', now);
}

export async function markOrphanExecutionsFailed(params?: {
  staleAfterMinutes?: number;
  limit?: number;
}): Promise<number> {
  const db = createServiceClient();
  const staleAfterMinutes = params?.staleAfterMinutes ?? 10;
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60 * 1000).toISOString();

  const { data } = await db
    .from('workflow_executions_v2')
    .select('id, user_id')
    .eq('status', 'running')
    .lt('updated_at', cutoff)
    .limit(params?.limit ?? 50);

  const rows = (data ?? []) as Array<{ id: string; user_id: string }>;
  if (rows.length === 0) return 0;

  for (const row of rows) {
    await db
      .from('workflow_executions_v2')
      .update({
        status: 'failed',
        error_message: 'worker timeout',
        updated_at: nowIso(),
      })
      .eq('id', row.id)
      .eq('user_id', row.user_id)
      .eq('status', 'running');
  }

  return rows.length;
}
