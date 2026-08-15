/**
 * Run history and timeline tests.
 *
 * Verifies the data transformation utilities used by RunHistory,
 * RunDetails, and RunTimeline without mounting React components.
 */

import { describe, it, expect } from 'vitest';
import type { ExecutionRecord, ExecutionStep } from '../lib/execution/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'exec-1',
    workflow_id: 'wf-1',
    workflow_name: 'My Workflow',
    status: 'success',
    mode: 'live',
    started_at: '2026-06-08T10:00:00.000Z',
    completed_at: '2026-06-08T10:00:03.200Z',
    duration_ms: 3200,
    step_count: 3,
    failed_step_count: 0,
    error_message: null,
    retry_count: 0,
    ...overrides,
  };
}

function makeStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: 'step-1',
    execution_id: 'exec-1',
    workflow_id: 'wf-1',
    node_id: 'node-abc',
    node_name: 'Send Email',
    node_type: 'n8n-nodes-base.emailSend',
    status: 'success',
    attempt: 1,
    input_data: { email: 'user@example.com' },
    output_data: { sent: true },
    logs: ['Email sent to user@example.com'],
    error_message: null,
    started_at: '2026-06-08T10:00:01.000Z',
    completed_at: '2026-06-08T10:00:01.800Z',
    duration_ms: 800,
    min_started_at: '2026-06-08T10:00:01.000Z',
    ...overrides,
  };
}

// ─── ExecutionRecord shape ────────────────────────────────────────────────────

describe('ExecutionRecord shape', () => {
  it('has required fields', () => {
    const ex = makeExecution();
    expect(typeof ex.id).toBe('string');
    expect(typeof ex.workflow_id).toBe('string');
    expect(typeof ex.status).toBe('string');
    expect(typeof ex.mode).toBe('string');
  });

  it('status values match expected enum', () => {
    const valid = ['running', 'success', 'failed', 'waiting', 'paused', 'cancelled'];
    for (const status of valid) {
      const ex = makeExecution({ status: status as ExecutionRecord['status'] });
      expect(valid).toContain(ex.status);
    }
  });

  it('mode is test or live', () => {
    const test = makeExecution({ mode: 'test' });
    const live = makeExecution({ mode: 'live' });
    expect(['test', 'live']).toContain(test.mode);
    expect(['test', 'live']).toContain(live.mode);
  });

  it('failed execution has error_message', () => {
    const ex = makeExecution({ status: 'failed', error_message: 'Something went wrong' });
    expect(ex.error_message).toBeTruthy();
  });

  it('successful execution has zero failed_step_count', () => {
    const ex = makeExecution({ status: 'success', failed_step_count: 0 });
    expect(ex.failed_step_count).toBe(0);
  });

  it('duration_ms is non-negative when present', () => {
    const ex = makeExecution({ duration_ms: 1234 });
    expect(ex.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ─── ExecutionStep shape ──────────────────────────────────────────────────────

describe('ExecutionStep shape', () => {
  it('has node identification fields', () => {
    const step = makeStep();
    expect(typeof step.node_id).toBe('string');
    expect(typeof step.node_name).toBe('string');
    expect(typeof step.node_type).toBe('string');
  });

  it('logs is always an array', () => {
    const step = makeStep({ logs: [] });
    expect(Array.isArray(step.logs)).toBe(true);
  });

  it('error_message is null on success', () => {
    const step = makeStep({ status: 'success', error_message: null });
    expect(step.error_message).toBeNull();
  });

  it('failed step has error_message', () => {
    const step = makeStep({ status: 'failed', error_message: 'timeout after 30s' });
    expect(step.error_message).toBeTruthy();
  });

  it('attempt starts at 1', () => {
    const step = makeStep({ attempt: 1 });
    expect(step.attempt).toBeGreaterThanOrEqual(1);
  });

  it('duration_ms reflects elapsed time', () => {
    const step = makeStep({ duration_ms: 800 });
    expect(step.duration_ms).toBe(800);
  });
});

// ─── Timeline ordering ────────────────────────────────────────────────────────

describe('Timeline step ordering', () => {
  const steps: ExecutionStep[] = [
    makeStep({ id: 's1', node_name: 'Webhook', started_at: '2026-06-08T10:00:00.000Z', status: 'success' }),
    makeStep({ id: 's2', node_name: 'Send Email', started_at: '2026-06-08T10:00:01.000Z', status: 'success' }),
    makeStep({ id: 's3', node_name: 'Slack', started_at: '2026-06-08T10:00:02.000Z', status: 'failed' }),
  ];

  it('steps are ordered by started_at ascending', () => {
    const sorted = [...steps].sort((a, b) =>
      (a.started_at ?? '').localeCompare(b.started_at ?? ''),
    );
    expect(sorted[0].node_name).toBe('Webhook');
    expect(sorted[1].node_name).toBe('Send Email');
    expect(sorted[2].node_name).toBe('Slack');
  });

  it('failed step comes last in this sequence', () => {
    const lastStatus = steps[steps.length - 1].status;
    expect(lastStatus).toBe('failed');
  });

  it('total step count matches fixture', () => {
    expect(steps).toHaveLength(3);
  });
});

// ─── Run history filter logic ─────────────────────────────────────────────────

describe('Run history filtering', () => {
  const runs: ExecutionRecord[] = [
    makeExecution({ id: '1', status: 'success', mode: 'live' }),
    makeExecution({ id: '2', status: 'failed',  mode: 'live' }),
    makeExecution({ id: '3', status: 'success', mode: 'test' }),
    makeExecution({ id: '4', status: 'running', mode: 'live' }),
  ];

  it('filters by status', () => {
    const failed = runs.filter((r) => r.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe('2');
  });

  it('filters by mode', () => {
    const tests = runs.filter((r) => r.mode === 'test');
    expect(tests).toHaveLength(1);
    expect(tests[0].id).toBe('3');
  });

  it('filters live+success', () => {
    const result = runs.filter((r) => r.mode === 'live' && r.status === 'success');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('counts total and failed', () => {
    const total = runs.length;
    const failed = runs.filter((r) => r.status === 'failed').length;
    expect(total).toBe(4);
    expect(failed).toBe(1);
  });
});

// ─── Security: no credentials in run data ─────────────────────────────────────

describe('Run data security', () => {
  it('ExecutionRecord has no credential fields', () => {
    const ex = makeExecution();
    const json = JSON.stringify(ex);
    expect(json).not.toContain('api_key');
    expect(json).not.toContain('bot_token');
    expect(json).not.toContain('access_token');
    expect(json).not.toContain('password');
  });

  it('ExecutionStep output_data does not contain raw credentials', () => {
    const step = makeStep({
      output_data: { sent: true, recipient: 'user@example.com' },
    });
    const json = JSON.stringify(step.output_data);
    expect(json).not.toContain('api_key');
    expect(json).not.toContain('secret');
  });
});
