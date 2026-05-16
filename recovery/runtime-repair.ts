import { createServiceClient } from '@/lib/supabase-server';
import { emitRuntimeEvent } from '@/lib/runtime/events';
import { applyProviderFallback } from './provider-fallback';

export type RuntimeRepairResult = {
  repaired: boolean;
  strategy: 'provider_fallback' | 'retry_with_backoff' | 'config_patch' | 'none';
  message: string;
  patchedWorkflow?: Record<string, unknown>;
};

function classify(errorMessage: string): 'provider_failure' | 'rate_limit' | 'invalid_config' | 'unknown' {
  const lower = errorMessage.toLowerCase();
  if (lower.includes('provider') || lower.includes('openai') || lower.includes('anthropic')) return 'provider_failure';
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) return 'rate_limit';
  if (lower.includes('invalid') || lower.includes('schema') || lower.includes('missing field')) return 'invalid_config';
  return 'unknown';
}

export class RuntimeRepairEngine {
  private db = createServiceClient();

  async attemptRepair(params: {
    userId: string;
    workflowId: string;
    sessionId: string;
    errorMessage: string;
    workflowJson: Record<string, unknown>;
  }): Promise<RuntimeRepairResult> {
    const reason = classify(params.errorMessage);

    if (reason === 'provider_failure') {
      const workflow = params.workflowJson as { nodes?: Array<Record<string, unknown>> };
      const nodes = (workflow.nodes ?? []) as Array<{ id?: string; name?: string; type?: string; parameters?: Record<string, unknown> }>;

      const fallback = applyProviderFallback(nodes, 'openai');
      if (fallback.changedNodeIds.length > 0) {
        const patchedWorkflow = {
          ...params.workflowJson,
          nodes: fallback.nextNodes,
        };

        await this.db
          .from('workflows')
          .update({ workflow_json: patchedWorkflow, updated_at: new Date().toISOString() })
          .eq('id', params.workflowId)
          .eq('user_id', params.userId);

        await emitRuntimeEvent({
          eventType: 'retry.started',
          userId: params.userId,
          workflowId: params.workflowId,
          sessionId: params.sessionId,
          severity: 'warning',
          payload: {
            strategy: 'provider_fallback',
            changedNodeIds: fallback.changedNodeIds,
            fallbackProvider: fallback.resolvedProvider,
          },
        });

        return {
          repaired: true,
          strategy: 'provider_fallback',
          message: `Switched provider to ${fallback.resolvedProvider}`,
          patchedWorkflow,
        };
      }
    }

    if (reason === 'rate_limit') {
      return {
        repaired: true,
        strategy: 'retry_with_backoff',
        message: 'Rate limit detected. Retry with exponential backoff.',
      };
    }

    if (reason === 'invalid_config') {
      return {
        repaired: true,
        strategy: 'config_patch',
        message: 'Config issue detected. Requesting automatic node config repair.',
      };
    }

    return {
      repaired: false,
      strategy: 'none',
      message: 'No automatic repair strategy matched.',
    };
  }
}
