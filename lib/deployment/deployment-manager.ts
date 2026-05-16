import { createServiceClient } from '@/lib/supabase-server';

function n8nConfig(): { apiUrl: string; apiKey: string } {
  return {
    apiUrl: process.env.N8N_API_URL ?? '',
    apiKey: process.env.N8N_API_KEY ?? '',
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export type DeploymentVersion = {
  id: string;
  userId: string;
  workflowId: string;
  version: number;
  deploymentId: string;
  n8nWorkflowId?: string;
  status: 'pending' | 'deploying' | 'failed' | 'active' | 'rolled_back' | 'superseded';
  deployedAt: string;
  rolledBackAt?: string;
  rollbackReason?: string;
  workflowData: any;
  metadata: any;
  createdAt: string;
};

export type RollbackResult = {
  success: boolean;
  previousVersion: number;
  rollbackReason: string;
  error?: string;
};

export class DeploymentManager {
  private db = createServiceClient();

  // Deployment Versioning
  async recordDeployment(
    userId: string,
    workflowId: string,
    deploymentId: string,
    workflowData: any,
    options: {
      n8nWorkflowId?: string;
      metadata?: any;
    } = {}
  ): Promise<DeploymentVersion> {
    // Get next version number
    const { data: existingVersions } = await this.db
      .from('deployment_versions')
      .select('version')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .order('version', { ascending: false })
      .limit(1);

    const nextVersion = existingVersions && existingVersions.length > 0 ? existingVersions[0].version + 1 : 1;

    // Mark previous active deployment as superseded
    await this.db
      .from('deployment_versions')
      .update({ status: 'superseded' })
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .eq('status', 'active');

    const deployment = {
      user_id: userId,
      workflow_id: workflowId,
      version: nextVersion,
      deployment_id: deploymentId,
      n8n_workflow_id: options.n8nWorkflowId || null,
      status: 'active',
      deployed_at: new Date().toISOString(),
      workflow_data: workflowData,
      metadata: options.metadata || {}
    };

    const { data, error } = await this.db
      .from('deployment_versions')
      .insert(deployment)
      .select()
      .single();

    if (error) throw error;

    return this.transformDeployment(data);
  }

  async getActiveDeployment(
    userId: string,
    workflowId: string
  ): Promise<DeploymentVersion | null> {
    const { data } = await this.db
      .from('deployment_versions')
      .select('*')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .eq('status', 'active')
      .single();

    return data ? this.transformDeployment(data) : null;
  }

  async getDeploymentVersions(
    userId: string,
    workflowId: string,
    limit: number = 10
  ): Promise<DeploymentVersion[]> {
    const { data } = await this.db
      .from('deployment_versions')
      .select('*')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .order('version', { ascending: false })
      .limit(limit);

    return data ? data.map(this.transformDeployment) : [];
  }

  // Rollback Management
  async rollbackDeployment(
    userId: string,
    workflowId: string,
    targetVersion: number,
    rollbackReason: string
  ): Promise<RollbackResult> {
    try {
      // Get the target version to rollback to
      const { data: targetDeployment } = await this.db
        .from('deployment_versions')
        .select('*')
        .eq('user_id', userId)
        .eq('workflow_id', workflowId)
        .eq('version', targetVersion)
        .single();

      if (!targetDeployment) {
        return {
          success: false,
          previousVersion: targetVersion,
          rollbackReason,
          error: 'Target deployment version not found'
        };
      }

      // Mark current active deployment as rolled back
      const currentTime = new Date().toISOString();
      await this.db
        .from('deployment_versions')
        .update({
          status: 'rolled_back',
          rolled_back_at: currentTime,
          rollback_reason: rollbackReason
        })
        .eq('user_id', userId)
        .eq('workflow_id', workflowId)
        .eq('status', 'active');

      // Activate the target version
      await this.db
        .from('deployment_versions')
        .update({ status: 'active' })
        .eq('user_id', userId)
        .eq('workflow_id', workflowId)
        .eq('version', targetVersion);

      // Attempt to rollback in n8n if workflow ID exists
      if (targetDeployment.n8n_workflow_id) {
        await this.rollbackN8nWorkflow(targetDeployment.n8n_workflow_id, targetDeployment.workflow_data);
      }

      await this.db.from('deployment_snapshots').insert({
        user_id: userId,
        workflow_id: workflowId,
        deployment_version: targetVersion,
        snapshot_type: 'rollback_point',
        workflow_data: targetDeployment.workflow_data,
        metadata: { rollbackReason },
        created_at: new Date().toISOString(),
      });

      return {
        success: true,
        previousVersion: targetVersion,
        rollbackReason
      };

    } catch (error) {
      return {
        success: false,
        previousVersion: targetVersion,
        rollbackReason,
        error: error instanceof Error ? error.message : 'Rollback failed'
      };
    }
  }

  async autoRollbackOnFailure(
    userId: string,
    workflowId: string,
    failureReason: string
  ): Promise<RollbackResult> {
    // Get the most recent successful deployment (skip the current failed one)
    const { data: successfulDeployments } = await this.db
      .from('deployment_versions')
      .select('*')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .neq('status', 'rolled_back')
      .order('version', { ascending: false })
      .limit(2);

    if (!successfulDeployments || successfulDeployments.length < 2) {
      return {
        success: false,
        previousVersion: 0,
        rollbackReason: failureReason,
        error: 'No previous successful deployment found for rollback'
      };
    }

    const previousDeployment = successfulDeployments[1]; // Skip the current failed one

    return this.rollbackDeployment(
      userId,
      workflowId,
      previousDeployment.version,
      `Auto-rollback due to failure: ${failureReason}`
    );
  }

  // N8n Integration
  private async rollbackN8nWorkflow(n8nWorkflowId: string, workflowData: any): Promise<void> {
    const cfg = n8nConfig();
    if (!cfg.apiUrl || !cfg.apiKey) {
      throw new Error('N8N_API_URL or N8N_API_KEY missing for rollback');
    }

    const base = cfg.apiUrl.replace(/\/$/, '');
    const response = await fetch(`${base}/api/v1/workflows/${n8nWorkflowId}`, {
      method: 'PUT',
      headers: {
        'X-N8N-API-KEY': cfg.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        ...(workflowData ?? {}),
        id: n8nWorkflowId,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Failed to rollback n8n workflow: ${response.status} ${body}`);
    }
  }

  // Deployment History
  async getDeploymentHistory(
    userId: string,
    workflowId: string,
    options: {
      includeRolledBack?: boolean;
      limit?: number;
    } = {}
  ): Promise<DeploymentVersion[]> {
    let query = this.db
      .from('deployment_versions')
      .select('*')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .order('version', { ascending: false });

    if (!options.includeRolledBack) {
      query = query.neq('status', 'rolled_back');
    }

    const { data } = await query.limit(options.limit || 20);
    return data ? data.map(this.transformDeployment) : [];
  }

  // Health Checks
  async checkDeploymentHealth(
    userId: string,
    workflowId: string
  ): Promise<{
    isHealthy: boolean;
    activeVersion: number;
    lastDeployment: string;
    issues: string[];
  }> {
    const activeDeployment = await this.getActiveDeployment(userId, workflowId);

    if (!activeDeployment) {
      return {
        isHealthy: false,
        activeVersion: 0,
        lastDeployment: '',
        issues: ['No active deployment found']
      };
    }

    const issues: string[] = [];

    // Check if deployment is recent (within last 24 hours)
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    if (new Date(activeDeployment.deployedAt) < oneDayAgo) {
      issues.push('Deployment is older than 24 hours');
    }

    // Check for recent rollbacks
    const recentVersions = await this.getDeploymentVersions(userId, workflowId, 5);
    const rollbackCount = recentVersions.filter(v => v.status === 'rolled_back').length;

    if (rollbackCount > 2) {
      issues.push('Multiple recent rollbacks detected');
    }

    return {
      isHealthy: issues.length === 0,
      activeVersion: activeDeployment.version,
      lastDeployment: activeDeployment.deployedAt,
      issues
    };
  }

  // Cleanup old deployments (keep only recent ones)
  async cleanupOldDeployments(
    userId: string,
    workflowId: string,
    keepVersions: number = 10
  ): Promise<void> {
    // Get versions to delete (older than the keep limit)
    const { data: versionsToDelete } = await this.db
      .from('deployment_versions')
      .select('id')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .order('version', { ascending: false })
      .range(keepVersions, 1000); // Skip the first N, delete the rest

    if (versionsToDelete && versionsToDelete.length > 0) {
      await this.db
        .from('deployment_versions')
        .delete()
        .in('id', versionsToDelete.map(v => v.id));
    }
  }

  async compareDeploymentVersions(params: {
    userId: string;
    workflowId: string;
    leftVersion: number;
    rightVersion: number;
  }): Promise<{
    leftVersion: number;
    rightVersion: number;
    changed: boolean;
    summary: {
      nodesChanged: boolean;
      connectionsChanged: boolean;
      metadataChanged: boolean;
    };
  }> {
    const { data: rows } = await this.db
      .from('deployment_versions')
      .select('version, workflow_data, metadata')
      .eq('user_id', params.userId)
      .eq('workflow_id', params.workflowId)
      .in('version', [params.leftVersion, params.rightVersion]);

    const left = (rows ?? []).find((r) => Number(r.version) === params.leftVersion);
    const right = (rows ?? []).find((r) => Number(r.version) === params.rightVersion);

    if (!left || !right) {
      throw new Error('One or both deployment versions not found');
    }

    const leftWorkflow = (left.workflow_data ?? {}) as Record<string, unknown>;
    const rightWorkflow = (right.workflow_data ?? {}) as Record<string, unknown>;

    const nodesChanged = stableStringify(leftWorkflow.nodes ?? []) !== stableStringify(rightWorkflow.nodes ?? []);
    const connectionsChanged = stableStringify(leftWorkflow.connections ?? {}) !== stableStringify(rightWorkflow.connections ?? {});
    const metadataChanged = stableStringify(left.metadata ?? {}) !== stableStringify(right.metadata ?? {});

    return {
      leftVersion: params.leftVersion,
      rightVersion: params.rightVersion,
      changed: nodesChanged || connectionsChanged || metadataChanged,
      summary: {
        nodesChanged,
        connectionsChanged,
        metadataChanged,
      },
    };
  }

  private transformDeployment(data: any): DeploymentVersion {
    return {
      id: data.id,
      userId: data.user_id,
      workflowId: data.workflow_id,
      version: data.version,
      deploymentId: data.deployment_id,
      n8nWorkflowId: data.n8n_workflow_id,
      status: data.status,
      deployedAt: data.deployed_at,
      rolledBackAt: data.rolled_back_at,
      rollbackReason: data.rollback_reason,
      workflowData: data.workflow_data,
      metadata: data.metadata,
      createdAt: data.created_at
    };
  }
}

export const deploymentManager = new DeploymentManager();