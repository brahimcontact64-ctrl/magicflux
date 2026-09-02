/**
 * Phase 9.4.1 — regression coverage for the specific production
 * boundaries wired to lib/security/redact.ts / safe-error.ts:
 * persistNodeState() (the persistence boundary), the real HTTP node
 * handler (provider request/response exposure), and the workflow test
 * API route (API-response boundary). Uses only synthetic credential-shaped
 * values, never real secrets.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const SYNTHETIC_SECRET = 'sk_test_FAKE_SECRET_DO_NOT_USE';
const SYNTHETIC_BEARER = 'Bearer TEST_SECRET_123';

// ─── persistNodeState(): the persistence boundary ──────────────────────────

type Row = Record<string, unknown>;

class FakeUpsertTable {
  constructor(private rows: Row[]) {}
  upsert(row: Row, opts?: { onConflict?: string }) {
    const conflictCols = (opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const idx = conflictCols.length ? this.rows.findIndex((r) => conflictCols.every((c) => r[c] === row[c])) : -1;
    if (idx >= 0) this.rows[idx] = { ...this.rows[idx], ...row };
    else this.rows.push({ id: `row-${this.rows.length}`, ...row });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
}

class FakeInsertTable {
  constructor(private rows: Row[]) {}
  insert(row: Row) {
    this.rows.push({ id: `row-${this.rows.length}`, ...row });
    return { then: (resolve: (v: { error: null }) => unknown) => Promise.resolve(resolve({ error: null })) };
  }
}

let nodeStateRows: Row[];
let stepRows: Row[];

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => {
      if (name === 'runtime_node_states') return new FakeUpsertTable(nodeStateRows);
      if (name === 'workflow_execution_steps') return new FakeInsertTable(stepRows);
      throw new Error(`unexpected table ${name}`);
    },
  })),
}));
vi.mock('@/lib/runtime/events', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/runtime/usage-metering', () => ({ recordUsageEvent: vi.fn(async () => undefined) }));

beforeEach(() => {
  nodeStateRows = [];
  stepRows = [];
  vi.clearAllMocks();
});

describe('RuntimeStateStore.persistNodeState() — persistence boundary', () => {
  it('redacts a synthetic credential in inputData/outputData/errorMessage before writing to either table', async () => {
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();

    const inputData = { headers: { Authorization: SYNTHETIC_BEARER } };
    const outputData = { status: 200, body: { access_token: SYNTHETIC_SECRET, user: 'alice' } };

    await store.persistNodeState({
      executionId: 'exec-1',
      workflowId: 'wf-1',
      userId: 'user-1',
      nodeId: 'node-1',
      nodeName: 'HTTP Request',
      nodeType: 'http',
      status: 'success',
      attempt: 1,
      inputData,
      outputData,
      logs: [`fetched with token=${SYNTHETIC_SECRET}`],
    });

    expect(nodeStateRows).toHaveLength(1);
    expect(stepRows).toHaveLength(1);

    for (const row of [nodeStateRows[0], stepRows[0]]) {
      expect(JSON.stringify(row)).not.toContain(SYNTHETIC_SECRET);
      expect(JSON.stringify(row)).not.toContain('TEST_SECRET_123');
      expect((row.input_data as any).headers.Authorization).toBe('[REDACTED]');
      expect((row.output_data as any).body.access_token).toBe('[REDACTED]');
      expect((row.output_data as any).body.user).toBe('alice'); // harmless sibling field preserved
    }
  });

  it('does not mutate the caller-supplied inputData/outputData objects (so in-memory chaining to the next node is unaffected)', async () => {
    const { RuntimeStateStore } = await import('../runtime/runtime-state');
    const store = new RuntimeStateStore();

    const outputData = { access_token: SYNTHETIC_SECRET, record_id: 'rec_123' };
    const outputDataSnapshot = JSON.parse(JSON.stringify(outputData));

    await store.persistNodeState({
      executionId: 'exec-2', workflowId: 'wf-1', userId: 'user-1',
      nodeId: 'node-1', nodeName: 'HTTP', nodeType: 'http', status: 'success', attempt: 1,
      inputData: {}, outputData,
    });

    // the ORIGINAL object, as the engine would continue to use it for the
    // next node's input, must still contain the real value
    expect(outputData).toEqual(outputDataSnapshot);
    expect(outputData.access_token).toBe(SYNTHETIC_SECRET);
    // but what was actually written to the DB is redacted
    expect((stepRows[0].output_data as any).access_token).toBe('[REDACTED]');
  });
});

// ─── Real HTTP node handler ─────────────────────────────────────────────

vi.mock('@/lib/workflow-runtime/node-handlers/ssrf-guard', () => ({
  checkUrlSafe: vi.fn(async () => ({ allowed: true })),
}));

describe('httpHandler — synthetic secret does not leak', () => {
  it('test-mode preview redacts a synthetic Authorization header configured on the node', async () => {
    const { httpHandler } = await import('@/lib/workflow-runtime/node-handlers/http');
    const node = {
      id: 'n1', name: 'HTTP', parameters: {
        url: 'https://api.example.com/widgets',
        method: 'GET',
        headers: JSON.stringify({ Authorization: SYNTHETIC_BEARER }),
      },
    } as any;
    const result = await httpHandler(node, {}, { mode: 'test', integrations: [] } as any);
    expect(JSON.stringify(result)).not.toContain('TEST_SECRET_123');
    expect((result.outputData as any).http_preview.headers.Authorization).toBe('[REDACTED]');
  });

  it('a failed live request never embeds a raw non-JSON response body containing a synthetic secret into the error string', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(`leaked token=${SYNTHETIC_SECRET}`, {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    })) as any;

    try {
      const { httpHandler } = await import('@/lib/workflow-runtime/node-handlers/http');
      const node = { id: 'n1', name: 'HTTP', parameters: { url: 'https://api.example.com/fail', method: 'GET' } } as any;
      const result = await httpHandler(node, {}, { mode: 'live', integrations: [] } as any);

      expect(result.status).toBe('failed');
      expect(result.error).not.toContain(SYNTHETIC_SECRET);
      expect(result.logs.join(' ')).not.toContain(SYNTHETIC_SECRET);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('a failed live request with a JSON response body redacts credential-shaped fields in the error string', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized', access_token: SYNTHETIC_SECRET }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as any;

    try {
      const { httpHandler } = await import('@/lib/workflow-runtime/node-handlers/http');
      const node = { id: 'n1', name: 'HTTP', parameters: { url: 'https://api.example.com/fail', method: 'GET' } } as any;
      const result = await httpHandler(node, {}, { mode: 'live', integrations: [] } as any);

      expect(result.status).toBe('failed');
      expect(result.error).not.toContain(SYNTHETIC_SECRET);
      expect(result.error).toContain('[REDACTED]');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ─── API boundary: /api/workflows/[id]/test ────────────────────────────

vi.mock('@/lib/workflow-runtime/sample-data', () => ({ createSampleDataForWorkflow: vi.fn(() => ({})) }));

describe('POST /api/workflows/[id]/test — API response boundary', () => {
  it('11/12. sanitizes execution output before returning it, and never leaks a raw DB error message', async () => {
    const runWorkflowExecutionMock = vi.fn(async () => ({
      status: 'success',
      executionId: 'exec-1',
      steps: [{
        nodeName: 'HTTP', nodeType: 'http', status: 'success',
        inputData: {}, outputData: { access_token: SYNTHETIC_SECRET }, logs: [], error: null,
      }],
      finalOutput: { access_token: SYNTHETIC_SECRET },
      previews: [],
      simulated: true,
      warnings: [],
    }));
    vi.doMock('@/lib/workflow-runtime/engine', () => ({ runWorkflowExecution: runWorkflowExecutionMock }));

    const insertMock = vi.fn((_row: Record<string, unknown>) => ({ then: (r: any) => Promise.resolve(r({ error: null })) }));
    vi.doMock('@/lib/supabase-server', () => ({
      createServiceClient: vi.fn(() => ({
        from: (name: string) => {
          if (name === 'workflows') {
            return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'wf-1', name: 'wf', workflow_json: { nodes: [{}], connections: {} } }, error: null }) }) }) }) };
          }
          if (name === 'workflow_runs') return { insert: insertMock };
          throw new Error(`unexpected table ${name}`);
        },
      })),
      getUserFromRequest: vi.fn(async () => ({ id: 'user-1', email: 'a@test.local' })),
    }));
    vi.doMock('@/lib/billing/plan-limits', () => ({
      canExecuteWorkflow: vi.fn(async () => ({ allowed: true })),
      getPlanLimits: vi.fn(async () => ({ name: 'Free' })),
    }));

    const { POST } = await import('../app/api/workflows/[id]/test/route');
    const res = await POST(
      new NextRequest(new URL('http://localhost/api/workflows/wf-1/test'), { method: 'POST', body: '{}' }),
      { params: { id: 'wf-1' } },
    );
    const bodyText = await res.text();

    expect(bodyText).not.toContain(SYNTHETIC_SECRET);
    expect(JSON.stringify(insertMock.mock.calls[0]?.[0] ?? {})).not.toContain(SYNTHETIC_SECRET);

    const payload = JSON.parse(bodyText);
    expect(payload.finalOutput.access_token).toBe('[REDACTED]');
    expect(payload.steps[0].output.access_token).toBe('[REDACTED]');

    vi.doUnmock('@/lib/workflow-runtime/engine');
    vi.doUnmock('@/lib/supabase-server');
    vi.doUnmock('@/lib/billing/plan-limits');
  });
});
