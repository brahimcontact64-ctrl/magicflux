import { createServiceClient } from '@/lib/supabase-server';

export type MemoryType = 'workflow' | 'integration' | 'preference' | 'business_context' | 'goal' | 'error_fix' | 'deployment';

export type ProjectMemory = {
  id: string;
  userId: string;
  projectId: string;
  memoryType: MemoryType;
  key: string;
  value: any;
  context: any;
  importanceScore: number;
  lastAccessedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowMemory = {
  id: string;
  userId: string;
  workflowId: string;
  version: number;
  memoryType: string;
  key: string;
  value: any;
  context: any;
  createdAt: string;
};

export type AgentMemoryEvent = {
  id: string;
  userId: string;
  sessionId: string;
  workflowId?: string;
  agentName: string;
  eventType: 'decision' | 'success' | 'failure' | 'learning' | 'adaptation';
  actionTaken?: string;
  context: any;
  outcome: any;
  learnings: any;
  confidenceScore?: number;
  createdAt: string;
};

export class PersistentMemory {
  private db = createServiceClient();

  // Project Memory
  async saveProjectMemory(
    userId: string,
    projectId: string,
    memoryType: MemoryType,
    key: string,
    value: any,
    context: any = {},
    importanceScore: number = 0.5
  ): Promise<void> {
    await this.db.from('project_memory').upsert({
      user_id: userId,
      project_id: projectId,
      memory_type: memoryType,
      key,
      value,
      context,
      importance_score: importanceScore,
      last_accessed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id,project_id,memory_type,key'
    });
  }

  async getProjectMemory(
    userId: string,
    projectId: string,
    memoryType?: MemoryType,
    key?: string
  ): Promise<ProjectMemory[]> {
    let query = this.db
      .from('project_memory')
      .select('*')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .order('importance_score', { ascending: false })
      .order('last_accessed_at', { ascending: false });

    if (memoryType) {
      query = query.eq('memory_type', memoryType);
    }

    if (key) {
      query = query.eq('key', key);
    }

    const { data } = await query.limit(50);
    return data || [];
  }

  async updateMemoryAccess(userId: string, memoryId: string): Promise<void> {
    await this.db
      .from('project_memory')
      .update({ last_accessed_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('id', memoryId);
  }

  // Workflow Memory
  async saveWorkflowMemory(
    userId: string,
    workflowId: string,
    version: number,
    memoryType: string,
    key: string,
    value: any,
    context: any = {}
  ): Promise<void> {
    await this.db.from('workflow_memory').upsert({
      user_id: userId,
      workflow_id: workflowId,
      version,
      memory_type: memoryType,
      key,
      value,
      context
    }, {
      onConflict: 'user_id,workflow_id,version,memory_type,key'
    });
  }

  async getWorkflowMemory(
    userId: string,
    workflowId: string,
    version?: number
  ): Promise<WorkflowMemory[]> {
    let query = this.db
      .from('workflow_memory')
      .select('*')
      .eq('user_id', userId)
      .eq('workflow_id', workflowId)
      .order('created_at', { ascending: false });

    if (version) {
      query = query.eq('version', version);
    }

    const { data } = await query;
    return data || [];
  }

  // Agent Memory Events
  async recordAgentEvent(event: Omit<AgentMemoryEvent, 'id' | 'createdAt'>): Promise<void> {
    await this.db.from('agent_memory_events').insert({
      user_id: event.userId,
      session_id: event.sessionId,
      workflow_id: event.workflowId || null,
      agent_name: event.agentName,
      event_type: event.eventType,
      action_taken: event.actionTaken || null,
      context: event.context,
      outcome: event.outcome,
      learnings: event.learnings,
      confidence_score: event.confidenceScore || null
    });
  }

  async getAgentLearnings(
    userId: string,
    agentName?: string,
    limit: number = 20
  ): Promise<AgentMemoryEvent[]> {
    let query = this.db
      .from('agent_memory_events')
      .select('*')
      .eq('user_id', userId)
      .eq('event_type', 'learning')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (agentName) {
      query = query.eq('agent_name', agentName);
    }

    const { data } = await query;
    return data || [];
  }

  // Context Loading for Agent Sessions
  async loadContextForSession(
    userId: string,
    sessionId: string,
    projectId?: string,
    workflowId?: string
  ): Promise<{
    projectMemories: ProjectMemory[];
    workflowMemories: WorkflowMemory[];
    agentLearnings: AgentMemoryEvent[];
  }> {
    const [projectMemories, workflowMemories, agentLearnings] = await Promise.all([
      projectId ? this.getProjectMemory(userId, projectId) : Promise.resolve([]),
      workflowId ? this.getWorkflowMemory(userId, workflowId) : Promise.resolve([]),
      this.getAgentLearnings(userId, undefined, 10)
    ]);

    return {
      projectMemories,
      workflowMemories,
      agentLearnings
    };
  }

  // Memory Cleanup (keep only recent/important memories)
  async cleanupOldMemories(userId: string, daysOld: number = 90): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    await this.db
      .from('project_memory')
      .delete()
      .eq('user_id', userId)
      .lt('importance_score', 0.3)
      .lt('last_accessed_at', cutoffDate.toISOString());
  }
}

export const persistentMemory = new PersistentMemory();