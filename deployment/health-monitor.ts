import { createServiceClient } from '@/lib/supabase-server';
import { emitRuntimeEvent } from '@/lib/runtime/events';
import type { N8nConfig } from '@/lib/ai-engine/n8n-deployer';
import { N8nRuntimeDeployer } from './n8n-deployer';

export class DeploymentHealthMonitor {
  private readonly db = createServiceClient();

  async checkDeployment(params: {
    userId: string;
    workflowId: string;
    sessionId?: string;
    n8n: N8nConfig;
    n8nWorkflowId?: string;
  }): Promise<{ healthy: boolean; active: boolean; message: string }> {
    let n8nWorkflowId = String(params.n8nWorkflowId ?? '');
    if (!n8nWorkflowId) {
      const { data: workflow } = await this.db
        .from('workflows')
        .select('n8n_workflow_id')
        .eq('id', params.workflowId)
        .eq('user_id', params.userId)
        .limit(1)
        .maybeSingle();
      n8nWorkflowId = String(workflow?.n8n_workflow_id ?? '');
    }
    if (!n8nWorkflowId) {
      return {
        healthy: false,
        active: false,
        message: 'No n8n workflow linked to deployment.',
      };
    }

    const deployer = new N8nRuntimeDeployer(params.n8n);
    try {
      const status = await deployer.health(n8nWorkflowId);

      await emitRuntimeEvent({
        eventType: status.healthy ? 'deployment.completed' : 'deployment.failed',
        userId: params.userId,
        workflowId: params.workflowId,
        sessionId: params.sessionId,
        severity: status.healthy ? 'info' : 'error',
        payload: {
          n8nWorkflowId,
          active: status.active,
          updatedAt: status.updatedAt,
        },
      });

      return {
        healthy: status.healthy,
        active: status.active,
        message: status.healthy ? 'Deployment is healthy.' : 'Deployment health check failed.',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deployment health check failed';
      await emitRuntimeEvent({
        eventType: 'deployment.failed',
        userId: params.userId,
        workflowId: params.workflowId,
        sessionId: params.sessionId,
        severity: 'error',
        payload: {
          n8nWorkflowId,
          error: message,
        },
      });

      return {
        healthy: false,
        active: false,
        message,
      };
    }
  }
}
