import {
  activateWorkflow,
  createWorkflow,
  deactivateWorkflow,
  getWorkflowStatus,
  type N8nConfig,
  type WorkflowDeployPayload,
} from '@/lib/ai-engine/n8n-deployer';

export class N8nRuntimeDeployer {
  constructor(private readonly config: N8nConfig) {}

  async deployDraft(payload: WorkflowDeployPayload): Promise<{ workflowId: string; workflowUrl: string }> {
    const result = await createWorkflow(this.config, payload);
    if (result.status === 'error' || !result.workflowId) {
      throw new Error(result.error ?? 'Failed to create n8n workflow');
    }

    return {
      workflowId: result.workflowId,
      workflowUrl: result.workflowUrl,
    };
  }

  async activate(workflowId: string): Promise<void> {
    await activateWorkflow(this.config, workflowId);
  }

  async deactivate(workflowId: string): Promise<void> {
    await deactivateWorkflow(this.config, workflowId);
  }

  async health(workflowId: string): Promise<{ healthy: boolean; active: boolean; updatedAt: string }> {
    const status = await getWorkflowStatus(this.config, workflowId);
    return {
      healthy: true,
      active: status.active,
      updatedAt: status.updatedAt,
    };
  }
}
