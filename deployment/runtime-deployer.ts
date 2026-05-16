import { createServiceClient } from '@/lib/supabase-server';
import { DeploymentManager } from '@/lib/deployment/deployment-manager';
import { emitRuntimeEvent } from '@/lib/runtime/events';
import type { N8nConfig } from '@/lib/ai-engine/n8n-deployer';
import { N8nRuntimeDeployer } from './n8n-deployer';
import { DeploymentHealthMonitor } from './health-monitor';

export class RuntimeDeployer {
  private readonly db = createServiceClient();
  private readonly deploymentManager = new DeploymentManager();
  private readonly healthMonitor = new DeploymentHealthMonitor();

  async deploy(params: {
    userId: string;
    workflowId: string;
    sessionId: string;
    workflowName: string;
    workflowData: { nodes: object[]; connections: object };
    n8n: N8nConfig;
    autoActivate?: boolean;
  }): Promise<{
    deploymentId: string;
    n8nWorkflowId: string;
    workflowUrl: string;
    activated: boolean;
  }> {
    const deployer = new N8nRuntimeDeployer(params.n8n);

    const activeBefore = await this.deploymentManager.getActiveDeployment(params.userId, params.workflowId);

    await emitRuntimeEvent({
      eventType: 'deployment.started',
      userId: params.userId,
      workflowId: params.workflowId,
      sessionId: params.sessionId,
      severity: 'info',
      payload: { workflowName: params.workflowName },
    });

    await this.db.from('deployment_snapshots').insert({
      user_id: params.userId,
      workflow_id: params.workflowId,
      deployment_version: activeBefore?.version ?? 0,
      snapshot_type: 'pre_activation',
      workflow_data: activeBefore?.workflowData ?? params.workflowData,
      metadata: {
        stage: 'pre_activation',
        previousDeploymentId: activeBefore?.deploymentId ?? null,
      },
      created_at: new Date().toISOString(),
    });

    const created = await deployer.deployDraft({
      name: params.workflowName,
      nodes: params.workflowData.nodes,
      connections: params.workflowData.connections,
      settings: { executionOrder: 'v1' },
      active: false,
    });

    const deploymentVersion = await this.deploymentManager.recordDeployment(
      params.userId,
      params.workflowId,
      `deploy-${Date.now()}`,
      params.workflowData,
      {
        n8nWorkflowId: created.workflowId,
        metadata: {
          workflowUrl: created.workflowUrl,
          autoActivate: Boolean(params.autoActivate),
        },
      }
    );

    let activated = false;
    if (params.autoActivate) {
      await deployer.activate(created.workflowId);
      activated = true;

      const health = await this.healthMonitor.checkDeployment({
        userId: params.userId,
        workflowId: params.workflowId,
        sessionId: params.sessionId,
        n8n: params.n8n,
        n8nWorkflowId: created.workflowId,
      });

      if (!health.healthy) {
        await deployer.deactivate(created.workflowId);
        await this.deploymentManager.rollbackDeployment(
          params.userId,
          params.workflowId,
          activeBefore?.version ?? deploymentVersion.version,
          `Health gate failed after activation: ${health.message}`
        );

        throw new Error(`Deployment health gate failed: ${health.message}`);
      }
    }

    await this.db
      .from('workflows')
      .update({
        status: 'deployed',
        n8n_workflow_id: created.workflowId,
        deployed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.workflowId)
      .eq('user_id', params.userId);

    await emitRuntimeEvent({
      eventType: 'deployment.completed',
      userId: params.userId,
      workflowId: params.workflowId,
      sessionId: params.sessionId,
      severity: 'info',
      payload: {
        deploymentVersion: deploymentVersion.version,
        n8nWorkflowId: created.workflowId,
        workflowUrl: created.workflowUrl,
        activated,
      },
    });

    await this.db.from('deployment_snapshots').insert({
      user_id: params.userId,
      workflow_id: params.workflowId,
      deployment_version: deploymentVersion.version,
      snapshot_type: 'post_activation',
      workflow_data: params.workflowData,
      metadata: {
        stage: 'post_activation',
        activated,
        n8nWorkflowId: created.workflowId,
      },
      created_at: new Date().toISOString(),
    });

    return {
      deploymentId: deploymentVersion.deploymentId,
      n8nWorkflowId: created.workflowId,
      workflowUrl: created.workflowUrl,
      activated,
    };
  }
}
