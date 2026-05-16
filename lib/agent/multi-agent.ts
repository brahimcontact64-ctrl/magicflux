import { createServiceClient } from '@/lib/supabase-server';
import { persistentMemory } from '@/lib/memory/persistent-memory';
import { backgroundTaskManager } from '@/lib/tasks/background-task-manager';

export type AgentName = 'planner' | 'builder' | 'integration' | 'deploy' | 'monitoring' | 'memory';

export type AgentTask = {
  id: string;
  agent: AgentName;
  action: string;
  args: Record<string, unknown>;
  priority: number;
  createdAt: string;
  completedAt?: string;
  result?: any;
  error?: string;
};

export type AgentHandoff = {
  fromAgent: AgentName;
  toAgent: AgentName;
  reason: string;
  context: any;
  timestamp: string;
};

export type OrchestrationState = {
  id: string;
  userId: string;
  sessionId: string;
  workflowId?: string;
  rootAgent: AgentName;
  currentAgent: AgentName;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  agentStates: Record<AgentName, any>;
  sharedContext: any;
  handoffs: AgentHandoff[];
  tasks: AgentTask[];
  startedAt: string;
  completedAt?: string;
};

export class AgentOrchestrator {
  private db = createServiceClient();

  // Agent Routing
  routeActionToAgent(action: string): AgentName {
    const actionMap: Record<string, AgentName> = {
      // Planner Agent
      'understand_intent': 'planner',
      'propose_architecture': 'planner',
      'analyze_requirements': 'planner',

      // Builder Agent
      'generate_workflow': 'builder',
      'create_workflow_graph': 'builder',
      'add_workflow_nodes': 'builder',
      'modify_workflow': 'builder',

      // Integration Agent
      'validate_credential': 'integration',
      'request_credential': 'integration',
      'connect_provider': 'integration',
      'test_integration': 'integration',

      // Deploy Agent
      'deploy_workflow_to_n8n': 'deploy',
      'activate_workflow': 'deploy',
      'rollback_deployment': 'deploy',
      'generate_deployment_config': 'deploy',

      // Monitoring Agent
      'test_workflow': 'monitoring',
      'get_execution_logs': 'monitoring',
      'get_workflow_status': 'monitoring',
      'monitor_failures': 'monitoring',
      'trigger_recovery': 'monitoring',

      // Memory Agent
      'save_memory': 'memory',
      'load_memory': 'memory',
      'update_context': 'memory',
      'learn_from_outcome': 'memory'
    };

    return actionMap[action] || 'planner';
  }

  // Orchestration Management
  async startOrchestration(
    userId: string,
    sessionId: string,
    rootAgent: AgentName = 'planner',
    options: {
      workflowId?: string;
      initialContext?: any;
    } = {}
  ): Promise<OrchestrationState> {
    const orchestrationId = `orch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const orchestration = {
      user_id: userId,
      session_id: sessionId,
      workflow_id: options.workflowId || null,
      root_agent: rootAgent,
      current_agent: rootAgent,
      orchestration_id: orchestrationId,
      status: 'running',
      agent_states: {},
      shared_context: options.initialContext || {},
      handoffs: [],
      started_at: new Date().toISOString()
    };

    const { data, error } = await this.db
      .from('agent_orchestration')
      .insert(orchestration)
      .select()
      .single();

    if (error) throw error;

    return this.transformOrchestration(data);
  }

  async getOrchestration(orchestrationId: string, userId: string): Promise<OrchestrationState | null> {
    const { data } = await this.db
      .from('agent_orchestration')
      .select('*')
      .eq('orchestration_id', orchestrationId)
      .eq('user_id', userId)
      .single();

    return data ? this.transformOrchestration(data) : null;
  }

  async handoffToAgent(
    orchestrationId: string,
    fromAgent: AgentName,
    toAgent: AgentName,
    reason: string,
    context: any = {}
  ): Promise<void> {
    const handoff: AgentHandoff = {
      fromAgent,
      toAgent,
      reason,
      context,
      timestamp: new Date().toISOString()
    };

    const { data: current } = await this.db
      .from('agent_orchestration')
      .select('handoffs')
      .eq('orchestration_id', orchestrationId)
      .limit(1)
      .maybeSingle();

    const existingHandoffs = Array.isArray(current?.handoffs)
      ? (current?.handoffs as AgentHandoff[])
      : [];

    await this.db
      .from('agent_orchestration')
      .update({
        current_agent: toAgent,
        handoffs: [...existingHandoffs, handoff],
        updated_at: new Date().toISOString()
      })
      .eq('orchestration_id', orchestrationId);
  }

  async updateAgentState(
    orchestrationId: string,
    agent: AgentName,
    state: any
  ): Promise<void> {
    const { data: current } = await this.db
      .from('agent_orchestration')
      .select('agent_states')
      .eq('orchestration_id', orchestrationId)
      .limit(1)
      .maybeSingle();

    const existingAgentStates = (current?.agent_states && typeof current.agent_states === 'object' && !Array.isArray(current.agent_states))
      ? (current.agent_states as Record<string, unknown>)
      : {};

    await this.db
      .from('agent_orchestration')
      .update({
        agent_states: {
          ...existingAgentStates,
          [agent]: state,
        },
        updated_at: new Date().toISOString()
      })
      .eq('orchestration_id', orchestrationId);
  }

  async updateSharedContext(
    orchestrationId: string,
    context: any
  ): Promise<void> {
    await this.db
      .from('agent_orchestration')
      .update({
        shared_context: context,
        updated_at: new Date().toISOString()
      })
      .eq('orchestration_id', orchestrationId);
  }

  async completeOrchestration(
    orchestrationId: string,
    status: 'completed' | 'failed' | 'cancelled' = 'completed'
  ): Promise<void> {
    await this.db
      .from('agent_orchestration')
      .update({
        status,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('orchestration_id', orchestrationId);
  }

  // Task Management within Orchestration
  async addTask(
    orchestrationId: string,
    action: string,
    args: Record<string, unknown>,
    priority: number = 0
  ): Promise<AgentTask> {
    const task: AgentTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      agent: this.routeActionToAgent(action),
      action,
      args,
      priority,
      createdAt: new Date().toISOString()
    };

    // Create background task
    await backgroundTaskManager.createTask(
      await this.getUserIdFromOrchestration(orchestrationId),
      await this.getSessionIdFromOrchestration(orchestrationId),
      action as any,
      args,
      {
        priority,
        workflowId: await this.getWorkflowIdFromOrchestration(orchestrationId)
      }
    );

    return task;
  }

  // Specialized Agent Methods
  async plannerAgent(
    orchestrationId: string,
    userIntent: string,
    context: any
  ): Promise<{ architecture: any; nextAgent: AgentName }> {
    // Load relevant memory
    const orchestration = await this.getOrchestration(orchestrationId, await this.getUserIdFromOrchestration(orchestrationId));
    if (!orchestration) throw new Error('Orchestration not found');

    const memoryContext = await persistentMemory.loadContextForSession(
      orchestration.userId,
      orchestration.sessionId,
      undefined, // projectId
      orchestration.workflowId
    );

    // Analyze intent and propose architecture
    const architecture = {
      workflowType: this.inferWorkflowType(userIntent),
      requiredIntegrations: this.extractRequiredIntegrations(userIntent),
      complexity: this.assessComplexity(userIntent),
      suggestedAgents: ['builder', 'integration']
    };

    await this.updateAgentState(orchestrationId, 'planner', { architecture, memoryContext });

    return {
      architecture,
      nextAgent: architecture.requiredIntegrations.length > 0 ? 'integration' : 'builder'
    };
  }

  async builderAgent(
    orchestrationId: string,
    architecture: any,
    context: any
  ): Promise<{ workflowGraph: any; nextAgent: AgentName }> {
    // Generate workflow graph
    const workflowGraph = {
      nodes: [],
      edges: [],
      metadata: architecture
    };

    // Create background task for actual generation
    await this.addTask(orchestrationId, 'generate_workflow', {
      architecture,
      context
    }, 1);

    await this.updateAgentState(orchestrationId, 'builder', { workflowGraph });

    return {
      workflowGraph,
      nextAgent: 'deploy'
    };
  }

  async integrationAgent(
    orchestrationId: string,
    requiredIntegrations: string[],
    context: any
  ): Promise<{ connectedIntegrations: string[]; nextAgent: AgentName }> {
    const connectedIntegrations: string[] = [];

    // Check existing integrations from memory
    const orchestration = await this.getOrchestration(orchestrationId, await this.getUserIdFromOrchestration(orchestrationId));
    if (!orchestration) throw new Error('Orchestration not found');

    const existingIntegrations = await persistentMemory.getProjectMemory(
      orchestration.userId,
      orchestration.sessionId,
      'integration'
    );

    // Validate and connect required integrations
    for (const integration of requiredIntegrations) {
      const existing = existingIntegrations.find(mem => mem.key === integration);
      if (existing) {
        connectedIntegrations.push(integration);
      } else {
        // Create task to request credentials
        await this.addTask(orchestrationId, 'request_credential', {
          provider: integration,
          reason: `Required for workflow: ${context.workflowName || 'current workflow'}`
        }, 2);
      }
    }

    await this.updateAgentState(orchestrationId, 'integration', { connectedIntegrations, requiredIntegrations });

    return {
      connectedIntegrations,
      nextAgent: connectedIntegrations.length === requiredIntegrations.length ? 'builder' : 'integration'
    };
  }

  async deployAgent(
    orchestrationId: string,
    workflowGraph: any,
    context: any
  ): Promise<{ deploymentResult: any; nextAgent: AgentName }> {
    // Create deployment task
    await this.addTask(orchestrationId, 'deploy_workflow_to_n8n', {
      workflowGraph,
      context
    }, 1);

    const deploymentResult = {
      status: 'queued',
      workflowId: null,
      deploymentUrl: null
    };

    await this.updateAgentState(orchestrationId, 'deploy', { deploymentResult });

    return {
      deploymentResult,
      nextAgent: 'monitoring'
    };
  }

  async monitoringAgent(
    orchestrationId: string,
    deploymentResult: any,
    context: any
  ): Promise<{ monitoringResult: any; nextAgent?: AgentName }> {
    // Set up monitoring
    await this.addTask(orchestrationId, 'monitor_runs', {
      workflowId: deploymentResult.workflowId,
      deploymentResult
    }, 0);

    const monitoringResult = {
      status: 'active',
      lastCheck: new Date().toISOString(),
      issues: []
    };

    await this.updateAgentState(orchestrationId, 'monitoring', { monitoringResult });

    // Complete orchestration
    await this.completeOrchestration(orchestrationId, 'completed');

    return {
      monitoringResult,
      nextAgent: undefined
    };
  }

  // Helper Methods
  private inferWorkflowType(intent: string): string {
    if (intent.includes('email') || intent.includes('gmail')) return 'email_automation';
    if (intent.includes('slack') || intent.includes('discord')) return 'chat_automation';
    if (intent.includes('airtable') || intent.includes('notion')) return 'data_sync';
    if (intent.includes('shopify') || intent.includes('stripe')) return 'ecommerce';
    return 'custom_workflow';
  }

  private extractRequiredIntegrations(intent: string): string[] {
    const integrations: string[] = [];
    const providers = ['gmail', 'slack', 'airtable', 'shopify', 'stripe', 'notion', 'discord', 'webhook'];

    for (const provider of providers) {
      if (intent.toLowerCase().includes(provider)) {
        integrations.push(provider);
      }
    }

    return integrations;
  }

  private assessComplexity(intent: string): 'simple' | 'medium' | 'complex' {
    const complexKeywords = ['multiple', 'conditional', 'retry', 'error handling', 'advanced'];
    const hasComplex = complexKeywords.some(keyword => intent.toLowerCase().includes(keyword));
    return hasComplex ? 'complex' : intent.length > 100 ? 'medium' : 'simple';
  }

  private async getUserIdFromOrchestration(orchestrationId: string): Promise<string> {
    const { data } = await this.db
      .from('agent_orchestration')
      .select('user_id')
      .eq('orchestration_id', orchestrationId)
      .single();

    if (!data) throw new Error('Orchestration not found');
    return data.user_id;
  }

  private async getSessionIdFromOrchestration(orchestrationId: string): Promise<string> {
    const { data } = await this.db
      .from('agent_orchestration')
      .select('session_id')
      .eq('orchestration_id', orchestrationId)
      .single();

    if (!data) throw new Error('Orchestration not found');
    return data.session_id;
  }

  private async getWorkflowIdFromOrchestration(orchestrationId: string): Promise<string | undefined> {
    const { data } = await this.db
      .from('agent_orchestration')
      .select('workflow_id')
      .eq('orchestration_id', orchestrationId)
      .single();

    return data?.workflow_id || undefined;
  }

  private transformOrchestration(data: any): OrchestrationState {
    return {
      id: data.orchestration_id,
      userId: data.user_id,
      sessionId: data.session_id,
      workflowId: data.workflow_id,
      rootAgent: data.root_agent,
      currentAgent: data.current_agent,
      status: data.status,
      agentStates: data.agent_states || {},
      sharedContext: data.shared_context || {},
      handoffs: data.handoffs || [],
      tasks: [], // Would need to join with tasks table
      startedAt: data.started_at,
      completedAt: data.completed_at
    };
  }
}

export const agentOrchestrator = new AgentOrchestrator();

// Legacy compatibility
export function routeActionToAgent(action: string): AgentName {
  return agentOrchestrator.routeActionToAgent(action);
}

export function createTask(action: string, args: Record<string, unknown>): AgentTask {
  const now = new Date().toISOString();
  return {
    id: `${action}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    agent: routeActionToAgent(action),
    action,
    args,
    priority: 0,
    createdAt: now,
  };
}
