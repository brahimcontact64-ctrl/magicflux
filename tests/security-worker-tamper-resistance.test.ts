/**
 * Phase 8.1 security — the worker must re-resolve the frozen deployment
 * snapshot from deploymentVersionId itself, never trusting a workflowJson
 * (or any other) field that might ride along in the queue payload. Proves
 * that even if a queue payload were tampered with (e.g. a compromised Redis
 * instance, or a bug that leaked extra fields into args), what actually
 * executes is still the DB-resolved frozen version.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const OWNER_ID = '00000000-0000-4000-8000-0000000000f1';
const WORKFLOW_ID = 'wf-security-tamper';

type Row = Record<string, unknown>;

let tables: Record<string, Row[]>;

class FakeQuery {
  constructor(private rows: Row[]) {}
  private filters: Array<[string, unknown]> = [];
  private patch: Row | null = null;
  eq(c: string, v: unknown) { this.filters.push([c, v]); return this; }
  select() { return this; }
  update(patch: Row) { this.patch = patch; return this; }
  in() { return this; }
  async maybeSingle() {
    const m = this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.patch) for (const row of m) Object.assign(row, this.patch);
    return { data: m[0] ? { ...m[0] } : null, error: null };
  }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    const m = this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.patch) for (const row of m) Object.assign(row, this.patch);
    return Promise.resolve(resolve({ data: m.map((r) => ({ ...r })), error: null }));
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = [])) })),
}));

const runWorkflowExecutionMock = vi.fn(async (_opts: { workflowJson: unknown }) => ({ executionId: 'exec-1', status: 'success', currentNodeId: null, error: null }));
vi.mock('@/lib/workflow-runtime/engine', () => ({ runWorkflowExecution: runWorkflowExecutionMock }));
vi.mock('@/lib/runtime/concurrency-guard', () => ({ releaseConcurrencySlot: vi.fn(async () => undefined) }));
vi.mock('@/lib/runtime/usage-metering', () => ({ recordUsageEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai-engine/n8n-deployer', () => ({}));
vi.mock('@/lib/agent/recovery', () => ({ withExponentialBackoff: vi.fn() }));
vi.mock('@/lib/deployment/deployment-manager', () => ({ DeploymentManager: vi.fn().mockImplementation(function () { return {}; }) }));
vi.mock('@/lib/runtime/events', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/runtime/event-store', () => ({ appendExecutionEvent: vi.fn(async () => null) }));
vi.mock('@/lib/runtime/command-bus', () => ({ pinWorkflowVersion: vi.fn(), deadLetterExecutionCommands: vi.fn() }));
vi.mock('@/lib/runtime/tracing', () => ({ startSpan: vi.fn(async () => 'span-1'), endSpan: vi.fn(async () => undefined) }));
vi.mock('@/lib/runtime/worker-registry', () => ({ incrementWorkerJobs: vi.fn(async () => undefined) }));
vi.mock('@/runtime/hardening-layer', () => ({
  claimExecutionOwnership: vi.fn(), releaseExecutionOwnership: vi.fn(), renewExecutionOwnership: vi.fn(), validateExecutionOwnership: vi.fn(),
}));
vi.mock('@/lib/runtime/redis', () => ({ canUseRuntimeRedis: vi.fn(() => false), getRedisConnection: vi.fn(async () => null) }));
vi.mock('@/lib/runtime/drain-signal', () => ({ isWorkerDrainingInMemory: vi.fn(() => false), getDrainCache: vi.fn(() => null), setDrainCache: vi.fn() }));
vi.mock('@/lib/runtime/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

beforeEach(() => {
  tables = {
    deployment_versions: [{ id: 'dv-legit', user_id: OWNER_ID, workflow_id: WORKFLOW_ID, workflow_data: { nodes: [{ type: 'LEGIT-FROZEN-NODE' }], connections: {} } }],
    workflows: [{ id: WORKFLOW_ID, user_id: OWNER_ID, workflow_json: { nodes: [{ type: 'LIVE-EDITED-NODE' }], connections: {} } }],
    workflow_executions_v2: [],
  };
  runWorkflowExecutionMock.mockClear();
});

describe('worker ignores a tampered/injected workflowJson field in the queue payload', () => {
  it('executes the DB-resolved frozen snapshot even when the job payload carries an unrelated/injected field claiming to be workflow data', async () => {
    const { processRuntimeJob } = await import('../lib/runtime/worker');

    const tamperedPayload = {
      userId: OWNER_ID,
      sessionId: 'exec-1',
      workflowId: WORKFLOW_ID,
      toolName: 'run_workflow_execution' as const,
      executionId: 'exec-1',
      correlationId: 'corr-1',
      args: {
        deploymentVersionId: 'dv-legit',
        inputData: {},
        mode: 'live',
        workflowJson: { nodes: [{ type: 'ATTACKER-INJECTED-NODE' }], connections: {} },
      },
    };

    await processRuntimeJob(
      { data: tamperedPayload, id: 'job-1', attemptsStarted: 1, attemptsMade: 0, queueName: 'execution_queue', name: 'run_workflow_execution' } as never,
      null,
    );

    expect(runWorkflowExecutionMock).toHaveBeenCalledTimes(1);
    const executedWorkflow = runWorkflowExecutionMock.mock.calls[0][0];
    expect(executedWorkflow.workflowJson).toEqual({ nodes: [{ type: 'LEGIT-FROZEN-NODE' }], connections: {} });
  });
});
