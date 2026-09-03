/**
 * Phase 9.1.6 — Planner ↔ Runtime Capability Alignment.
 *
 * Proves the invariant: MagicFlux must never generate or allow activation
 * of a workflow containing a node the certified runtime cannot actually
 * execute.
 *
 * Sections:
 *   1. checkNodeCapability() — the shared source of truth
 *   2. Planner — createAutomationPlan() never returns an unsupported node
 *   3. Validator — rejects unsupported nodes (structural fail-closed)
 *   4. Activation — unsupported nodes cannot activate via the real lifecycle
 *   5. Runtime dispatch — set works for real; blocked types never misroute
 *   6. Supported workflows remain fully activatable (no over-blocking)
 *   7. Security/tenant behavior unchanged by the capability gate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkNodeCapability,
  isKnownNodeType,
  PROVIDER_EXACT_TYPES,
  DETERMINISTIC_EXACT_TYPES,
} from '../lib/workflow-runtime/node-capabilities';

// ─── Fake Supabase client for Section 6 (top-level: vi.mock is hoisted above
// everything else in this file regardless of where it's written, so the
// class/state it references must be declared at the top level too — see
// https://vitest.dev/guide/mocking/modules#how-it-works). Harmless for
// Sections 1-5, which never touch @/lib/supabase-server. ─────────────────────

const OWNER_ID = '00000000-0000-4000-8000-0000000000e1';
const WORKFLOW_ID = 'wf-capability-gate';
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private patch: Row | null = null;
  constructor(private rows: Row[]) {}
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
  select(): this { return this; }
  update(patch: Row): this { this.patch = patch; return this; }
  private matched(): Row[] {
    const m = this.rows.filter(r => this.filters.every(([c, v]) => r[c] === v));
    if (this.patch) for (const row of m) Object.assign(row, this.patch);
    return m;
  }
  async maybeSingle() { const m = this.matched(); return { data: m[0] ? { ...m[0] } : null, error: null }; }
  then<T>(resolve: (v: { data: Row[]; error: null }) => T) { return Promise.resolve(resolve({ data: this.matched(), error: null })); }
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (name: string) => new FakeQuery(tables[name] ?? (tables[name] = [])),
  })),
  getUserFromRequest: vi.fn(),
}));

vi.mock('@/lib/billing/plan-limits', () => ({
  canDeployWorkflow: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('@/lib/runtime/scheduler', () => ({
  validateScheduleTriggers: vi.fn(() => []),
  syncWorkflowSchedules: vi.fn(async () => undefined),
}));

vi.mock('@/lib/deployment/deployment-manager', () => ({
  DeploymentManager: vi.fn().mockImplementation(() => ({
    recordDeployment: vi.fn(async () => ({ id: 'dv-1', version: 1 })),
  })),
}));

// ─── 1. checkNodeCapability() ────────────────────────────────────────────────

describe('checkNodeCapability', () => {
  it('accepts every real provider handler type', () => {
    for (const type of PROVIDER_EXACT_TYPES) {
      if (['n8n-nodes-base.gmailtrigger', 'n8n-nodes-base.googledrive', 'n8n-nodes-base.googledrivetrigger'].includes(type)) continue;
      expect(checkNodeCapability({ type }).capable, type).toBe(true);
    }
  });

  it('accepts n8n-nodes-base.set (Phase 9.1.6 implemented handler)', () => {
    expect(DETERMINISTIC_EXACT_TYPES.has('n8n-nodes-base.set')).toBe(true);
    expect(checkNodeCapability({ type: 'n8n-nodes-base.set' }).capable).toBe(true);
  });

  it('accepts safe generic types', () => {
    // Phase 9.5.1A: 'n8n-nodes-base.code' removed from this list -- see the
    // dedicated "code/function nodes are unsupported" section below.
    for (const type of ['n8n-nodes-base.webhook', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.if', 'n8n-nodes-base.httpRequest']) {
      expect(checkNodeCapability({ type }).capable, type).toBe(true);
    }
  });

  it('blocks googleSheets, hubspot, twilio (no handler, no credential registry entry)', () => {
    for (const type of ['n8n-nodes-base.googleSheets', 'n8n-nodes-base.hubspot', 'n8n-nodes-base.twilio']) {
      const result = checkNodeCapability({ type });
      expect(result.capable, type).toBe(false);
      if (!result.capable) {
        expect(result.userMessage).not.toContain(type);
        expect(result.userMessage).not.toContain('n8n-nodes-base');
      }
    }
  });

  it('blocks errorTrigger despite matching the generic "trigger" substring', () => {
    expect(isKnownNodeType('n8n-nodes-base.errorTrigger')).toBe(true); // known to dispatch...
    expect(checkNodeCapability({ type: 'n8n-nodes-base.errorTrigger' }).capable).toBe(false); // ...but still blocked
  });

  it('blocks gmailTrigger despite being an exact HANDLER_NODE_ALLOWLIST entry', () => {
    expect(checkNodeCapability({ type: 'n8n-nodes-base.gmailTrigger' }).capable).toBe(false);
  });

  it('blocks googleDrive/googleDriveTrigger (known honest stub, no working credential path)', () => {
    expect(checkNodeCapability({ type: 'n8n-nodes-base.googleDrive' }).capable).toBe(false);
    expect(checkNodeCapability({ type: 'n8n-nodes-base.googleDriveTrigger' }).capable).toBe(false);
  });

  it('blocks a wait node configured for resume:"webhook" but allows ordinary waits', () => {
    expect(checkNodeCapability({ type: 'n8n-nodes-base.wait', parameters: { resume: 'webhook' } }).capable).toBe(false);
    expect(checkNodeCapability({ type: 'n8n-nodes-base.wait', parameters: { amount: 30 } }).capable).toBe(true);
    expect(checkNodeCapability({ type: 'n8n-nodes-base.wait' }).capable).toBe(true);
  });

  it('blocks a totally unrecognized type with a safe generic message', () => {
    const result = checkNodeCapability({ type: 'company.customThing' });
    expect(result.capable).toBe(false);
    if (!result.capable) {
      expect(result.userMessage).not.toContain('company.customThing');
      expect(result.userMessage.toLowerCase()).not.toContain('handler');
    }
  });

  // ── Phase 9.5.1A: code/function nodes are unsupported (traced Blocks ->
  // planner assembly -> node type -> handler routing exactly, see
  // node-capabilities.ts's BLOCKLIST comment) ──────────────────────────────

  it('blocks n8n-nodes-base.code (regression test #1) despite matching the generic "code" substring', () => {
    expect(isKnownNodeType('n8n-nodes-base.code')).toBe(true); // known to dispatch (to codeHandler)...
    const result = checkNodeCapability({ type: 'n8n-nodes-base.code' });
    expect(result.capable).toBe(false); // ...but still blocked
    if (!result.capable) {
      expect(result.userMessage).not.toContain('n8n-nodes-base');
      expect(result.userMessage.toLowerCase()).not.toContain('handler');
      expect(result.userMessage.toLowerCase()).not.toContain('sandbox');
      expect(result.userMessage.toLowerCase()).not.toContain('vm.runinnewcontext');
    }
  });

  it('blocks every other type that routes to the same disabled handler (regression test #2): function, functionItem, and case variants', () => {
    for (const type of ['n8n-nodes-base.function', 'n8n-nodes-base.functionItem', 'N8N-NODES-BASE.CODE', 'n8n-nodes-base.myCodeStep']) {
      expect(checkNodeCapability({ type }).capable, type).toBe(false);
    }
  });

  it('the code-block userMessage is generic and reusable, not type-specific (one message for the whole substring class)', () => {
    const codeMsg = checkNodeCapability({ type: 'n8n-nodes-base.code' });
    const funcMsg = checkNodeCapability({ type: 'n8n-nodes-base.function' });
    expect(codeMsg.capable).toBe(false);
    expect(funcMsg.capable).toBe(false);
    if (!codeMsg.capable && !funcMsg.capable) {
      expect(codeMsg.userMessage).toBe(funcMsg.userMessage);
    }
  });
});

// ─── 2. Planner — never generates an unsupported node ────────────────────────

describe('planner: createAutomationPlan never returns an unsupported node', () => {
  it('throws UNSUPPORTED_REQUIREMENTS instead of returning a plan that references hubspot', async () => {
    const { createAutomationPlan } = await import('../lib/planner');
    expect(() => createAutomationPlan('When a webhook is received, add the contact to hubspot crm'))
      .toThrow(/UNSUPPORTED_REQUIREMENTS/);
  });

  it('throws UNSUPPORTED_REQUIREMENTS instead of returning a plan that references twilio/sms', async () => {
    const { createAutomationPlan } = await import('../lib/planner');
    expect(() => createAutomationPlan('When a webhook is received, send an sms via twilio to the customer'))
      .toThrow(/UNSUPPORTED_REQUIREMENTS/);
  });

  it('throws UNSUPPORTED_REQUIREMENTS instead of returning a plan that references google sheets', async () => {
    const { createAutomationPlan } = await import('../lib/planner');
    expect(() => createAutomationPlan('When a webhook is received, log it to a google sheets spreadsheet'))
      .toThrow(/UNSUPPORTED_REQUIREMENTS/);
  });

  it('throws UNSUPPORTED_REQUIREMENTS instead of returning a plan with an approval/human-review step', async () => {
    const { createAutomationPlan } = await import('../lib/planner');
    expect(() => createAutomationPlan('When a webhook is received, require manager approval before sending the email'))
      .toThrow(/UNSUPPORTED_REQUIREMENTS/);
  });

  it('the thrown error message is user-safe — no raw node type or internal handler jargon', async () => {
    const { createAutomationPlan } = await import('../lib/planner');
    try {
      createAutomationPlan('When a webhook is received, add the contact to hubspot crm');
      throw new Error('expected createAutomationPlan to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('n8n-nodes-base');
      expect(message.toLowerCase()).not.toContain('handler not found');
    }
  });

  it('still generates a normal plan for a fully-supported request', async () => {
    const { createAutomationPlan } = await import('../lib/planner');
    const result = createAutomationPlan('When a webhook is received, send a slack message to the team channel');
    expect(result.n8nJson.nodes.length).toBeGreaterThan(0);
    for (const node of result.n8nJson.nodes) {
      expect(checkNodeCapability({ type: node.type, parameters: node.parameters }).capable, node.type).toBe(true);
    }
  });

  // Phase 9.5.1A regression test #3: the planner used to force-insert a
  // 'transform' step (-> code_transform -> n8n-nodes-base.code) as the
  // FIRST step of every single generated plan, regardless of whether the
  // prompt asked for it -- see buildPlanSteps() in lib/planner/index.ts.
  // That made every plan permanently un-generatable once code became
  // correctly unsupported. Confirms that's fixed (no forced insertion),
  // and that a prompt genuinely asking for custom parsing/processing logic
  // -- something only a code node could ever have done -- now surfaces as
  // an honest UNSUPPORTED_REQUIREMENTS instead of either crashing or
  // silently generating an unusable workflow.
  it('a plan with no explicit transform/parse request never contains a code node (the old forced-insertion bug)', async () => {
    const { createAutomationPlan } = await import('../lib/planner');
    const result = createAutomationPlan('When a webhook is received, send a slack message to the team channel');
    const types = result.n8nJson.nodes.map(n => n.type.toLowerCase());
    expect(types.some(t => t.includes('code') || t.includes('function'))).toBe(false);
  });

  it('a prompt explicitly requesting custom data parsing throws UNSUPPORTED_REQUIREMENTS rather than silently using a code node', async () => {
    const { createAutomationPlan } = await import('../lib/planner');
    expect(() => createAutomationPlan('When a webhook is received, parse and extract custom fields from the payload, then send a slack message'))
      .toThrow(/UNSUPPORTED_REQUIREMENTS/);
  });
});

// ─── 3 & 4. Validator + activation fail-closed ───────────────────────────────

describe('validator + activation: unsupported nodes are rejected before they can go live', () => {
  it('validateWorkflow rejects a workflow containing an unsupported node', async () => {
    const { validateWorkflow } = await import('../lib/workflow-validator');
    const r = validateWorkflow({
      nodes: [
        { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
        { name: 'CRM', type: 'n8n-nodes-base.hubspot' },
      ],
      connections: { Trigger: { main: [[{ node: 'CRM' }]] } },
    });
    expect(r.valid).toBe(false);
  });

  it('an old/imported workflow with an unsupported node fails validation the same way a freshly generated one would', async () => {
    const { validateWorkflow } = await import('../lib/workflow-validator');
    // Simulates a hand-edited or legacy-imported workflow_json, not something
    // the current planner produced.
    const imported = {
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.webhook' },
        { name: 'Legacy Sheets Sync', type: 'n8n-nodes-base.googleSheets', parameters: { operation: 'append' } },
      ],
      connections: { Start: { main: [[{ node: 'Legacy Sheets Sync' }]] } },
    };
    const r = validateWorkflow(imported);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.code === 'UNSUPPORTED_NODE_CAPABILITY')).toBe(true);
  });

  it('a workflow with a silently-broken approval step (wait+resume:webhook) fails validation, not just a warning', async () => {
    const { validateWorkflow } = await import('../lib/workflow-validator');
    const r = validateWorkflow({
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.webhook' },
        { name: 'Wait for Approval', type: 'n8n-nodes-base.wait', parameters: { resume: 'webhook', options: { webhookSuffix: 'approval' } } },
      ],
      connections: { Start: { main: [[{ node: 'Wait for Approval' }]] } },
    });
    expect(r.valid).toBe(false);
  });

  it('a fully-supported workflow remains valid and activatable', async () => {
    const { validateWorkflow } = await import('../lib/workflow-validator');
    const r = validateWorkflow({
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.webhook' },
        { name: 'Notify', type: 'n8n-nodes-base.slack' },
      ],
      connections: { Start: { main: [[{ node: 'Notify' }]] } },
    });
    expect(r.valid).toBe(true);
  });

  // Phase 9.5.1A regression test #4: a hand-crafted/imported/bypassed
  // workflow_json (not planner output) containing a code node must still
  // fail validation -- the capability gate is not something the planner
  // alone enforces.
  it('a directly-constructed workflow with a code node fails validation, not just planner-generated ones', async () => {
    const { validateWorkflow } = await import('../lib/workflow-validator');
    const r = validateWorkflow({
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.webhook' },
        { name: 'Custom Logic', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return $input.all();' } },
      ],
      connections: { Start: { main: [[{ node: 'Custom Logic' }]] } },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.code === 'UNSUPPORTED_NODE_CAPABILITY')).toBe(true);
  });

  it('a directly-constructed workflow with a legacy Function node also fails validation (same disabled handler)', async () => {
    const { validateWorkflow } = await import('../lib/workflow-validator');
    const r = validateWorkflow({
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.webhook' },
        { name: 'Legacy Function', type: 'n8n-nodes-base.function' },
      ],
      connections: { Start: { main: [[{ node: 'Legacy Function' }]] } },
    });
    expect(r.valid).toBe(false);
  });

  // lib/validator (the deterministic-Blocks scorer used by the live
  // /builder flow) is covered separately in
  // tests/legacy-validator-capability.test.ts, which already has the
  // BLOCKS[id].buildN8nNode() splicing fixture this needs -- extended
  // there with a code_transform case rather than duplicated here.
});

// ─── 5. Runtime dispatch ──────────────────────────────────────────────────────

describe('runtime dispatch: set works for real; blocked types never misroute', () => {
  const LIVE_CTX = { mode: 'live' as const, integrations: [], sampleData: {}, previews: { emails: [], slackMessages: [], airtableRecords: [] } };

  it('set node actually transforms data in live mode (not a stub)', async () => {
    const { dispatchNode } = await import('../lib/workflow-runtime/node-handlers');
    const node = {
      type: 'n8n-nodes-base.set',
      parameters: { mode: 'manual', includeOtherFields: false, fields: { values: [{ name: 'greeting', value: 'hello' }, { name: 'count', type: 'number', value: '3' }] } },
    };
    const r = await dispatchNode(node, { existing: 'data' }, LIVE_CTX);
    expect(r.status).toBe('success');
    expect(r.outputData).toEqual({ greeting: 'hello', count: 3 });
  });

  it('set node merges fields when includeOtherFields is true', async () => {
    const { dispatchNode } = await import('../lib/workflow-runtime/node-handlers');
    const node = {
      type: 'n8n-nodes-base.set',
      parameters: { fields: { values: [{ name: 'added', value: 'yes' }] }, includeOtherFields: true },
    };
    const r = await dispatchNode(node, { existing: 'data' }, LIVE_CTX);
    expect(r.outputData).toEqual({ existing: 'data', added: 'yes' });
  });

  it('errorTrigger fails clean in live mode instead of silently passing through as a webhook trigger would', async () => {
    const { dispatchNode } = await import('../lib/workflow-runtime/node-handlers');
    const r = await dispatchNode({ type: 'n8n-nodes-base.errorTrigger' }, { some: 'payload' }, LIVE_CTX);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('UNSUPPORTED_NODE_TYPE');
  });

  it('an approval wait node fails clean in live mode instead of silently skipping the pause', async () => {
    const { dispatchNode } = await import('../lib/workflow-runtime/node-handlers');
    const r = await dispatchNode(
      { type: 'n8n-nodes-base.wait', parameters: { resume: 'webhook' } },
      { some: 'payload' },
      LIVE_CTX,
    );
    // Must NOT be the old silent-success behavior (status 'success' would mean
    // it skipped the approval gate entirely, as it did before Phase 9.1.6).
    expect(r.status).toBe('failed');
  });

  it('gmailTrigger fails clean instead of misfiring emailHandler with garbage parameters', async () => {
    const { dispatchNode } = await import('../lib/workflow-runtime/node-handlers');
    const r = await dispatchNode({ type: 'n8n-nodes-base.gmailTrigger' }, {}, LIVE_CTX);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('UNSUPPORTED_NODE_TYPE');
  });
});

// ─── 6. Capability checks cannot be bypassed through the lifecycle API ───────

describe('lifecycle API: capability gate cannot be bypassed', () => {
  beforeEach(() => {
    tables = {
      workflows: [{
        id: WORKFLOW_ID,
        user_id: OWNER_ID,
        status: 'draft',
        workflow_json: {
          nodes: [
            { name: 'Start', type: 'n8n-nodes-base.webhook' },
            { name: 'CRM', type: 'n8n-nodes-base.hubspot' },
          ],
          connections: { Start: { main: [[{ node: 'CRM' }]] } },
        },
      }],
    };
  });

  it('activateWorkflow() rejects a workflow with an unsupported node even when called directly (not just through /builder)', async () => {
    const { activateWorkflow } = await import('../lib/workflow/lifecycle');
    const result = await activateWorkflow(OWNER_ID, WORKFLOW_ID);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe('error');
    }
    // Never transitioned past draft/error into active.
    expect(tables.workflows[0].status).not.toBe('active');
  });

  it('POST /api/workflows/[id]/lifecycle activate returns the failure — never a raw node type or "handler not found"', async () => {
    const { getUserFromRequest } = await import('@/lib/supabase-server');
    vi.mocked(getUserFromRequest).mockResolvedValue({ id: OWNER_ID } as never);

    const { POST } = await import('../app/api/workflows/[id]/lifecycle/route');
    const res = await POST(
      new Request(`http://localhost/api/workflows/${WORKFLOW_ID}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'activate' }) }) as never,
      { params: { id: WORKFLOW_ID } },
    );
    const payload = await res.json() as { success: boolean; errors?: string[] };
    expect(payload.success).toBe(false);
    const joined = (payload.errors ?? []).join(' ');
    expect(joined).not.toContain('n8n-nodes-base');
    expect(joined.toLowerCase()).not.toContain('handler not found');
  });
});
