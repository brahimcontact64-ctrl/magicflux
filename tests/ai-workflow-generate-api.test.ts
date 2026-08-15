/**
 * POST /api/ai/workflows/generate — route handler tests
 *
 * Strategy: import the real handler, mock only supabase-server so we can
 * control authentication without a real Supabase instance.  The generator
 * itself runs fully (deterministic, no external calls).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock supabase-server before any imports resolve ──────────────────────────

vi.mock('server-only', () => ({}));

vi.mock('@/lib/supabase-server', () => ({
  getUserFromRequest: vi.fn(),
  createServiceClient: vi.fn(),
}));

// ── Imports after mocks are registered ───────────────────────────────────────

import { POST } from '../app/api/ai/workflows/generate/route';
import { getUserFromRequest } from '@/lib/supabase-server';
import { validateWorkflow } from '../lib/workflow-validator';

// ── Helpers ───────────────────────────────────────────────────────────────────

const AUTHED_USER = { id: 'user-test-123', email: 'test@example.com' };

function makeRequest(body: unknown, url = 'http://localhost/api/ai/workflows/generate') {
  return new NextRequest(new URL(url), {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

async function callHandler(body: unknown, authed = true) {
  vi.mocked(getUserFromRequest).mockResolvedValue(authed ? AUTHED_USER : null);
  const req = makeRequest(body);
  return POST(req);
}

// ═══════════════════════════════════════════════════════════════════════════
// Authentication
// ═══════════════════════════════════════════════════════════════════════════

describe('Authentication', () => {

  it('returns 401 when user is not authenticated', async () => {
    const res = await callHandler({ prompt: 'webhook to slack' }, false);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Unauthorized');
  });

  it('proceeds when user is authenticated', async () => {
    const res = await callHandler({ prompt: 'webhook to slack' }, true);
    expect(res.status).toBe(200);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Input validation
// ═══════════════════════════════════════════════════════════════════════════

describe('Input validation', () => {

  beforeEach(() => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
  });

  it('returns 400 when prompt is missing', async () => {
    const res = await callHandler({});
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('prompt');
  });

  it('returns 400 when prompt is empty string', async () => {
    const res = await callHandler({ prompt: '' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('prompt');
  });

  it('returns 400 when prompt is whitespace only', async () => {
    const res = await callHandler({ prompt: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when prompt exceeds 1000 characters', async () => {
    const longPrompt = 'a'.repeat(1_001);
    const res = await callHandler({ prompt: longPrompt });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('1000');
  });

  it('accepts a prompt of exactly 1000 characters', async () => {
    const prompt = 'send slack on webhook ' + 'x'.repeat(1_000 - 22);
    const res = await callHandler({ prompt });
    expect(res.status).toBe(200);
  });

  it('returns 400 when prompt is a number', async () => {
    const res = await callHandler({ prompt: 42 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is malformed JSON (catch path)', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
    const req = new NextRequest(
      new URL('http://localhost/api/ai/workflows/generate'),
      {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    'NOT JSON }{',
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Successful generation — response shape
// ═══════════════════════════════════════════════════════════════════════════

describe('Successful generation — response shape', () => {

  beforeEach(() => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
  });

  it('returns 200 for a valid prompt', async () => {
    const res = await callHandler({ prompt: 'send a Slack message on new webhook' });
    expect(res.status).toBe(200);
  });

  it('response body has required fields', async () => {
    const res = await callHandler({ prompt: 'webhook to email' });
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('workflow');
    expect(body).toHaveProperty('valid',         true);
    expect(body).toHaveProperty('examplesUsed');
    expect(body).toHaveProperty('repairApplied');
  });

  it('returned workflow passes validateWorkflow()', async () => {
    const res = await callHandler({ prompt: 'Shopify order to Slack' });
    const body = await res.json() as { workflow: unknown };
    const check = validateWorkflow(body.workflow);
    expect(check.valid).toBe(true);
  });

  it('workflow has nodes and connections', async () => {
    const res = await callHandler({ prompt: 'webhook to airtable' });
    const body = await res.json() as { workflow: { nodes: unknown[]; connections: unknown } };
    expect(Array.isArray(body.workflow.nodes)).toBe(true);
    expect(body.workflow.nodes.length).toBeGreaterThan(0);
    expect(typeof body.workflow.connections).toBe('object');
  });

  it('workflow.name is a non-empty string', async () => {
    const res = await callHandler({ prompt: 'when shopify order arrive alert #orders' });
    const body = await res.json() as { workflow: { name: string } };
    expect(typeof body.workflow.name).toBe('string');
    expect(body.workflow.name.trim().length).toBeGreaterThan(0);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// examplesUsed — safe field stripping
// ═══════════════════════════════════════════════════════════════════════════

describe('examplesUsed — safe fields only', () => {

  beforeEach(() => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
  });

  it('examplesUsed is an array', async () => {
    const res = await callHandler({ prompt: 'notify Slack on order' });
    const body = await res.json() as { examplesUsed: unknown[] };
    expect(Array.isArray(body.examplesUsed)).toBe(true);
  });

  it('examplesUsed is non-empty', async () => {
    const res = await callHandler({ prompt: 'webhook to email' });
    const body = await res.json() as { examplesUsed: unknown[] };
    expect(body.examplesUsed.length).toBeGreaterThan(0);
  });

  it('each example has id, naturalLanguage, intent, tags', async () => {
    const res = await callHandler({ prompt: 'send Slack on webhook' });
    const body = await res.json() as { examplesUsed: Array<Record<string, unknown>> };
    for (const ex of body.examplesUsed) {
      expect(typeof ex.id).toBe('string');
      expect(typeof ex.naturalLanguage).toBe('string');
      expect(typeof ex.intent).toBe('string');
      expect(Array.isArray(ex.tags)).toBe(true);
    }
  });

  it('each example does NOT contain a workflow field (stripped)', async () => {
    const res = await callHandler({ prompt: 'log to airtable on shopify order' });
    const body = await res.json() as { examplesUsed: Array<Record<string, unknown>> };
    for (const ex of body.examplesUsed) {
      expect(ex).not.toHaveProperty('workflow');
    }
  });

  it('each example does NOT contain a credentials field', async () => {
    const res = await callHandler({ prompt: 'webhook to slack and airtable' });
    const body = await res.json() as { examplesUsed: Array<Record<string, unknown>> };
    for (const ex of body.examplesUsed) {
      expect(ex).not.toHaveProperty('credentials');
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// repairApplied flag
// ═══════════════════════════════════════════════════════════════════════════

describe('repairApplied', () => {

  beforeEach(() => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
  });

  it('is a boolean', async () => {
    const res = await callHandler({ prompt: 'webhook to slack' });
    const body = await res.json() as { repairApplied: unknown };
    expect(typeof body.repairApplied).toBe('boolean');
  });

  it('returned workflow is always valid regardless of repairApplied value', async () => {
    const prompts = [
      'webhook to slack',
      '',           // edge — but prompt validation catches this before generator
      'shopify order alert',
      'wait 10 min then email',
      'if VIP customer slack else email',
    ].filter(Boolean);

    for (const prompt of prompts) {
      const res = await callHandler({ prompt });
      const body = await res.json() as { workflow: unknown; valid: boolean };
      expect(body.valid).toBe(true);
      expect(validateWorkflow(body.workflow).valid).toBe(true);
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Security: no credentials in response
// ═══════════════════════════════════════════════════════════════════════════

describe('Security — no credentials in response', () => {

  beforeEach(() => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
  });

  it('response does not contain "password" field anywhere', async () => {
    const res = await callHandler({ prompt: 'shopify to email' });
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain('"password"');
  });

  it('response does not contain "api_key" field anywhere', async () => {
    const res = await callHandler({ prompt: 'webhook to airtable' });
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain('"api_key"');
  });

  it('response does not contain "credentials" field in examples', async () => {
    const res = await callHandler({ prompt: 'notify slack on order' });
    const body = await res.json() as { examplesUsed: Array<Record<string, unknown>> };
    for (const ex of body.examplesUsed) {
      expect(ex).not.toHaveProperty('credentials');
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Specific workflow patterns generated correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('Generated workflow correctness', () => {

  beforeEach(() => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
  });

  it('generates a workflow with a start node for any prompt', async () => {
    const prompts = [
      'send Slack on webhook',
      'Shopify order to email',
      'log to Airtable',
    ];
    for (const prompt of prompts) {
      const res = await callHandler({ prompt });
      const body = await res.json() as { workflow: { nodes: Array<{ type: string }> } };
      const hasStart = body.workflow.nodes.some(n =>
        n.type.toLowerCase().includes('trigger') ||
        n.type.toLowerCase().includes('webhook')
      );
      expect(hasStart).toBe(true);
    }
  });

  it('Shopify prompt produces a Shopify trigger node', async () => {
    const res = await callHandler({ prompt: 'when a Shopify order is placed notify the team' });
    const body = await res.json() as { workflow: { nodes: Array<{ type: string }> } };
    const hasShopify = body.workflow.nodes.some(n => n.type === 'n8n-nodes-base.shopifytrigger');
    expect(hasShopify).toBe(true);
  });

  it('Slack prompt produces a Slack node', async () => {
    const res = await callHandler({ prompt: 'send Slack alert on new webhook event' });
    const body = await res.json() as { workflow: { nodes: Array<{ type: string }> } };
    const hasSlack = body.workflow.nodes.some(n => n.type === 'n8n-nodes-base.slack');
    expect(hasSlack).toBe(true);
  });

  it('Email prompt produces an email node', async () => {
    const res = await callHandler({ prompt: 'send email notification on webhook' });
    const body = await res.json() as { workflow: { nodes: Array<{ type: string }> } };
    const hasEmail = body.workflow.nodes.some(n => n.type === 'n8n-nodes-base.emailsend');
    expect(hasEmail).toBe(true);
  });

  it('Airtable prompt produces an Airtable node', async () => {
    const res = await callHandler({ prompt: 'save data to Airtable on webhook' });
    const body = await res.json() as { workflow: { nodes: Array<{ type: string }> } };
    const hasAirtable = body.workflow.nodes.some(n => n.type === 'n8n-nodes-base.airtable');
    expect(hasAirtable).toBe(true);
  });

  it('wait prompt produces a Wait node', async () => {
    const res = await callHandler({ prompt: 'wait 10 minutes then send email' });
    const body = await res.json() as { workflow: { nodes: Array<{ type: string }> } };
    const hasWait = body.workflow.nodes.some(n => n.type === 'n8n-nodes-base.wait');
    expect(hasWait).toBe(true);
  });

  it('condition prompt produces an IF node', async () => {
    const res = await callHandler({ prompt: 'if VIP customer alert Slack, otherwise email' });
    const body = await res.json() as { workflow: { nodes: Array<{ type: string }> } };
    const hasIf = body.workflow.nodes.some(n => n.type === 'n8n-nodes-base.if');
    expect(hasIf).toBe(true);
  });

  it('all node names in workflow are unique', async () => {
    const res = await callHandler({ prompt: 'send Slack and email on webhook' });
    const body = await res.json() as { workflow: { nodes: Array<{ name: string }> } };
    const names = body.workflow.nodes.map(n => n.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all connection sources reference real node names', async () => {
    const res = await callHandler({ prompt: 'Shopify order to Airtable then Slack' });
    const body = await res.json() as {
      workflow: {
        nodes: Array<{ name: string }>;
        connections: Record<string, unknown>;
      }
    };
    const nodeNames = new Set(body.workflow.nodes.map(n => n.name));
    for (const src of Object.keys(body.workflow.connections)) {
      expect(nodeNames.has(src), `connection source "${src}" not in nodes`).toBe(true);
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// content-type header
// ═══════════════════════════════════════════════════════════════════════════

describe('Response headers', () => {

  it('returns Content-Type: application/json', async () => {
    vi.mocked(getUserFromRequest).mockResolvedValue(AUTHED_USER);
    const res = await callHandler({ prompt: 'webhook to slack' });
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('application/json');
  });

});
