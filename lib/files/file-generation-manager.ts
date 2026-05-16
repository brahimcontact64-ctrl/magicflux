import { createServiceClient } from '@/lib/supabase-server';

export type FileType =
  | 'workflow_json'
  | 'env_template'
  | 'setup_guide'
  | 'schema_snippet'
  | 'n8n_export'
  | 'integration_config'
  | 'dashboard_scaffold';

export type GeneratedFile = {
  id: string;
  userId: string;
  workflowId?: string;
  sessionId: string;
  fileType: FileType;
  fileName: string;
  filePath?: string;
  content: string;
  metadata: any;
  version: number;
  isActive: boolean;
  generatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type FileVersion = {
  id: string;
  fileId: string;
  version: number;
  content: string;
  changesDescription?: string;
  createdBy: string;
  createdAt: string;
};

export class FileGenerationManager {
  private db = createServiceClient();

  // File Generation
  async generateFile(
    userId: string,
    sessionId: string,
    fileType: FileType,
    fileName: string,
    content: string,
    metadata: any = {},
    options: {
      workflowId?: string;
      generatedBy?: string;
    } = {}
  ): Promise<GeneratedFile> {
    // Get next version number
    const { data: existingFiles } = await this.db
      .from('generated_files')
      .select('version')
      .eq('user_id', userId)
      .eq('file_name', fileName)
      .eq('file_type', fileType)
      .order('version', { ascending: false })
      .limit(1);

    const nextVersion = existingFiles && existingFiles.length > 0 ? existingFiles[0].version + 1 : 1;

    // Deactivate previous version
    if (nextVersion > 1) {
      await this.db
        .from('generated_files')
        .update({ is_active: false })
        .eq('user_id', userId)
        .eq('file_name', fileName)
        .eq('file_type', fileType);
    }

    const file = {
      user_id: userId,
      workflow_id: options.workflowId || null,
      session_id: sessionId,
      file_type: fileType,
      file_name: fileName,
      content,
      metadata,
      version: nextVersion,
      is_active: true,
      generated_by: options.generatedBy || 'ai'
    };

    const { data, error } = await this.db
      .from('generated_files')
      .insert(file)
      .select()
      .single();

    if (error) throw error;

    // Create version record
    await this.db.from('generated_file_versions').insert({
      file_id: data.id,
      version: nextVersion,
      content,
      created_by: options.generatedBy || 'ai'
    });

    return this.transformFile(data);
  }

  // File Retrieval
  async getFile(fileId: string, userId: string): Promise<GeneratedFile | null> {
    const { data } = await this.db
      .from('generated_files')
      .select('*')
      .eq('id', fileId)
      .eq('user_id', userId)
      .single();

    return data ? this.transformFile(data) : null;
  }

  async getActiveFile(
    userId: string,
    fileName: string,
    fileType: FileType
  ): Promise<GeneratedFile | null> {
    const { data } = await this.db
      .from('generated_files')
      .select('*')
      .eq('user_id', userId)
      .eq('file_name', fileName)
      .eq('file_type', fileType)
      .eq('is_active', true)
      .single();

    return data ? this.transformFile(data) : null;
  }

  async getUserFiles(
    userId: string,
    fileType?: FileType,
    workflowId?: string,
    limit: number = 50
  ): Promise<GeneratedFile[]> {
    let query = this.db
      .from('generated_files')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (fileType) {
      query = query.eq('file_type', fileType);
    }

    if (workflowId) {
      query = query.eq('workflow_id', workflowId);
    }

    const { data } = await query;
    return data ? data.map(this.transformFile) : [];
  }

  // File Versioning
  async getFileVersions(fileId: string, userId: string): Promise<FileVersion[]> {
    // First verify user owns the file
    const file = await this.getFile(fileId, userId);
    if (!file) return [];

    const { data } = await this.db
      .from('generated_file_versions')
      .select('*')
      .eq('file_id', fileId)
      .order('version', { ascending: false });

    return data ? data.map(this.transformVersion) : [];
  }

  async rollbackToVersion(
    fileId: string,
    version: number,
    userId: string,
    changesDescription?: string
  ): Promise<GeneratedFile> {
    // Get the version to rollback to
    const { data: versionData } = await this.db
      .from('generated_file_versions')
      .select('*')
      .eq('file_id', fileId)
      .eq('version', version)
      .single();

    if (!versionData) throw new Error('Version not found');

    // Deactivate current active version
    await this.db
      .from('generated_files')
      .update({ is_active: false })
      .eq('id', fileId)
      .eq('user_id', userId);

    // Create new active version
    const { data: fileData } = await this.db
      .from('generated_files')
      .select('*')
      .eq('id', fileId)
      .single();

    if (!fileData) throw new Error('File not found');

    const newVersion = fileData.version + 1;

    const updatedFile = {
      ...fileData,
      content: versionData.content,
      version: newVersion,
      is_active: true,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await this.db
      .from('generated_files')
      .insert(updatedFile)
      .select()
      .single();

    if (error) throw error;

    // Create version record
    await this.db.from('generated_file_versions').insert({
      file_id: fileId,
      version: newVersion,
      content: versionData.content,
      changes_description: changesDescription || `Rolled back to version ${version}`,
      created_by: 'user'
    });

    return this.transformFile(data);
  }

  // Specialized Generators
  async generateWorkflowJSON(
    userId: string,
    sessionId: string,
    workflowGraph: any,
    workflowName: string
  ): Promise<GeneratedFile> {
    const workflowJSON = {
      name: workflowName,
      nodes: workflowGraph.nodes || [],
      connections: workflowGraph.edges || [],
      settings: workflowGraph.settings || {},
      meta: {
        instanceId: `workflow_${Date.now()}`,
        generatedAt: new Date().toISOString(),
        generatedBy: 'MagicFlux AI'
      }
    };

    return this.generateFile(
      userId,
      sessionId,
      'workflow_json',
      `${workflowName}.json`,
      JSON.stringify(workflowJSON, null, 2),
      {
        workflowName,
        nodeCount: workflowGraph.nodes?.length || 0,
        connectionCount: workflowGraph.edges?.length || 0
      }
    );
  }

  async generateEnvTemplate(
    userId: string,
    sessionId: string,
    requiredIntegrations: string[],
    workflowName: string
  ): Promise<GeneratedFile> {
    const envVars: Record<string, string> = {};

    for (const integration of requiredIntegrations) {
      switch (integration) {
        case 'openai':
          envVars['OPENAI_API_KEY'] = 'sk-...';
          break;
        case 'gmail':
          envVars['GMAIL_CLIENT_ID'] = '...';
          envVars['GMAIL_CLIENT_SECRET'] = '...';
          envVars['GMAIL_REFRESH_TOKEN'] = '...';
          break;
        case 'slack':
          envVars['SLACK_BOT_TOKEN'] = 'xoxb-...';
          break;
        case 'shopify':
          envVars['SHOPIFY_STORE_DOMAIN'] = 'your-store.myshopify.com';
          envVars['SHOPIFY_ACCESS_TOKEN'] = '...';
          break;
        case 'stripe':
          envVars['STRIPE_SECRET_KEY'] = 'sk_test_...';
          envVars['STRIPE_WEBHOOK_SECRET'] = 'whsec_...';
          break;
      }
    }

    const envContent = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    return this.generateFile(
      userId,
      sessionId,
      'env_template',
      `${workflowName}.env.example`,
      envContent,
      {
        requiredIntegrations,
        envVarCount: Object.keys(envVars).length
      }
    );
  }

  async generateSetupGuide(
    userId: string,
    sessionId: string,
    workflowName: string,
    integrations: string[],
    steps: string[]
  ): Promise<GeneratedFile> {
    const guide = `# ${workflowName} Setup Guide

## Overview
This guide will help you set up the ${workflowName} automation workflow.

## Required Integrations
${integrations.map(integration => `- ${integration}`).join('\n')}

## Setup Steps
${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}

## Environment Variables
Copy the .env.example file and fill in your actual credentials.

## Deployment
1. Run the workflow JSON through n8n
2. Configure webhooks if needed
3. Test the workflow
4. Activate for production

## Troubleshooting
- Check the runtime logs in the dashboard
- Verify all credentials are correct
- Ensure integrations are properly connected

Generated by MagicFlux AI on ${new Date().toISOString()}
`;

    return this.generateFile(
      userId,
      sessionId,
      'setup_guide',
      `${workflowName}-setup.md`,
      guide,
      {
        workflowName,
        integrations,
        stepCount: steps.length
      }
    );
  }

  async generateN8nExport(
    userId: string,
    sessionId: string,
    workflowGraph: any,
    workflowName: string
  ): Promise<GeneratedFile> {
    const n8nWorkflow = {
      name: workflowName,
      nodes: (workflowGraph.nodes || []).map((node: any) => ({
        parameters: node.data?.parameters || {},
        name: node.data?.label || node.id,
        type: node.data?.type || 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [node.position?.x || 0, node.position?.y || 0],
        id: node.id
      })),
      connections: this.convertEdgesToN8nConnections(workflowGraph.edges || []),
      settings: {
        saveExecutionProgress: true,
        saveManualExecutions: true,
        saveDataErrorExecution: 'all',
        saveDataSuccessExecution: 'all'
      },
      meta: {
        instanceId: `n8n_${Date.now()}`
      }
    };

    return this.generateFile(
      userId,
      sessionId,
      'n8n_export',
      `${workflowName}.n8n-workflow.json`,
      JSON.stringify(n8nWorkflow, null, 2),
      {
        workflowName,
        nodeCount: workflowGraph.nodes?.length || 0,
        compatibleWith: 'n8n'
      }
    );
  }

  // Helper Methods
  private convertEdgesToN8nConnections(edges: any[]): any {
    const connections: any = {};

    for (const edge of edges) {
      const sourceId = edge.source;
      const targetId = edge.target;
      const sourceHandle = edge.sourceHandle || 'main';
      const targetHandle = edge.targetHandle || 'main';

      if (!connections[sourceId]) {
        connections[sourceId] = {};
      }
      if (!connections[sourceId][sourceHandle]) {
        connections[sourceId][sourceHandle] = [];
      }

      connections[sourceId][sourceHandle].push({
        node: targetId,
        type: 'main',
        index: 0
      });
    }

    return connections;
  }

  private transformFile(data: any): GeneratedFile {
    return {
      id: data.id,
      userId: data.user_id,
      workflowId: data.workflow_id,
      sessionId: data.session_id,
      fileType: data.file_type,
      fileName: data.file_name,
      filePath: data.file_path,
      content: data.content,
      metadata: data.metadata,
      version: data.version,
      isActive: data.is_active,
      generatedBy: data.generated_by,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  private transformVersion(data: any): FileVersion {
    return {
      id: data.id,
      fileId: data.file_id,
      version: data.version,
      content: data.content,
      changesDescription: data.changes_description,
      createdBy: data.created_by,
      createdAt: data.created_at,
    };
  }
}

export const fileGenerationManager = new FileGenerationManager();