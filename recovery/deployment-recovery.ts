import { DeploymentManager } from '@/lib/deployment/deployment-manager';
import { emitRuntimeEvent } from '@/lib/runtime/events';

export class DeploymentRecoveryEngine {
  private readonly deploymentManager = new DeploymentManager();

  async recoverFromFailure(params: {
    userId: string;
    workflowId: string;
    sessionId?: string;
    reason: string;
  }): Promise<{ success: boolean; rollbackVersion?: number; message: string }> {
    const rollback = await this.deploymentManager.autoRollbackOnFailure(
      params.userId,
      params.workflowId,
      params.reason
    );

    if (!rollback.success) {
      await emitRuntimeEvent({
        eventType: 'deployment.failed',
        userId: params.userId,
        workflowId: params.workflowId,
        sessionId: params.sessionId,
        severity: 'error',
        payload: { reason: params.reason, error: rollback.error ?? 'Rollback failed' },
      });

      return {
        success: false,
        message: rollback.error ?? 'Rollback failed',
      };
    }

    await emitRuntimeEvent({
      eventType: 'deployment.rolled_back',
      userId: params.userId,
      workflowId: params.workflowId,
      sessionId: params.sessionId,
      severity: 'warning',
      payload: {
        reason: params.reason,
        rollbackVersion: rollback.previousVersion,
      },
    });

    return {
      success: true,
      rollbackVersion: rollback.previousVersion,
      message: `Rolled back to deployment version ${rollback.previousVersion}`,
    };
  }
}
