import type { SafetyMode } from '@/lib/agent/safety';

export type ToolRiskLevel = 'low' | 'medium' | 'high';

export type ToolExecutionPolicy = {
  tool: string;
  riskLevel: ToolRiskLevel;
  allowedModes: SafetyMode[];
  requiresApproval: boolean;
  timeoutMs: number;
  supportsRollback: boolean;
  retry: {
    attempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  concurrency: {
    group: 'planner' | 'deploy' | 'execution' | 'monitoring' | 'recovery' | 'integration';
    max: number;
  };
};

export const TOOL_EXECUTION_POLICIES: Record<string, ToolExecutionPolicy> = {
  generate_workflow_json: {
    tool: 'generate_workflow_json',
    riskLevel: 'low',
    allowedModes: ['safe', 'staging', 'production'],
    requiresApproval: false,
    timeoutMs: 60_000,
    supportsRollback: false,
    retry: { attempts: 1, baseDelayMs: 300, maxDelayMs: 1200 },
    concurrency: { group: 'planner', max: 8 },
  },
  explain_workflow_architecture: {
    tool: 'explain_workflow_architecture',
    riskLevel: 'low',
    allowedModes: ['safe', 'staging', 'production'],
    requiresApproval: false,
    timeoutMs: 30_000,
    supportsRollback: false,
    retry: { attempts: 0, baseDelayMs: 300, maxDelayMs: 300 },
    concurrency: { group: 'planner', max: 10 },
  },
  validate_credential: {
    tool: 'validate_credential',
    riskLevel: 'medium',
    allowedModes: ['safe', 'staging', 'production'],
    requiresApproval: false,
    timeoutMs: 20_000,
    supportsRollback: false,
    retry: { attempts: 1, baseDelayMs: 300, maxDelayMs: 1000 },
    concurrency: { group: 'integration', max: 6 },
  },
  deploy_workflow_to_n8n: {
    tool: 'deploy_workflow_to_n8n',
    riskLevel: 'high',
    allowedModes: ['staging', 'production'],
    requiresApproval: true,
    timeoutMs: 90_000,
    supportsRollback: true,
    retry: { attempts: 2, baseDelayMs: 600, maxDelayMs: 5000 },
    concurrency: { group: 'deploy', max: 2 },
  },
  activate_workflow: {
    tool: 'activate_workflow',
    riskLevel: 'high',
    allowedModes: ['production'],
    requiresApproval: true,
    timeoutMs: 60_000,
    supportsRollback: true,
    retry: { attempts: 2, baseDelayMs: 800, maxDelayMs: 5000 },
    concurrency: { group: 'deploy', max: 2 },
  },
  test_workflow: {
    tool: 'test_workflow',
    riskLevel: 'medium',
    allowedModes: ['staging', 'production'],
    requiresApproval: false,
    timeoutMs: 60_000,
    supportsRollback: false,
    retry: { attempts: 2, baseDelayMs: 600, maxDelayMs: 4000 },
    concurrency: { group: 'execution', max: 4 },
  },
  get_workflow_status: {
    tool: 'get_workflow_status',
    riskLevel: 'low',
    allowedModes: ['safe', 'staging', 'production'],
    requiresApproval: false,
    timeoutMs: 20_000,
    supportsRollback: false,
    retry: { attempts: 1, baseDelayMs: 300, maxDelayMs: 1000 },
    concurrency: { group: 'monitoring', max: 8 },
  },
  get_execution_logs: {
    tool: 'get_execution_logs',
    riskLevel: 'low',
    allowedModes: ['safe', 'staging', 'production'],
    requiresApproval: false,
    timeoutMs: 25_000,
    supportsRollback: false,
    retry: { attempts: 1, baseDelayMs: 300, maxDelayMs: 1000 },
    concurrency: { group: 'monitoring', max: 8 },
  },
  request_credential: {
    tool: 'request_credential',
    riskLevel: 'low',
    allowedModes: ['safe', 'staging', 'production'],
    requiresApproval: false,
    timeoutMs: 15_000,
    supportsRollback: false,
    retry: { attempts: 0, baseDelayMs: 200, maxDelayMs: 200 },
    concurrency: { group: 'integration', max: 10 },
  },
};

export function getToolExecutionPolicy(toolName: string): ToolExecutionPolicy {
  return TOOL_EXECUTION_POLICIES[toolName] ?? {
    tool: toolName,
    riskLevel: 'medium',
    allowedModes: ['safe', 'staging', 'production'],
    requiresApproval: true,
    timeoutMs: 45_000,
    supportsRollback: false,
    retry: { attempts: 1, baseDelayMs: 300, maxDelayMs: 1500 },
    concurrency: { group: 'planner', max: 2 },
  };
}
