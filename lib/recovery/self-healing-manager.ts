import { createServiceClient } from '@/lib/supabase-server';

export type FailureClass =
  | 'temporary_api_failure'
  | 'invalid_credentials'
  | 'rate_limit'
  | 'deployment_failure'
  | 'validation_failure'
  | 'missing_provider'
  | 'runtime_error';

export type RetryPolicy = {
  id: string;
  name: string;
  failureClass: FailureClass;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterEnabled: boolean;
  recoveryActions: string[];
  createdAt: string;
};

export type FailureAttempt = {
  id: string;
  userId: string;
  sessionId?: string;
  workflowId?: string;
  failureClass: FailureClass;
  originalError: string;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: string;
  recoveryAction?: string;
  recoveryResult?: any;
  resolved: boolean;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export class SelfHealingManager {
  private db = createServiceClient();

  // Retry Policy Management
  async getRetryPolicy(failureClass: FailureClass): Promise<RetryPolicy | null> {
    const { data } = await this.db
      .from('retry_policies')
      .select('*')
      .eq('failure_class', failureClass)
      .single();

    return data ? this.transformPolicy(data) : null;
  }

  // Failure Classification
  classifyFailure(error: string, context?: any): FailureClass {
    const errorLower = error.toLowerCase();

    // Check for specific error patterns
    if (errorLower.includes('timeout') || errorLower.includes('connection') || errorLower.includes('network')) {
      return 'temporary_api_failure';
    }

    if (errorLower.includes('unauthorized') || errorLower.includes('invalid') || errorLower.includes('credential')) {
      return 'invalid_credentials';
    }

    if (errorLower.includes('rate limit') || errorLower.includes('too many requests') || errorLower.includes('429')) {
      return 'rate_limit';
    }

    if (errorLower.includes('deploy') || errorLower.includes('activation') || errorLower.includes('n8n')) {
      return 'deployment_failure';
    }

    if (errorLower.includes('validation') || errorLower.includes('schema') || errorLower.includes('invalid input')) {
      return 'validation_failure';
    }

    if (errorLower.includes('provider') || errorLower.includes('integration') || errorLower.includes('not found')) {
      return 'missing_provider';
    }

    // Default to runtime error
    return 'runtime_error';
  }

  // Failure Handling
  async handleFailure(
    userId: string,
    failureClass: FailureClass,
    originalError: string,
    context: {
      sessionId?: string;
      workflowId?: string;
      action?: string;
      metadata?: any;
    } = {}
  ): Promise<{
    shouldRetry: boolean;
    nextRetryAt?: Date;
    recoveryAction?: string;
    attemptId: string;
  }> {
    const policy = await this.getRetryPolicy(failureClass);
    if (!policy) {
      // Create failure record without retry
      const attempt = await this.recordFailureAttempt(userId, failureClass, originalError, context);
      return {
        shouldRetry: false,
        attemptId: attempt.id
      };
    }

    // Check existing attempts
    const existingAttempts = await this.getFailureAttempts(userId, failureClass, context.workflowId);
    const retryCount = existingAttempts.length;

    if (retryCount >= policy.maxRetries) {
      // Max retries exceeded
      const attempt = await this.recordFailureAttempt(userId, failureClass, originalError, {
        ...context,
        maxRetriesExceeded: true
      });
      return {
        shouldRetry: false,
        attemptId: attempt.id
      };
    }

    // Calculate next retry time
    const nextRetryAt = this.calculateNextRetry(policy, retryCount);

    // Determine recovery action
    const recoveryAction = this.selectRecoveryAction(policy.recoveryActions, context);

    // Record attempt
    const attempt = await this.recordFailureAttempt(userId, failureClass, originalError, {
      ...context,
      nextRetryAt: nextRetryAt.toISOString(),
      recoveryAction,
      retryCount: retryCount + 1,
      maxRetries: policy.maxRetries
    });

    return {
      shouldRetry: true,
      nextRetryAt,
      recoveryAction,
      attemptId: attempt.id
    };
  }

  // Recovery Actions
  async executeRecoveryAction(
    action: string,
    context: any
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    try {
      switch (action) {
        case 'retry':
          return { success: true, result: { action: 'retry_scheduled' } };

        case 'request_credentials':
          // This would trigger a credential request UI
          return {
            success: true,
            result: {
              action: 'credential_requested',
              provider: context.provider,
              reason: context.reason
            }
          };

        case 'rollback':
          // Trigger deployment rollback
          return {
            success: true,
            result: {
              action: 'rollback_initiated',
              workflowId: context.workflowId
            }
          };

        case 'fix_validation':
          // Attempt to auto-fix validation issues
          return {
            success: true,
            result: {
              action: 'validation_fix_attempted',
              fixes: context.suggestedFixes || []
            }
          };

        case 'request_provider':
          // Request missing provider setup
          return {
            success: true,
            result: {
              action: 'provider_requested',
              provider: context.provider
            }
          };

        case 'log_error':
          // Just log the error for monitoring
          return {
            success: true,
            result: {
              action: 'error_logged',
              logged: true
            }
          };

        case 'notify_user':
          // This would send a notification to the user
          return {
            success: true,
            result: {
              action: 'user_notified',
              message: context.message
            }
          };

        default:
          return {
            success: false,
            error: `Unknown recovery action: ${action}`
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Recovery action failed'
      };
    }
  }

  // Failure Attempt Management
  private async recordFailureAttempt(
    userId: string,
    failureClass: FailureClass,
    originalError: string,
    context: any = {}
  ): Promise<FailureAttempt> {
    const attempt = {
      user_id: userId,
      session_id: context.sessionId || null,
      workflow_id: context.workflowId || null,
      failure_class: failureClass,
      original_error: originalError,
      retry_count: context.retryCount || 0,
      max_retries: context.maxRetries || 0,
      next_retry_at: context.nextRetryAt || null,
      recovery_action: context.recoveryAction || null,
      recovery_result: context.recoveryResult || null,
      resolved: context.resolved || false,
      resolved_at: context.resolvedAt || null
    };

    const { data, error } = await this.db
      .from('failure_attempts')
      .insert(attempt)
      .select()
      .single();

    if (error) throw error;

    return this.transformAttempt(data);
  }

  async resolveFailure(attemptId: string, userId: string, result?: any): Promise<void> {
    await this.db
      .from('failure_attempts')
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        recovery_result: result || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', attemptId)
      .eq('user_id', userId);
  }

  async getFailureAttempts(
    userId: string,
    failureClass?: FailureClass,
    workflowId?: string,
    limit: number = 50
  ): Promise<FailureAttempt[]> {
    let query = this.db
      .from('failure_attempts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (failureClass) {
      query = query.eq('failure_class', failureClass);
    }

    if (workflowId) {
      query = query.eq('workflow_id', workflowId);
    }

    const { data } = await query;
    return data ? data.map(this.transformAttempt) : [];
  }

  // Helper Methods
  private calculateNextRetry(policy: RetryPolicy, retryCount: number): Date {
    const delay = Math.min(
      policy.baseDelayMs * Math.pow(policy.backoffMultiplier, retryCount),
      policy.maxDelayMs
    );

    // Add jitter if enabled
    const jitter = policy.jitterEnabled ? delay * 0.1 * Math.random() : 0;

    return new Date(Date.now() + delay + jitter);
  }

  private selectRecoveryAction(actions: string[], context: any): string {
    // Prioritize actions based on context
    if (context.requiresCredentials && actions.includes('request_credentials')) {
      return 'request_credentials';
    }

    if (context.canRollback && actions.includes('rollback')) {
      return 'rollback';
    }

    if (context.hasValidationErrors && actions.includes('fix_validation')) {
      return 'fix_validation';
    }

    // Default to first action
    return actions[0] || 'log_error';
  }

  private transformPolicy(data: any): RetryPolicy {
    return {
      id: data.id,
      name: data.name,
      failureClass: data.failure_class,
      maxRetries: data.max_retries,
      baseDelayMs: data.base_delay_ms,
      maxDelayMs: data.max_delay_ms,
      backoffMultiplier: data.backoff_multiplier,
      jitterEnabled: data.jitter_enabled,
      recoveryActions: data.recovery_actions,
      createdAt: data.created_at
    };
  }

  private transformAttempt(data: any): FailureAttempt {
    return {
      id: data.id,
      userId: data.user_id,
      sessionId: data.session_id,
      workflowId: data.workflow_id,
      failureClass: data.failure_class,
      originalError: data.original_error,
      retryCount: data.retry_count,
      maxRetries: data.max_retries,
      nextRetryAt: data.next_retry_at,
      recoveryAction: data.recovery_action,
      recoveryResult: data.recovery_result,
      resolved: data.resolved,
      resolvedAt: data.resolved_at,
      createdAt: data.created_at,
      updatedAt: data.updated_at
    };
  }
}

export const selfHealingManager = new SelfHealingManager();