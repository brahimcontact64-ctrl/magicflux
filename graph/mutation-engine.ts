import { createServiceClient } from '@/lib/supabase-server';
import { emitRuntimeEvent } from '@/lib/runtime/events';
import { diffGraphs, type GraphEdge, type GraphNode, type WorkflowGraph } from './graph-diff';
import { recalculateLayout } from './layout-engine';

type MutationAction =
  | { type: 'add_node'; node: GraphNode; connectFrom?: string; connectTo?: string }
  | { type: 'remove_node'; nodeId: string }
  | { type: 'update_node'; nodeId: string; patch: Partial<GraphNode> }
  | { type: 'add_edge'; edge: GraphEdge }
  | { type: 'remove_edge'; edgeId: string }
  | { type: 'replace_provider'; from: string; to: string }
  | { type: 'insert_before'; targetNodeId: string; node: GraphNode };

export class GraphMutationEngine {
  private db = createServiceClient();

  private async getActiveGraph(userId: string, workflowId: string): Promise<{ version: number; graph: WorkflowGraph } | null> {
    const { data } = await this.db
      .from('workflow_graph_versions')
      .select('version, graph_data')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (!data) return null;

    return {
      version: Number(data.version ?? 1),
      graph: (data.graph_data ?? { nodes: [], edges: [] }) as WorkflowGraph,
    };
  }

  private mutate(graph: WorkflowGraph, action: MutationAction): WorkflowGraph {
    const next: WorkflowGraph = {
      nodes: [...graph.nodes],
      edges: [...graph.edges],
    };

    if (action.type === 'add_node') {
      next.nodes.push(action.node);
      if (action.connectFrom) {
        next.edges.push({
          id: `${action.connectFrom}->${action.node.id}`,
          source: action.connectFrom,
          target: action.node.id,
        });
      }
      if (action.connectTo) {
        next.edges.push({
          id: `${action.node.id}->${action.connectTo}`,
          source: action.node.id,
          target: action.connectTo,
        });
      }
      return next;
    }

    if (action.type === 'remove_node') {
      next.nodes = next.nodes.filter((node) => node.id !== action.nodeId);
      next.edges = next.edges.filter((edge) => edge.source !== action.nodeId && edge.target !== action.nodeId);
      return next;
    }

    if (action.type === 'update_node') {
      next.nodes = next.nodes.map((node) => (node.id === action.nodeId ? { ...node, ...action.patch } : node));
      return next;
    }

    if (action.type === 'add_edge') {
      next.edges.push(action.edge);
      return next;
    }

    if (action.type === 'remove_edge') {
      next.edges = next.edges.filter((edge) => edge.id !== action.edgeId);
      return next;
    }

    if (action.type === 'replace_provider') {
      const from = action.from.toLowerCase();
      const to = action.to.toLowerCase();
      next.nodes = next.nodes.map((node) => {
        const nodeType = String(node.type ?? '').toLowerCase();
        if (!nodeType.includes(from)) return node;
        return {
          ...node,
          type: String(node.type ?? '').replace(new RegExp(from, 'ig'), to),
        };
      });
      return next;
    }

    if (action.type === 'insert_before') {
      const incoming = next.edges.filter((edge) => edge.target === action.targetNodeId);
      next.nodes.push(action.node);
      next.edges = next.edges.filter((edge) => edge.target !== action.targetNodeId);

      for (const edge of incoming) {
        next.edges.push({
          id: `${edge.source}->${action.node.id}`,
          source: edge.source,
          target: action.node.id,
        });
      }

      next.edges.push({
        id: `${action.node.id}->${action.targetNodeId}`,
        source: action.node.id,
        target: action.targetNodeId,
      });
      return next;
    }

    return next;
  }

  async applyMutation(params: {
    userId: string;
    workflowId: string;
    sessionId: string;
    action: MutationAction;
    reason: string;
    actor?: 'ai' | 'user' | 'system';
  }): Promise<{
    version: number;
    graph: WorkflowGraph;
    diff: ReturnType<typeof diffGraphs>;
  }> {
    const active = await this.getActiveGraph(params.userId, params.workflowId);
    const currentGraph = active?.graph ?? { nodes: [], edges: [] };

    const mutated = this.mutate(currentGraph, params.action);
    const laidOut = recalculateLayout(mutated);
    const diff = diffGraphs(currentGraph, laidOut);

    await this.db
      .from('workflow_graph_versions')
      .update({ is_active: false })
      .eq('user_id', params.userId)
      .eq('workflow_id', params.workflowId)
      .eq('is_active', true);

    const version = (active?.version ?? 0) + 1;

    await this.db.from('workflow_graph_versions').insert({
      user_id: params.userId,
      workflow_id: params.workflowId,
      version,
      graph_data: laidOut,
      changes_description: params.reason,
      changed_by: params.actor ?? 'ai',
      is_active: true,
      layout_positions: Object.fromEntries(laidOut.nodes.map((node) => [node.id, node.position ?? { x: 0, y: 0 }])),
      node_states: {},
      created_at: new Date().toISOString(),
    });

    await this.db.from('workflow_graph_mutations').insert({
      user_id: params.userId,
      workflow_id: params.workflowId,
      version,
      mutation_type: params.action.type,
      reason: params.reason,
      patch: params.action,
      diff,
      created_at: new Date().toISOString(),
    });

    await this.db
      .from('workflows')
      .update({ workflow_json: laidOut, updated_at: new Date().toISOString() })
      .eq('id', params.workflowId)
      .eq('user_id', params.userId);

    await emitRuntimeEvent({
      eventType: 'workflow.mutated',
      userId: params.userId,
      workflowId: params.workflowId,
      sessionId: params.sessionId,
      severity: 'info',
      payload: {
        version,
        mutationType: params.action.type,
        reason: params.reason,
        changedNodes: diff.updatedNodes.length + diff.addedNodes.length + diff.removedNodes.length,
      },
    });

    return {
      version,
      graph: laidOut,
      diff,
    };
  }
}
