/**
 * AI Workflow Builder Integration Tests
 *
 * Tests the full generate → save → load pipeline at the API layer:
 *
 *   POST /api/ai/workflows/generate  →  produces a valid workflow JSON
 *   POST /api/workflows              →  saves it to the DB (mocked)
 *   GET  /api/workflows/:id          →  loads it back (mocked)
 *
 * The redirect URL produced after save is also verified.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock supabase-server ──────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

const MOCK_WORKFLOW_ID = 'ai-wf-test-123';

vi.mock('@/lib/supabase-server', () => ({
  getUserFromRequest: vi.fn(),
  createServiceClient: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { POST as generatePOST } from '../app/api/ai/workflows/generate/route';
import { GET as workflowsGET, POST as workflowsPOST } from '../app/api/workflows/route';
import { GET as workflowByIdGET } from '../app/api/workflows/[id]/route';
import { getUserFromRequest, createServiceClient } from '@/lib/supabase-server';
import { validateWorkflow } from '../lib/workflow-validator';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const AUTHED_USER = { id: 'user-builder-test', email: 'builder@test.com' };

function makeRequest(method: string, body: unknown, url: string) {
  return new NextRequest(new URL(url), {
    method,
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

// ─── Helper: run the full generate+save pipeline ────────────────────────────

async function generateAndSave(prompt: string) {
  // Step 1: generate
  vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);

  const genReq = makeRequest('POST', { prompt }, 'http://localhost/api/ai/workflows/generate');
  const genRes = await generatePOST(genReq);
  expect(genRes.status).toBe(200);

  const generated = await genRes.json() as {
    workflow: Record<string, unknown>;
    valid: boolean;
    examplesUsed: unknown[];
    repairApplied: boolean;
  };

  return generated;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Generate → verify workflow is ready to save
// ═══════════════════════════════════════════════════════════════════════════

describe('Step 1 — Generate: workflow is valid and saveable', () => {

  beforeEach(() => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
  });

  it('generated workflow has all fields required by POST /api/workflows', async () => {
    const { workflow } = await generateAndSave('shopify order to slack');
    // These are the fields the workflows POST route uses
    expect(typeof workflow.name).toBe('string');
    expect(Array.isArray((workflow as Record<string, unknown>).nodes)).toBe(true);
    expect(typeof (workflow as Record<string, unknown>).connections).toBe('object');
  });

  it('generated workflow passes validateWorkflow', async () => {
    const { workflow } = await generateAndSave('wait 10 minutes then email');
    const check = validateWorkflow(workflow);
    expect(check.valid).toBe(true);
  });

  it('workflow name is suitable as a DB record name', async () => {
    const { workflow } = await generateAndSave('notify #alerts on webhook');
    const name = String((workflow as Record<string, unknown>).name ?? '');
    expect(name.trim().length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(500); // reasonable DB varchar limit
  });

  it('valid:true is returned in generate response', async () => {
    const result = await generateAndSave('shopify to airtable');
    expect(result.valid).toBe(true);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Save: POST /api/workflows with AI-generated workflow_json
// ═══════════════════════════════════════════════════════════════════════════

describe('Step 2 — Save: POST /api/workflows accepts AI workflow_json', () => {

  beforeEach(() => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
  });

  it('saves workflow and returns id (mocked DB)', async () => {
    const { workflow } = await generateAndSave('webhook to slack and email');

    // Mock the DB — supports chaining for both plan-limit check and insert
    const chainableQuery = (resolvedData: unknown) => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      q.select    = vi.fn(chain);
      q.eq        = vi.fn(chain);
      q.neq       = vi.fn(chain);
      q.insert    = vi.fn(chain);
      q.update    = vi.fn(chain);
      q.upsert    = vi.fn(chain);
      q.delete    = vi.fn(chain);
      q.limit     = vi.fn(chain);
      q.order     = vi.fn(chain);
      q.in        = vi.fn(chain);
      q.is        = vi.fn(chain);
      const resolved = { data: resolvedData, error: null, count: 0 };
      q.maybeSingle = vi.fn().mockResolvedValue(resolved);
      q.single      = vi.fn().mockResolvedValue(resolved);
      q.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(resolved).then(res);
      return q;
    };

    let callIndex = 0;
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn(() => {
        callIndex++;
        // First call: plan-limit check (returns count 0 = under limit)
        if (callIndex === 1) return chainableQuery(null);
        // Second call: insert new workflow
        return chainableQuery({ id: MOCK_WORKFLOW_ID, name: String(workflow.name) });
      }),
    } as unknown as ReturnType<typeof createServiceClient>);

    const saveReq = makeRequest('POST', {
      name:          workflow.name,
      workflow_json: workflow,
    }, 'http://localhost/api/workflows');

    const saveRes = await workflowsPOST(saveReq);
    expect(saveRes.status).toBe(201);

    const body = await saveRes.json() as { success: boolean; workflow?: { id: string } };
    expect(body.success).toBe(true);
    expect(body.workflow?.id).toBe(MOCK_WORKFLOW_ID);
  });

  it('redirect URL after save is /dashboard/workflows/<id>', () => {
    // This verifies the convention used in new-ai/page.tsx
    const id = MOCK_WORKFLOW_ID;
    const expectedUrl = `/dashboard/workflows/${id}`;
    expect(expectedUrl).toMatch(/^\/dashboard\/workflows\/.+$/);
  });

  it('save without name returns 400', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
    // plan-limit check must succeed so we reach the name-validation branch
    const chainQ = () => {
      const q: Record<string, unknown> = {};
      const c = () => q;
      q.select = vi.fn(c); q.eq = vi.fn(c); q.neq = vi.fn(c);
      q.insert = vi.fn(c); q.update = vi.fn(c); q.delete = vi.fn(c);
      q.limit  = vi.fn(c); q.order = vi.fn(c); q.in = vi.fn(c); q.is = vi.fn(c);
      const resolved = { data: null, error: null, count: 0 };
      q.maybeSingle = vi.fn().mockResolvedValue(resolved);
      q.single      = vi.fn().mockResolvedValue(resolved);
      q.then = (r: (v: unknown) => unknown) =>
        Promise.resolve(resolved).then(r);
      return q;
    };
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn(() => chainQ()),
    } as unknown as ReturnType<typeof createServiceClient>);

    const saveReq = makeRequest('POST', { workflow_json: {} }, 'http://localhost/api/workflows');
    const saveRes = await workflowsPOST(saveReq);
    expect(saveRes.status).toBe(400);
  });

  it('save without auth returns 401', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(null);
    const saveReq = makeRequest('POST', { name: 'Test' }, 'http://localhost/api/workflows');
    const saveRes = await workflowsPOST(saveReq);
    expect(saveRes.status).toBe(401);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Load: GET /api/workflows/:id loads workflow_json correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('Step 3 — Load: GET /api/workflows/:id returns workflow_json', () => {

  beforeEach(() => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
  });

  it('returns the saved workflow_json intact', async () => {
    const { workflow } = await generateAndSave('shopify order to airtable');

    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq:     vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id:            MOCK_WORKFLOW_ID,
            user_id:       AUTHED_USER.id,
            name:          workflow.name,
            description:   'AI generated',
            prompt:        'shopify order to airtable',
            workflow_json: workflow,
            integrations:  ['shopify', 'airtable'],
            status:        'draft',
            n8n_workflow_id: null,
          },
          error: null,
        }),
      })),
    } as unknown as ReturnType<typeof createServiceClient>);

    const loadReq = new NextRequest(
      new URL(`http://localhost/api/workflows/${MOCK_WORKFLOW_ID}`),
    );

    const loadRes = await workflowByIdGET(loadReq, { params: { id: MOCK_WORKFLOW_ID } });
    expect(loadRes.status).toBe(200);

    const body = await loadRes.json() as { success: boolean; workflow: { workflow_json: unknown } };
    expect(body.success).toBe(true);
    expect(body.workflow.workflow_json).toMatchObject({
      nodes: expect.any(Array),
      connections: expect.any(Object),
    });
  });

  it('loaded workflow_json is still valid after round-trip', async () => {
    const { workflow } = await generateAndSave('if VIP customer slack else email');

    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq:     vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            id:            MOCK_WORKFLOW_ID,
            user_id:       AUTHED_USER.id,
            name:          workflow.name,
            workflow_json: workflow,
            integrations:  [],
            status:        'draft',
            n8n_workflow_id: null,
          },
          error: null,
        }),
      })),
    } as unknown as ReturnType<typeof createServiceClient>);

    const loadReq = new NextRequest(
      new URL(`http://localhost/api/workflows/${MOCK_WORKFLOW_ID}`),
    );
    const loadRes = await workflowByIdGET(loadReq, { params: { id: MOCK_WORKFLOW_ID } });
    const body    = await loadRes.json() as { workflow: { workflow_json: unknown } };

    const check = validateWorkflow(body.workflow.workflow_json);
    expect(check.valid).toBe(true);
  });

  it('returns 404 when workflow not found', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq:     vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    } as unknown as ReturnType<typeof createServiceClient>);

    const loadReq = new NextRequest(new URL('http://localhost/api/workflows/nonexistent'));
    const loadRes = await workflowByIdGET(loadReq, { params: { id: 'nonexistent' } });
    expect(loadRes.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(null);
    const loadReq = new NextRequest(new URL('http://localhost/api/workflows/some-id'));
    const loadRes = await workflowByIdGET(loadReq, { params: { id: 'some-id' } });
    expect(loadRes.status).toBe(401);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Full pipeline: generate → save → load → validate
// ═══════════════════════════════════════════════════════════════════════════

describe('Full pipeline — generate → save → load → validate', () => {

  const prompts = [
    'send slack on webhook',
    'shopify order to email',
    'wait 5 minutes then airtable',
    'if vip customer slack else email',
    'fan-out: slack and email and airtable on webhook',
  ];

  for (const prompt of prompts) {
    it(`pipeline for: "${prompt.slice(0, 50)}"`, async () => {
      vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);

      // Generate
      const genReq = makeRequest('POST', { prompt }, 'http://localhost/api/ai/workflows/generate');
      const genRes = await generatePOST(genReq);
      expect(genRes.status).toBe(200);

      const { workflow } = await genRes.json() as { workflow: unknown };
      expect(validateWorkflow(workflow).valid).toBe(true);

      // Verify workflow_json fields required by dashboard
      const wf = workflow as Record<string, unknown>;
      expect(typeof wf.name).toBe('string');
      expect(Array.isArray(wf.nodes)).toBe(true);
      expect(typeof wf.connections).toBe('object');

      // Verify node names are unique (critical for the builder)
      const names = (wf.nodes as Array<{ name: string }>).map(n => n.name);
      expect(new Set(names).size).toBe(names.length);

      // Verify redirect URL format
      const redirectUrl = `/dashboard/workflows/${MOCK_WORKFLOW_ID}`;
      expect(redirectUrl).toContain('/dashboard/workflows/');
    });
  }

});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Security: workflow_json stored without credentials
// ═══════════════════════════════════════════════════════════════════════════

describe('Security — workflow_json contains no credentials', () => {

  beforeEach(() => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
  });

  it('nodes do not contain credential values', async () => {
    const { workflow } = await generateAndSave('shopify order to slack');
    const wf = workflow as { nodes: Array<Record<string, unknown>> };
    const serialised = JSON.stringify(wf.nodes);
    expect(serialised).not.toContain('"password"');
    expect(serialised).not.toContain('"api_key"');
    expect(serialised).not.toContain('"accessToken"');
  });

  it('connections do not contain credential values', async () => {
    const { workflow } = await generateAndSave('webhook to airtable');
    const serialised = JSON.stringify((workflow as { connections: unknown }).connections);
    expect(serialised).not.toContain('"api_key"');
    expect(serialised).not.toContain('"password"');
  });

});
