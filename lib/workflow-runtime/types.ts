/**
 * Shared types for the MagicFlux node handler system.
 */

import type { UserIntegration } from '@/lib/user-integrations';

export type ExecutionMode = 'test' | 'live';

export const EXECUTION_MODES = {
  test: 'test',
  live: 'live',
} as const;

export type NodeStatus = 'success' | 'simulated_success' | 'failed' | 'waiting' | 'skipped';

export type EngineNode = {
  id?: string;
  name?: string;
  type?: string;
  parameters?: Record<string, unknown>;
};

export type EngineWorkflow = {
  name?: string;
  nodes?: EngineNode[];
  connections?: Record<string, { main?: ConnectionEntry[][] }>;
};

export type ConnectionEntry = {
  node: string;
  type?: string;
  index?: number;
};

export type NodeHandlerContext = {
  mode: ExecutionMode;
  integrations: UserIntegration[];
  sampleData: Record<string, unknown>;
  previews?: {
    emails: Array<Record<string, unknown>>;
    slackMessages: Array<Record<string, unknown>>;
    airtableRecords: Array<Record<string, unknown>>;
  };
};

export type NodeHandlerResult = {
  status: NodeStatus;
  outputData: unknown;
  logs: string[];
  error?: string;
  /** When status=waiting, resume after this timestamp */
  nextRunAt?: Date;
};

export type NodeHandler = (
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
) => Promise<NodeHandlerResult>;

export type ExecutionStep = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: NodeStatus;
  inputData: unknown;
  outputData: unknown;
  logs: string[];
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  attempt: number;
};

export type EngineResult = {
  executionId: string;
  status: 'success' | 'simulated_success' | 'failed' | 'waiting' | 'cancelled';
  currentNodeId: string | null;
  steps: ExecutionStep[];
  finalOutput: unknown;
  error?: string;
  nextRunAt?: Date;
  simulated: boolean;
  message?: string;
  warnings?: string[];
  previews: {
    emails: Array<Record<string, unknown>>;
    slackMessages: Array<Record<string, unknown>>;
    airtableRecords: Array<Record<string, unknown>>;
  };
};

export type RunExecutionOptions = {
  workflowJson: unknown;
  inputData: Record<string, unknown>;
  userId: string;
  workflowId: string;
  mode: ExecutionMode;
  ownerId?: string;
  idempotencyKey?: string;
  /** Resume from this node (for retry/wait resume) */
  resumeFromNodeId?: string;
  /** Existing executionId for resume */
  executionId?: string;
  /** Current retry count */
  retryCount?: number;
  maxRetries?: number;
  /**
   * The deployment_versions.id this execution is pinned to (if the workflow
   * has been activated). Persisted on the execution row so resume reads the
   * SAME frozen workflow_json snapshot the execution started with, not
   * whatever workflow_json is live at resume time.
   */
  deploymentVersionId?: string | null;
};
