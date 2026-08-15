import 'server-only';

import { createHash } from 'crypto';
import { createServiceClient } from '@/lib/supabase-server';

/**
 * Provider-native trigger idempotency.
 *
 * Phase 8's webhook route derived its idempotency key purely from a hash of
 * the request body (`${workflowId}:${bodyHash}`). That works, but it throws
 * away a strictly better signal when the caller already provides one:
 * Shopify's X-Shopify-Webhook-Id is unique per delivery attempt-group and
 * stable across Shopify's own retries, so it dedupes retried deliveries of
 * the *same* logical event even when Shopify varies the body's timestamp
 * fields between attempts (which defeats a body-hash key). A generic
 * Idempotency-Key header (already a de facto standard — Stripe, GitHub, and
 * most modern webhook senders support it) gets the same treatment. Only
 * when neither is present do we fall back to the payload hash.
 *
 * Every derived key is prefixed with the workflowId, which is globally
 * unique per row (and a workflow belongs to exactly one user) — so even
 * though the underlying uniqueness constraint (runtime_execution_locks'
 * idempotency_key partial unique index, added in Phase 7-era migrations) is
 * not itself scoped by user_id, a raw event ID colliding across two
 * different users' workflows can never produce the same composite key,
 * because their workflowId components differ. See
 * tests/idempotency.test.ts for the cross-tenant/cross-workflow proof.
 */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function hashBody(rawBody: string): string {
  return createHash('sha256').update(rawBody || '').digest('hex');
}

export type WebhookIdempotencySource = 'shopify_webhook_id' | 'idempotency_key_header' | 'payload_hash';

export type WebhookIdempotencyResult = {
  key: string;
  source: WebhookIdempotencySource;
};

/**
 * Derives the idempotency key for an incoming production webhook request.
 * Priority: Shopify's native delivery ID > a generic Idempotency-Key header
 * supplied by the caller > a deterministic hash of the raw body.
 */
export function deriveWebhookIdempotencyKey(params: {
  workflowId: string;
  rawBody: string;
  headers: { get(name: string): string | null };
}): WebhookIdempotencyResult {
  const shopifyId = params.headers.get('x-shopify-webhook-id')?.trim();
  if (shopifyId) {
    return { key: `webhook:${params.workflowId}:shopify:${shopifyId}`, source: 'shopify_webhook_id' };
  }

  const genericKey = params.headers.get('idempotency-key')?.trim();
  if (genericKey) {
    return { key: `webhook:${params.workflowId}:idem:${genericKey}`, source: 'idempotency_key_header' };
  }

  return { key: `webhook:${params.workflowId}:hash:${hashBody(params.rawBody)}`, source: 'payload_hash' };
}

/** Scheduler firings are already deterministically keyed by (schedule, fire time) — kept here as the single source of truth for the format. */
export function deriveScheduleIdempotencyKey(params: { scheduleId: string; firingTimestamp: string }): string {
  return `schedule:${params.scheduleId}:${params.firingTimestamp}`;
}

/** Deterministic fallback for any trigger type that has neither a provider event ID nor a natural key. */
export function derivePayloadHashIdempotencyKey(params: { workflowId: string; scope: string; payload: unknown }): string {
  return `${params.scope}:${params.workflowId}:hash:${hashBody(stableStringify(params.payload))}`;
}

export type ExistingExecutionForIdempotencyKey = {
  executionId: string;
  status: string;
};

/**
 * Atomically reserves an idempotency key by inserting a runtime_execution_locks
 * row keyed on the caller-supplied executionId (not yet the winner unless the
 * insert succeeds). If a row with the same idempotency_key already exists,
 * the insert fails with a unique-violation (23505) and the pre-existing
 * execution is looked up and returned instead — this is a single atomic
 * round trip, not a check-then-insert race: the database's unique index is
 * the sole arbiter of "first writer wins."
 */
export async function reserveIdempotencyKey(params: {
  executionId: string;
  userId: string;
  workflowId: string;
  idempotencyKey: string;
  leaseSeconds?: number;
}): Promise<{ isDuplicate: false } | { isDuplicate: true; existing: ExistingExecutionForIdempotencyKey | null }> {
  const db = createServiceClient();
  const leaseSeconds = params.leaseSeconds ?? 45;

  const { error } = await db.from('runtime_execution_locks').insert({
    execution_id: params.executionId,
    user_id: params.userId,
    workflow_id: params.workflowId,
    idempotency_key: params.idempotencyKey,
    owner_id: null,
    lock_version: 1,
    lease_expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
    last_status: 'running',
    metadata: {},
  });

  if (!error) return { isDuplicate: false };

  if (error.code !== '23505') {
    // Not a duplicate-key conflict — a genuine DB failure. Treat conservatively
    // as "cannot confirm uniqueness" rather than silently allowing a possible duplicate.
    throw new Error(`Failed to reserve idempotency key: ${error.message}`);
  }

  const { data: winner } = await db
    .from('runtime_execution_locks')
    .select('execution_id')
    .eq('idempotency_key', params.idempotencyKey)
    .limit(1)
    .maybeSingle();

  if (!winner?.execution_id) return { isDuplicate: true, existing: null };

  const { data: exec } = await db
    .from('workflow_executions_v2')
    .select('id, status')
    .eq('id', winner.execution_id)
    .eq('user_id', params.userId)
    .limit(1)
    .maybeSingle();

  if (!exec) return { isDuplicate: true, existing: null };

  return { isDuplicate: true, existing: { executionId: exec.id, status: String(exec.status) } };
}

/**
 * Releases a reserved idempotency key that never became a real execution
 * (e.g. concurrency was denied immediately after the key was reserved).
 * Without this, a legitimately-retriable event would be permanently
 * poisoned: every future delivery of the same event would find the orphaned
 * lock row, treat it as a duplicate, and fail to look up a real execution.
 * Never call this once a workflow_executions_v2 row has actually been
 * created for the execution_id — at that point the lock row is meaningful
 * (it points at a real, if possibly failed, execution) and must stay.
 */
export async function releaseIdempotencyKey(params: { executionId: string; userId: string }): Promise<void> {
  const db = createServiceClient();
  await db
    .from('runtime_execution_locks')
    .delete()
    .eq('execution_id', params.executionId)
    .eq('user_id', params.userId);
}
