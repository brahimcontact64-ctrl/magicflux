/**
 * Production runtime engine tests.
 *
 * Verifies the credential pre-flight validation layer WITHOUT hitting
 * the live execution engine or database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../lib/credentials/storage', () => ({
  assertTrustedUserId: vi.fn(),
}));

vi.mock('../lib/credentials/validation', () => ({
  validateWorkflowCredentials: vi.fn(),
}));

vi.mock('../lib/workflow-runtime/engine', () => ({
  runWorkflowExecution: vi.fn(),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

const VALID_UUID = '00000000-0000-4000-8000-000000000001';

const BASE_OPTS = {
  userId: VALID_UUID,
  workflowId: 'wf-1',
  mode: 'live' as const,
  inputData: {},
};

describe('executeWorkflowForUser — credential pre-flight', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks execution when credentials are missing', async () => {
    const { validateWorkflowCredentials } = await import('../lib/credentials/validation');
    vi.mocked(validateWorkflowCredentials).mockResolvedValue([
      { provider: 'openai', connected: false, missing: ['api_key'] },
    ]);

    const { executeWorkflowForUser } = await import('../lib/runtime/runtime-engine');

    const result = await executeWorkflowForUser({
      ...BASE_OPTS,
      workflowJson: {
        name: 'Test',
        nodes: [{ name: 'AI', type: 'n8n-nodes-base.openAi', parameters: { model: 'gpt-4o-mini', prompt: 'Say hello' } }],
        connections: {},
      },
    });

    expect(result.status).toBe('failed');
    expect(result.credentialError).toBe(true);
    expect(result.missingCredentialProviders).toContain('openai');
  });

  it('allows execution when all credentials are present', async () => {
    const { validateWorkflowCredentials } = await import('../lib/credentials/validation');
    vi.mocked(validateWorkflowCredentials).mockResolvedValue([
      { provider: 'openai', connected: true, missing: [] },
    ]);

    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    vi.mocked(runWorkflowExecution).mockResolvedValue({
      executionId: 'exec-1',
      status: 'success',
      currentNodeId: null,
      steps: [],
      finalOutput: null,
      simulated: false,
      previews: { emails: [], slackMessages: [], airtableRecords: [] },
    });

    const { executeWorkflowForUser } = await import('../lib/runtime/runtime-engine');

    const result = await executeWorkflowForUser({
      ...BASE_OPTS,
      workflowJson: {
        name: 'Test',
        nodes: [{ name: 'AI', type: 'n8n-nodes-base.openAi', parameters: { model: 'gpt-4o-mini', prompt: 'Say hello' } }],
        connections: {},
      },
    });

    expect(result.status).toBe('success');
    expect(result.credentialError).toBeUndefined();
    expect(runWorkflowExecution).toHaveBeenCalledOnce();
  });

  it('skips credential check for workflows with no credential-requiring nodes', async () => {
    const { validateWorkflowCredentials } = await import('../lib/credentials/validation');
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    vi.mocked(runWorkflowExecution).mockResolvedValue({
      executionId: 'exec-2',
      status: 'success',
      currentNodeId: null,
      steps: [],
      finalOutput: null,
      simulated: false,
      previews: { emails: [], slackMessages: [], airtableRecords: [] },
    });

    const { executeWorkflowForUser } = await import('../lib/runtime/runtime-engine');

    await executeWorkflowForUser({
      ...BASE_OPTS,
      workflowJson: {
        name: 'Test',
        nodes: [{ name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: { path: '/my-webhook' } }],
        connections: {},
      },
    });

    // No credential-requiring nodes → validateWorkflowCredentials NOT called
    expect(validateWorkflowCredentials).not.toHaveBeenCalled();
    expect(runWorkflowExecution).toHaveBeenCalledOnce();
  });

  it('error message names the missing providers', async () => {
    const { validateWorkflowCredentials } = await import('../lib/credentials/validation');
    vi.mocked(validateWorkflowCredentials).mockResolvedValue([
      { provider: 'slack', connected: false, missing: ['bot_token'] },
      { provider: 'openai', connected: false, missing: ['api_key'] },
    ]);

    const { executeWorkflowForUser } = await import('../lib/runtime/runtime-engine');

    const result = await executeWorkflowForUser({
      ...BASE_OPTS,
      workflowJson: {
        name: 'Test',
        nodes: [
          { name: 'Slack', type: 'n8n-nodes-base.slack', parameters: { channel: '#general', message: 'hi' } },
          { name: 'AI', type: 'n8n-nodes-base.openAi', parameters: { model: 'gpt-4o-mini', prompt: 'Say hello' } },
        ],
        connections: {},
      },
    });

    expect(result.error).toContain('slack');
    expect(result.error).toContain('openai');
  });
});

describe('executeWorkflowForUser — required-parameter pre-flight', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks execution when a required node parameter is missing, before checking credentials', async () => {
    const { validateWorkflowCredentials } = await import('../lib/credentials/validation');
    const { executeWorkflowForUser } = await import('../lib/runtime/runtime-engine');

    const result = await executeWorkflowForUser({
      ...BASE_OPTS,
      workflowJson: {
        name: 'Test',
        nodes: [{ name: 'AI', type: 'n8n-nodes-base.openAi', parameters: { model: 'gpt-4o-mini' } }],
        connections: {},
      },
    });

    expect(result.status).toBe('failed');
    expect(result.parameterError).toBe(true);
    expect(result.missingParameters).toEqual([
      expect.objectContaining({ nodeName: 'AI', field: 'prompt' }),
    ]);
    expect(result.error).toContain('AI.prompt');
    expect(validateWorkflowCredentials).not.toHaveBeenCalled();
  });

  it('allows execution when all required parameters and credentials are present', async () => {
    const { validateWorkflowCredentials } = await import('../lib/credentials/validation');
    vi.mocked(validateWorkflowCredentials).mockResolvedValue([
      { provider: 'openai', connected: true, missing: [] },
    ]);

    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    vi.mocked(runWorkflowExecution).mockResolvedValue({
      executionId: 'exec-3',
      status: 'success',
      currentNodeId: null,
      steps: [],
      finalOutput: null,
      simulated: false,
      previews: { emails: [], slackMessages: [], airtableRecords: [] },
    });

    const { executeWorkflowForUser } = await import('../lib/runtime/runtime-engine');

    const result = await executeWorkflowForUser({
      ...BASE_OPTS,
      workflowJson: {
        name: 'Test',
        nodes: [{ name: 'AI', type: 'n8n-nodes-base.openAi', parameters: { model: 'gpt-4o-mini', prompt: 'Say hello' } }],
        connections: {},
      },
    });

    expect(result.status).toBe('success');
    expect(result.parameterError).toBeUndefined();
  });

  it('skips validation for unregistered node types', async () => {
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    vi.mocked(runWorkflowExecution).mockResolvedValue({
      executionId: 'exec-4',
      status: 'success',
      currentNodeId: null,
      steps: [],
      finalOutput: null,
      simulated: false,
      previews: { emails: [], slackMessages: [], airtableRecords: [] },
    });

    const { executeWorkflowForUser } = await import('../lib/runtime/runtime-engine');

    const result = await executeWorkflowForUser({
      ...BASE_OPTS,
      workflowJson: {
        name: 'Test',
        nodes: [{ name: 'Custom', type: 'n8n-nodes-base.someUnregisteredType' }],
        connections: {},
      },
    });

    expect(result.parameterError).toBeUndefined();
    expect(runWorkflowExecution).toHaveBeenCalledOnce();
  });
});

describe('testWorkflowExecution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forces mode=test and skips credential check', async () => {
    const { validateWorkflowCredentials } = await import('../lib/credentials/validation');
    const { runWorkflowExecution } = await import('../lib/workflow-runtime/engine');
    vi.mocked(runWorkflowExecution).mockResolvedValue({
      executionId: 'exec-test',
      status: 'simulated_success',
      currentNodeId: null,
      steps: [],
      finalOutput: null,
      simulated: true,
      previews: { emails: [], slackMessages: [], airtableRecords: [] },
    });

    const { testWorkflowExecution } = await import('../lib/runtime/runtime-engine');

    const result = await testWorkflowExecution({
      ...BASE_OPTS,
      mode: 'live', // should be overridden to 'test'
      workflowJson: {
        name: 'Test',
        nodes: [{ name: 'AI', type: 'n8n-nodes-base.openAi', parameters: { model: 'gpt-4o-mini', prompt: 'Say hello' } }],
        connections: {},
      },
    });

    expect(validateWorkflowCredentials).not.toHaveBeenCalled();
    expect(runWorkflowExecution).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'test' }),
    );
    expect(result.simulated).toBe(true);
  });
});

// ─── isCredentialPreflightError type guard ────────────────────────────────────

describe('isCredentialPreflightError', () => {
  it('returns true for a credential preflight error shape', async () => {
    const { isCredentialPreflightError } = await import('../lib/runtime/runtime-result');
    const err = { code: 'MISSING_CREDENTIALS', missingProviders: ['openai'], message: 'test' };
    expect(isCredentialPreflightError(err)).toBe(true);
  });

  it('returns false for other objects', async () => {
    const { isCredentialPreflightError } = await import('../lib/runtime/runtime-result');
    expect(isCredentialPreflightError({ code: 'OTHER_ERROR' })).toBe(false);
    expect(isCredentialPreflightError(null)).toBe(false);
    expect(isCredentialPreflightError('string')).toBe(false);
  });
});
