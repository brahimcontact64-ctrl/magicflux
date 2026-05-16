import { deleteWorkflow, type N8nConfig } from '@/lib/ai-engine/n8n-deployer';
import { createServiceClient } from '@/lib/supabase-server';

export type RetryResult<T> = {
  value?: T;
  attempts: number;
  error?: string;
};

export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  options?: { retries?: number; baseDelayMs?: number; maxDelayMs?: number }
): Promise<RetryResult<T>> {
  const retries = options?.retries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 400;
  const maxDelayMs = options?.maxDelayMs ?? 5000;

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const value = await fn();
      return { value, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt > retries) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return {
    attempts: retries + 1,
    error: lastError ?? 'Unknown error',
  };
}

export async function beginDeployTransaction(params: {
  userId: string | null;
  sessionId: string;
  workflowName?: string;
  dryRun: boolean;
  sandbox: boolean;
  snapshotBefore?: Record<string, unknown>;
}): Promise<string | null> {
  if (!params.userId) return null;
  const db = createServiceClient();
  const { data } = await db
    .from('agent_deploy_transactions')
    .insert({
      user_id: params.userId,
      session_id: params.sessionId,
      workflow_name: params.workflowName ?? null,
      status: 'started',
      dry_run: params.dryRun,
      sandbox: params.sandbox,
      snapshot_before: params.snapshotBefore ?? null,
      started_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  return data?.id ?? null;
}

export async function updateDeployTransaction(params: {
  transactionId: string | null;
  patch: Record<string, unknown>;
}): Promise<void> {
  if (!params.transactionId) return;
  const db = createServiceClient();
  await db
    .from('agent_deploy_transactions')
    .update({ ...params.patch, updated_at: new Date().toISOString() })
    .eq('id', params.transactionId);
}

export async function rollbackWorkflowCreation(params: {
  n8n: N8nConfig;
  workflowId?: string;
}): Promise<{ rolledBack: boolean; message: string }> {
  if (!params.workflowId) {
    return { rolledBack: false, message: 'No workflow id available for rollback.' };
  }

  try {
    await deleteWorkflow(params.n8n, params.workflowId);
    return { rolledBack: true, message: `Rolled back workflow ${params.workflowId}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { rolledBack: false, message: `Rollback failed: ${message}` };
  }
}
