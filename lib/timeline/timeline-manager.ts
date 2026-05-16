import { createServiceClient } from '@/lib/supabase-server';

export type TimelineEventType =
  | 'workflow_generated'
  | 'integration_connected'
  | 'credentials_required'
  | 'test_succeeded'
  | 'deployment_completed'
  | 'retry_attempt'
  | 'failure_recovered'
  | 'rollback_executed';

export type TimelineEvent = {
  id: string;
  userId: string;
  sessionId: string;
  workflowId?: string;
  eventType: TimelineEventType;
  title: string;
  description?: string;
  status: 'info' | 'success' | 'warning' | 'error';
  metadata: any;
  internalEventId?: string;
  createdAt: string;
};

export class TimelineManager {
  private db = createServiceClient();

  // Event Creation
  async recordEvent(
    userId: string,
    sessionId: string,
    eventType: TimelineEventType,
    title: string,
    options: {
      workflowId?: string;
      description?: string;
      status?: 'info' | 'success' | 'warning' | 'error';
      metadata?: any;
      internalEventId?: string;
    } = {}
  ): Promise<TimelineEvent> {
    const event = {
      user_id: userId,
      session_id: sessionId,
      workflow_id: options.workflowId || null,
      event_type: eventType,
      title,
      description: options.description || null,
      status: options.status || 'info',
      metadata: options.metadata || {},
      internal_event_id: options.internalEventId || null
    };

    const { data, error } = await this.db
      .from('timeline_events')
      .insert(event)
      .select()
      .single();

    if (error) throw error;

    return this.transformEvent(data);
  }

  // Event Retrieval
  async getSessionTimeline(
    userId: string,
    sessionId: string,
    limit: number = 100
  ): Promise<TimelineEvent[]> {
    const { data } = await this.db
      .from('timeline_events')
      .select('*')
      .eq('user_id', userId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(limit);

    return data ? data.map(this.transformEvent) : [];
  }

  async getWorkflowTimeline(
    userId: string,
    workflowId: string,
    limit: number = 100
  ): Promise<TimelineEvent[]> {
    const { data } = await this.db
      .from('timeline_events')
      .select('*')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .order('created_at', { ascending: false })
      .limit(limit);

    return data ? data.map(this.transformEvent) : [];
  }

  async getUserTimeline(
    userId: string,
    options: {
      eventType?: TimelineEventType;
      status?: 'info' | 'success' | 'warning' | 'error';
      limit?: number;
      since?: Date;
    } = {}
  ): Promise<TimelineEvent[]> {
    let query = this.db
      .from('timeline_events')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (options.eventType) {
      query = query.eq('event_type', options.eventType);
    }

    if (options.status) {
      query = query.eq('status', options.status);
    }

    if (options.since) {
      query = query.gte('created_at', options.since.toISOString());
    }

    const { data } = await query.limit(options.limit || 50);
    return data ? data.map(this.transformEvent) : [];
  }

  // Specialized Event Creators
  async recordWorkflowGenerated(
    userId: string,
    sessionId: string,
    workflowId: string,
    workflowName: string,
    nodeCount: number
  ): Promise<TimelineEvent> {
    return this.recordEvent(
      userId,
      sessionId,
      'workflow_generated',
      `Workflow "${workflowName}" generated`,
      {
        workflowId,
        description: `Created workflow with ${nodeCount} nodes`,
        status: 'success',
        metadata: { workflowName, nodeCount }
      }
    );
  }

  async recordIntegrationConnected(
    userId: string,
    sessionId: string,
    workflowId: string,
    provider: string
  ): Promise<TimelineEvent> {
    return this.recordEvent(
      userId,
      sessionId,
      'integration_connected',
      `${provider} connected`,
      {
        workflowId,
        description: `Successfully connected to ${provider}`,
        status: 'success',
        metadata: { provider }
      }
    );
  }

  async recordCredentialsRequired(
    userId: string,
    sessionId: string,
    workflowId: string,
    provider: string,
    reason: string
  ): Promise<TimelineEvent> {
    return this.recordEvent(
      userId,
      sessionId,
      'credentials_required',
      `${provider} credentials needed`,
      {
        workflowId,
        description: reason,
        status: 'warning',
        metadata: { provider, reason }
      }
    );
  }

  async recordTestSucceeded(
    userId: string,
    sessionId: string,
    workflowId: string,
    testName: string,
    executionTime: number
  ): Promise<TimelineEvent> {
    return this.recordEvent(
      userId,
      sessionId,
      'test_succeeded',
      `Test "${testName}" passed`,
      {
        workflowId,
        description: `Completed in ${executionTime}ms`,
        status: 'success',
        metadata: { testName, executionTime }
      }
    );
  }

  async recordDeploymentCompleted(
    userId: string,
    sessionId: string,
    workflowId: string,
    deploymentId: string,
    n8nWorkflowId?: string
  ): Promise<TimelineEvent> {
    return this.recordEvent(
      userId,
      sessionId,
      'deployment_completed',
      'Workflow deployed successfully',
      {
        workflowId,
        description: n8nWorkflowId ? `Deployed to n8n (${n8nWorkflowId})` : 'Deployment completed',
        status: 'success',
        metadata: { deploymentId, n8nWorkflowId }
      }
    );
  }

  async recordRetryAttempt(
    userId: string,
    sessionId: string,
    workflowId: string,
    action: string,
    attemptNumber: number,
    maxRetries: number
  ): Promise<TimelineEvent> {
    return this.recordEvent(
      userId,
      sessionId,
      'retry_attempt',
      `Retrying ${action} (${attemptNumber}/${maxRetries})`,
      {
        workflowId,
        description: `Attempt ${attemptNumber} of ${maxRetries}`,
        status: 'warning',
        metadata: { action, attemptNumber, maxRetries }
      }
    );
  }

  async recordFailureRecovered(
    userId: string,
    sessionId: string,
    workflowId: string,
    failureType: string,
    recoveryAction: string
  ): Promise<TimelineEvent> {
    return this.recordEvent(
      userId,
      sessionId,
      'failure_recovered',
      `Recovered from ${failureType}`,
      {
        workflowId,
        description: `Applied recovery action: ${recoveryAction}`,
        status: 'success',
        metadata: { failureType, recoveryAction }
      }
    );
  }

  async recordRollbackExecuted(
    userId: string,
    sessionId: string,
    workflowId: string,
    rollbackReason: string,
    previousVersion: number
  ): Promise<TimelineEvent> {
    return this.recordEvent(
      userId,
      sessionId,
      'rollback_executed',
      'Workflow rolled back',
      {
        workflowId,
        description: `Rolled back to version ${previousVersion}: ${rollbackReason}`,
        status: 'info',
        metadata: { rollbackReason, previousVersion }
      }
    );
  }

  // Timeline Summary
  async getTimelineSummary(
    userId: string,
    sessionId: string
  ): Promise<{
    totalEvents: number;
    successCount: number;
    warningCount: number;
    errorCount: number;
    recentEvents: TimelineEvent[];
  }> {
    const events = await this.getSessionTimeline(userId, sessionId, 100);

    const summary = {
      totalEvents: events.length,
      successCount: events.filter(e => e.status === 'success').length,
      warningCount: events.filter(e => e.status === 'warning').length,
      errorCount: events.filter(e => e.status === 'error').length,
      recentEvents: events.slice(0, 10)
    };

    return summary;
  }

  // Map Internal Events to Timeline
  async mapRuntimeEventToTimeline(
    userId: string,
    sessionId: string,
    internalEvent: any
  ): Promise<void> {
    const eventType = internalEvent.event_type || internalEvent.type;
    const workflowId = internalEvent.workflow_id;

    switch (eventType) {
      case 'workflow_created':
        await this.recordWorkflowGenerated(
          userId,
          sessionId,
          workflowId,
          internalEvent.workflow_name || 'Workflow',
          internalEvent.node_count || 0
        );
        break;

      case 'integration_connected':
        await this.recordIntegrationConnected(
          userId,
          sessionId,
          workflowId,
          internalEvent.provider
        );
        break;

      case 'credentials_requested':
        await this.recordCredentialsRequired(
          userId,
          sessionId,
          workflowId,
          internalEvent.provider,
          internalEvent.reason
        );
        break;

      case 'test_completed':
        if (internalEvent.success) {
          await this.recordTestSucceeded(
            userId,
            sessionId,
            workflowId,
            internalEvent.test_name || 'Workflow Test',
            internalEvent.execution_time || 0
          );
        }
        break;

      case 'deployment_succeeded':
        await this.recordDeploymentCompleted(
          userId,
          sessionId,
          workflowId,
          internalEvent.deployment_id,
          internalEvent.n8n_workflow_id
        );
        break;

      case 'retry_started':
        await this.recordRetryAttempt(
          userId,
          sessionId,
          workflowId,
          internalEvent.action,
          internalEvent.attempt_number || 1,
          internalEvent.max_retries || 3
        );
        break;

      case 'recovery_applied':
        await this.recordFailureRecovered(
          userId,
          sessionId,
          workflowId,
          internalEvent.failure_type,
          internalEvent.recovery_action
        );
        break;

      case 'rollback_completed':
        await this.recordRollbackExecuted(
          userId,
          sessionId,
          workflowId,
          internalEvent.rollback_reason,
          internalEvent.previous_version
        );
        break;
    }
  }

  private transformEvent(data: any): TimelineEvent {
    return {
      id: data.id,
      userId: data.user_id,
      sessionId: data.session_id,
      workflowId: data.workflow_id,
      eventType: data.event_type,
      title: data.title,
      description: data.description,
      status: data.status,
      metadata: data.metadata,
      internalEventId: data.internal_event_id,
      createdAt: data.created_at
    };
  }
}

export const timelineManager = new TimelineManager();