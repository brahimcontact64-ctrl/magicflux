import { createServiceClient } from '@/lib/supabase-server';

export type WorkflowGraphVersion = {
  id: string;
  userId: string;
  workflowId: string;
  version: number;
  graphData: any;
  changesDescription?: string;
  changedBy: string;
  isActive: boolean;
  layoutPositions: any;
  nodeStates: any;
  createdAt: string;
};

export type GraphMutation = {
  type: 'add_node' | 'remove_node' | 'update_node' | 'add_edge' | 'remove_edge' | 'update_edge' | 'reconnect';
  nodeId?: string;
  edgeId?: string;
  nodeData?: any;
  edgeData?: any;
  sourceId?: string;
  targetId?: string;
  description: string;
};

export class LiveGraphManager {
  private db = createServiceClient();

  // Version Management
  async createGraphVersion(
    userId: string,
    workflowId: string,
    graphData: any,
    options: {
      changesDescription?: string;
      changedBy?: string;
      layoutPositions?: any;
      nodeStates?: any;
    } = {}
  ): Promise<WorkflowGraphVersion> {
    // Get next version number
    const { data: existingVersions } = await this.db
      .from('workflow_graph_versions')
      .select('version')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .order('version', { ascending: false })
      .limit(1);

    const nextVersion = existingVersions && existingVersions.length > 0 ? existingVersions[0].version + 1 : 1;

    // Deactivate previous version
    if (nextVersion > 1) {
      await this.db
        .from('workflow_graph_versions')
        .update({ is_active: false })
        .eq('user_id', userId)
        .eq('workflow_id', workflowId);
    }

    const version = {
      user_id: userId,
      workflow_id: workflowId,
      version: nextVersion,
      graph_data: graphData,
      changes_description: options.changesDescription || null,
      changed_by: options.changedBy || 'ai',
      is_active: true,
      layout_positions: options.layoutPositions || {},
      node_states: options.nodeStates || {}
    };

    const { data, error } = await this.db
      .from('workflow_graph_versions')
      .insert(version)
      .select()
      .single();

    if (error) throw error;

    return this.transformVersion(data);
  }

  async getActiveGraphVersion(
    userId: string,
    workflowId: string
  ): Promise<WorkflowGraphVersion | null> {
    const { data } = await this.db
      .from('workflow_graph_versions')
      .select('*')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .eq('is_active', true)
      .single();

    return data ? this.transformVersion(data) : null;
  }

  async getGraphVersions(
    userId: string,
    workflowId: string,
    limit: number = 10
  ): Promise<WorkflowGraphVersion[]> {
    const { data } = await this.db
      .from('workflow_graph_versions')
      .select('*')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .order('version', { ascending: false })
      .limit(limit);

    return data ? data.map(this.transformVersion) : [];
  }

  async rollbackToVersion(
    userId: string,
    workflowId: string,
    version: number
  ): Promise<WorkflowGraphVersion> {
    // Get the version to rollback to
    const { data: versionData } = await this.db
      .from('workflow_graph_versions')
      .select('*')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .eq('version', version)
      .single();

    if (!versionData) throw new Error('Version not found');

    // Create new active version
    return this.createGraphVersion(
      userId,
      workflowId,
      versionData.graph_data,
      {
        changesDescription: `Rolled back to version ${version}`,
        changedBy: 'user',
        layoutPositions: versionData.layout_positions,
        nodeStates: versionData.node_states
      }
    );
  }

  // Live Mutations
  async applyMutation(
    userId: string,
    workflowId: string,
    mutation: GraphMutation
  ): Promise<WorkflowGraphVersion> {
    const currentVersion = await this.getActiveGraphVersion(userId, workflowId);
    if (!currentVersion) throw new Error('No active graph version found');

    const newGraphData = this.applyMutationToGraph(currentVersion.graphData, mutation);

    return this.createGraphVersion(
      userId,
      workflowId,
      newGraphData,
      {
        changesDescription: mutation.description,
        changedBy: 'user',
        layoutPositions: currentVersion.layoutPositions,
        nodeStates: currentVersion.nodeStates
      }
    );
  }

  // Specific Mutation Types
  async addNode(
    userId: string,
    workflowId: string,
    nodeData: any,
    position?: { x: number; y: number }
  ): Promise<WorkflowGraphVersion> {
    const mutation: GraphMutation = {
      type: 'add_node',
      nodeData: {
        ...nodeData,
        position: position || { x: 100, y: 100 }
      },
      description: `Added ${nodeData.label || 'node'}`
    };

    return this.applyMutation(userId, workflowId, mutation);
  }

  async removeNode(
    userId: string,
    workflowId: string,
    nodeId: string
  ): Promise<WorkflowGraphVersion> {
    const mutation: GraphMutation = {
      type: 'remove_node',
      nodeId,
      description: `Removed node ${nodeId}`
    };

    return this.applyMutation(userId, workflowId, mutation);
  }

  async updateNode(
    userId: string,
    workflowId: string,
    nodeId: string,
    updates: any
  ): Promise<WorkflowGraphVersion> {
    const mutation: GraphMutation = {
      type: 'update_node',
      nodeId,
      nodeData: updates,
      description: `Updated node ${nodeId}`
    };

    return this.applyMutation(userId, workflowId, mutation);
  }

  async addEdge(
    userId: string,
    workflowId: string,
    sourceId: string,
    targetId: string,
    edgeData?: any
  ): Promise<WorkflowGraphVersion> {
    const mutation: GraphMutation = {
      type: 'add_edge',
      sourceId,
      targetId,
      edgeData: edgeData || {},
      description: `Connected ${sourceId} to ${targetId}`
    };

    return this.applyMutation(userId, workflowId, mutation);
  }

  async removeEdge(
    userId: string,
    workflowId: string,
    edgeId: string
  ): Promise<WorkflowGraphVersion> {
    const mutation: GraphMutation = {
      type: 'remove_edge',
      edgeId,
      description: `Removed connection ${edgeId}`
    };

    return this.applyMutation(userId, workflowId, mutation);
  }

  // AI-Powered Mutations
  async applyAIMutation(
    userId: string,
    workflowId: string,
    userRequest: string,
    currentGraph: any
  ): Promise<WorkflowGraphVersion> {
    // This would integrate with the AI agent to interpret natural language
    // and apply appropriate mutations to the graph
    // For now, we'll create a placeholder that the AI can fill in

    const mutations = await this.interpretUserRequest(userRequest, currentGraph);

    let updatedGraph = currentGraph;
    for (const mutation of mutations) {
      updatedGraph = this.applyMutationToGraph(updatedGraph, mutation);
    }

    return this.createGraphVersion(
      userId,
      workflowId,
      updatedGraph,
      {
        changesDescription: `AI applied: ${userRequest}`,
        changedBy: 'ai'
      }
    );
  }

  // Layout and State Management
  async updateLayoutPositions(
    userId: string,
    workflowId: string,
    positions: Record<string, { x: number; y: number }>
  ): Promise<void> {
    await this.db
      .from('workflow_graph_versions')
      .update({
        layout_positions: positions,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .eq('is_active', true);
  }

  async updateNodeStates(
    userId: string,
    workflowId: string,
    states: Record<string, any>
  ): Promise<void> {
    await this.db
      .from('workflow_graph_versions')
      .update({
        node_states: states,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .eq('is_active', true);
  }

  // Helper Methods
  private applyMutationToGraph(graphData: any, mutation: GraphMutation): any {
    const newGraph = { ...graphData };
    newGraph.nodes = [...(newGraph.nodes || [])];
    newGraph.edges = [...(newGraph.edges || [])];

    switch (mutation.type) {
      case 'add_node':
        if (mutation.nodeData) {
          newGraph.nodes.push({
            id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            ...mutation.nodeData
          });
        }
        break;

      case 'remove_node':
        if (mutation.nodeId) {
          newGraph.nodes = newGraph.nodes.filter((node: any) => node.id !== mutation.nodeId);
          newGraph.edges = newGraph.edges.filter((edge: any) =>
            edge.source !== mutation.nodeId && edge.target !== mutation.nodeId
          );
        }
        break;

      case 'update_node':
        if (mutation.nodeId && mutation.nodeData) {
          const nodeIndex = newGraph.nodes.findIndex((node: any) => node.id === mutation.nodeId);
          if (nodeIndex !== -1) {
            newGraph.nodes[nodeIndex] = { ...newGraph.nodes[nodeIndex], ...mutation.nodeData };
          }
        }
        break;

      case 'add_edge':
        if (mutation.sourceId && mutation.targetId) {
          newGraph.edges.push({
            id: `edge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            source: mutation.sourceId,
            target: mutation.targetId,
            ...mutation.edgeData
          });
        }
        break;

      case 'remove_edge':
        if (mutation.edgeId) {
          newGraph.edges = newGraph.edges.filter((edge: any) => edge.id !== mutation.edgeId);
        }
        break;

      case 'reconnect':
        // Handle edge reconnection logic
        break;
    }

    return newGraph;
  }

  private async interpretUserRequest(userRequest: string, currentGraph: any): Promise<GraphMutation[]> {
    // This would use AI to interpret the user's natural language request
    // and generate appropriate mutations
    // For now, return empty array - this would be implemented with the AI agent
    return [];
  }

  private transformVersion(data: any): WorkflowGraphVersion {
    return {
      id: data.id,
      userId: data.user_id,
      workflowId: data.workflow_id,
      version: data.version,
      graphData: data.graph_data,
      changesDescription: data.changes_description,
      changedBy: data.changed_by,
      isActive: data.is_active,
      layoutPositions: data.layout_positions || {},
      nodeStates: data.node_states || {},
      createdAt: data.created_at
    };
  }
}

export const liveGraphManager = new LiveGraphManager();