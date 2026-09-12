/**
 * Phase 9.8.1 — Builder Deterministic Activation Hotfix.
 *
 * Root cause (Phase 9.8 production investigation, Brahim's real Founder
 * account): the Builder's "Approve + Deploy" button sent the literal
 * string "Approve and deploy this workflow now." through the normal AI
 * chat pipeline (POST /api/conversation/stream), which re-ran
 * lib/automation/engine.ts's classifier on that content-free string every
 * time, hallucinating unrelated verticals (Customer Support, WhatsApp
 * Sales Agent, Telegram) and in one case letting the model call
 * generate_workflow_json again instead of actually deploying.
 *
 * This suite pins the fix as executable, CI-enforced invariants across
 * three layers: (A) the frontend source no longer contains the dangerous
 * pattern at all, (B) generation persists the exact reviewed
 * workflow_json immediately, and (C) the classifier itself returns a
 * truthful "no confident match" for content that doesn't warrant one,
 * instead of forcing a nearest-vertical guess.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── A: chat-interface.tsx source invariants ───────────────────────────────

describe('A — Approve + Deploy is a deterministic REST call, never a chat message', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'components/builder/chat-interface.tsx'),
    'utf8',
  );

  it('never sends a natural-language deploy confirmation through handleSend()', () => {
    expect(source).not.toMatch(/handleSend\(\s*['"]Approve/i);
  });

  it('onDeploy is wired to handleApproveDeploy, not an inline handleSend call', () => {
    expect(source).toMatch(/onDeploy=\{handleApproveDeploy\}/);
  });

  it('handleApproveDeploy calls POST /api/workflows/[id]/lifecycle directly', () => {
    const fnMatch = source.match(/async function handleApproveDeploy\(\)[\s\S]*?\n  \}/);
    expect(fnMatch, 'handleApproveDeploy function not found').toBeTruthy();
    const body = fnMatch![0];
    expect(body).toMatch(/\/api\/workflows\/\$\{workflowId\}\/lifecycle/);
    expect(body).toMatch(/action:\s*'activate'/);
    // Zero LLM/chat pipeline, zero legacy n8n deploy tool, from this function.
    expect(body).not.toMatch(/\/api\/conversation\/stream/);
    expect(body).not.toMatch(/handleSend/);
    expect(body).not.toMatch(/deploy_workflow_to_n8n/);
    expect(body).not.toMatch(/generate_workflow_json/);
  });

  it('the button is disabled while activating (no duplicate request from a rapid double-click)', () => {
    expect(source).toMatch(/if \(!workflowId \|\| isActivating\) return;/);
  });
});

// ─── A3: "Open workflow" targets the canonical detail page, not the webhook ─
//
// Phase 9.8.3 -- production nav bug found during Founder manual test: after
// activation, "Open workflow" linked straight to the POST-only webhook
// endpoint (/api/workflows/[id]/webhook). Clicking it in a browser issues a
// GET, which the route (only exports POST) always answers with 405 --
// proven separately via a real production workflow with 0 executions
// recorded despite the accidental GET (confirming no execution is created
// by a bare GET). Root cause: handleApproveDeploy() set deployState.workflowUrl
// to the webhook URL directly.

describe('A3 — "Open workflow" targets the canonical workflow detail page, not /api/...', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'components/builder/chat-interface.tsx'),
    'utf8',
  );

  it('handleApproveDeploy sets workflowUrl to the canonical /dashboard/workflows/[id] page', () => {
    const fnMatch = source.match(/async function handleApproveDeploy\(\)[\s\S]*?\n  \}/);
    expect(fnMatch, 'handleApproveDeploy function not found').toBeTruthy();
    const body = fnMatch![0];
    expect(body).toMatch(/workflowUrl:\s*`\/dashboard\/workflows\/\$\{workflowId\}`/);
  });

  it('the webhook endpoint is stored separately (webhookUrl), never assigned to workflowUrl', () => {
    const fnMatch = source.match(/async function handleApproveDeploy\(\)[\s\S]*?\n  \}/);
    const body = fnMatch![0];
    expect(body).toMatch(/webhookUrl:\s*hasWebhookTrigger[\s\S]*?\/api\/workflows\/\$\{workflowId\}\/webhook/);
    // The webhook endpoint string must not be the value assigned to workflowUrl.
    expect(body).not.toMatch(/workflowUrl:\s*`[^`]*\/api\/workflows/);
  });

  it('WorkflowSuccessCard never targets /api/... for its "Open workflow" link', () => {
    const cardMatch = source.match(/function WorkflowSuccessCard\([\s\S]*?\n}/);
    expect(cardMatch, 'WorkflowSuccessCard not found').toBeTruthy();
    const body = cardMatch![0];
    const anchorMatch = body.match(/<a href=\{url\}[\s\S]*?Open workflow/);
    expect(anchorMatch, 'Open workflow anchor not found').toBeTruthy();
    expect(body).not.toMatch(/<a href=\{url\}[^>]*>[\s\S]{0,50}\/api\/workflows/);
  });

  it('WorkflowSuccessCard renders the webhook URL separately with its own Copy control, when present', () => {
    const cardMatch = source.match(/function WorkflowSuccessCard\([\s\S]*?\n}/);
    const body = cardMatch![0];
    expect(body).toMatch(/webhookUrl/);
    expect(body).toMatch(/Copy URL/);
    expect(body).toMatch(/expects POST/i);
  });

  it('the canonical workflow detail route exists at app/dashboard/workflows/[id]/page.tsx', () => {
    const exists = fs.existsSync(path.join(process.cwd(), 'app/dashboard/workflows/[id]/page.tsx'));
    expect(exists).toBe(true);
  });
});

// ─── B: legacy n8n deploy tools fully removed from the AI tool registry ────

describe('A2 — legacy n8n deploy tools removed from the agent tool registry', () => {
  it('AGENT_TOOLS no longer registers deploy_workflow_to_n8n or activate_workflow', async () => {
    const { AGENT_TOOLS } = await import('../lib/agent/tools');
    const names = AGENT_TOOLS.map((t) => ('function' in t ? t.function.name : ''));
    expect(names).not.toContain('deploy_workflow_to_n8n');
    expect(names).not.toContain('activate_workflow');
    // generate_workflow_json and test_workflow remain -- only the two
    // external-n8n deploy tools were removed.
    expect(names).toContain('generate_workflow_json');
    expect(names).toContain('test_workflow');
  });
});

// ─── C: generation persists the exact reviewed workflow immediately ───────

type Row = Record<string, unknown>;
let workflowRows: Row[];
let conversationRows: Row[];
let mutationRows: Row[];

function baseClassification(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kind: 'abstract_template',
    providers: [],
    domains: [],
    confidence: 50,
    origin: 'db',
    identityLocked: false,
    lockReason: null,
    lockEvidence: [],
    ...overrides,
  };
}

// Synthetic pattern rows reproducing the exact shape of the Phase 9.8
// production bug: patterns with a high popularity_score but ZERO keyword
// or capability overlap with a generic/content-free prompt. Under the old
// scorePattern() (popularity alone could clear the score > 0 threshold),
// these would incorrectly surface as matches; under the fix, they must not.
const SYNTHETIC_PATTERNS = [
  // Faithful reproduction of the REAL production automation_patterns row
  // that caused the Phase 9.8 incident (confirmed via direct DB
  // inspection: "Whatsapp Sales Agent Pattern 18", id
  // c668080c-e7d7-49c3-ae9a-7d0edef6c594) -- intent_keywords include
  // generic filler terms ("automation", "agent", "ai") that appear in
  // nearly every prompt, not just WhatsApp ones. This is what a purely
  // synthetic, "obviously distinct" fixture would have missed.
  {
    id: 'p-whatsapp-18', name: 'Whatsapp Sales Agent Pattern 18', category: 'whatsapp_sales_agent',
    description: 'WhatsApp-based sales agent',
    intent_keywords: ['whatsapp sales agent', 'sales', 'automation', 'agent', 'ai'],
    required_tools: ['whatsapp', 'hubspot'], optional_tools: ['supabase', 'openai', 'webhook'],
    required_capabilities: ['send_message', 'receive_message', 'crm'],
    risk: 'medium', estimated_cost: 0.02, estimated_complexity: 'moderate',
    schedule_patterns: [], examples: [], popularity_score: 58, kind: 'provider_specific',
    classification: baseClassification({ kind: 'provider_specific' }),
  },
  {
    id: 'p-support', name: 'Customer Support', category: 'support', description: 'Customer support ticketing',
    intent_keywords: ['support ticket', 'customer support', 'automation', 'workflow'],
    required_tools: [], optional_tools: [],
    required_capabilities: [], risk: 'low', estimated_cost: 0, estimated_complexity: 'simple',
    schedule_patterns: [], examples: [], popularity_score: 90, kind: 'abstract_template',
    classification: baseClassification(),
  },
];

function makeFakeDb() {
  return {
    from(table: string) {
      if (table === 'automation_patterns') {
        return { select: () => ({ limit: async () => ({ data: SYNTHETIC_PATTERNS, error: null }) }) };
      }
      if (table === 'skill_packs') {
        return { select: () => ({ limit: async () => ({ data: [], error: null }) }) };
      }
      if (table === 'workflows') {
        return {
          insert(row: Row) {
            const inserted = { id: `wf-${workflowRows.length + 1}`, ...row };
            workflowRows.push(inserted);
            return { select: () => ({ single: async () => ({ data: { id: inserted.id }, error: null }) }) };
          },
          update(patch: Row) {
            return {
              eq(col: string, val: unknown) {
                return {
                  eq() {
                    const targets = workflowRows.filter((r) => r[col] === val);
                    for (const t of targets) Object.assign(t, patch);
                    return Promise.resolve({ error: null });
                  },
                };
              },
            };
          },
        };
      }
      if (table === 'workflow_graph_mutations') {
        return {
          insert(row: Row) {
            mutationRows.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === 'automation_conversations') {
        return {
          update(patch: Row) {
            return {
              eq(col: string, val: unknown) {
                return {
                  eq(col2: string, val2: unknown) {
                    const targets = conversationRows.filter((r) => r[col] === val && r[col2] === val2);
                    for (const t of targets) Object.assign(t, patch);
                    return Promise.resolve({ error: null });
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table in this fake: ${table}`);
    },
  };
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeFakeDb()),
}));

vi.mock('@/lib/graph/live-graph-manager', () => ({
  liveGraphManager: {
    createGraphVersion: vi.fn(async () => ({ version: 1 })),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  workflowRows = [];
  conversationRows = [{ session_id: 'sess-1', user_id: 'user-1' }];
  mutationRows = [];
});

describe('B — ensurePersistedWorkflowDraft() persists the exact reviewed workflow', () => {
  it('inserts a workflows row whose workflow_json exactly matches the generated nodes/connections', async () => {
    const { ensurePersistedWorkflowDraft } = await import('../lib/agent/executor');

    const nodes = [
      { id: '1', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: { path: 'customer-classification' } },
      { id: '2', name: 'Amount Check', type: 'n8n-nodes-base.if', parameters: { conditions: { number: [{ value1: '={{$json["orderAmount"]}}', operation: 'larger', value2: 100 }] } } },
      { id: '3', name: 'Mark VIP', type: 'n8n-nodes-base.set', parameters: { fields: { string: [{ name: 'customerStatus', value: 'VIP' }] } } },
      { id: '4', name: 'Mark Standard', type: 'n8n-nodes-base.set', parameters: { fields: { string: [{ name: 'customerStatus', value: 'Standard' }] } } },
    ];
    const connections = {
      'Webhook Trigger': { main: [[{ node: 'Amount Check', type: 'main', index: 0 }]] },
      'Amount Check': { main: [[{ node: 'Mark VIP', type: 'main', index: 0 }], [{ node: 'Mark Standard', type: 'main', index: 0 }]] },
    };

    const workflowId = await ensurePersistedWorkflowDraft({
      userId: 'user-1',
      sessionId: 'sess-1',
      args: {
        workflow_name: 'Customer Classification Webhook',
        workflow_json: JSON.stringify({ nodes, connections }),
      },
    });

    expect(workflowId).toBeTruthy();
    expect(workflowRows).toHaveLength(1);
    expect(workflowRows[0].workflow_json).toEqual({ nodes, connections });
    expect(workflowRows[0].name).toBe('Customer Classification Webhook');
    expect(workflowRows[0].status).toBe('draft');
  });

  it('returns null for an anonymous/unauthenticated session (never persists without a real user)', async () => {
    const { ensurePersistedWorkflowDraft } = await import('../lib/agent/executor');
    const workflowId = await ensurePersistedWorkflowDraft({
      userId: null,
      sessionId: 'sess-1',
      args: { workflow_name: 'x', workflow_json: '{"nodes":[],"connections":{}}' },
    });
    expect(workflowId).toBeNull();
    expect(workflowRows).toHaveLength(0);
  });
});

// ─── D: classification drift fix ───────────────────────────────────────────

describe('C — automation classification is confidence-aware, not forced to a nearest vertical', () => {
  it('the exact Founder prompt (generic webhook + condition + set) does not get classified as WhatsApp Sales Agent, Customer Support, or any Telegram/WhatsApp-flavored pattern', async () => {
    const { analyzeAutomationPrompt } = await import('../lib/automation');
    const prompt =
      'Create a webhook automation that receives a customer name and order amount. ' +
      'If the amount is greater than 100, mark the customer as VIP; otherwise mark them as Standard.';

    const brain = await analyzeAutomationPrompt(prompt);

    const patternNames = brain.matchedPatterns.map((p) => p.name.toLowerCase());
    for (const forbidden of ['whatsapp', 'telegram', 'customer support', 'sales agent']) {
      expect(patternNames.some((n) => n.includes(forbidden)), `matched patterns: ${patternNames.join(', ')}`).toBe(false);
    }

    const capabilityKeys = brain.capabilities.map((c) => c.key);
    expect(capabilityKeys).not.toContain('chatbot');
  });

  it('a content-free control message ("Approve and deploy this workflow now.") produces no fabricated capabilities and no hallucinated vertical pattern', async () => {
    const { analyzeAutomationPrompt } = await import('../lib/automation');
    const brain = await analyzeAutomationPrompt('Approve and deploy this workflow now.');

    // The exact regression from the Phase 9.8 incident: this used to
    // inject a fake "chatbot"/"notifications" capability baseline and
    // then hallucinate a vertical pattern (Customer Support) from it.
    expect(brain.capabilities).toEqual([]);

    // No genuine signal exists in this message, so any pattern returned
    // here must be the truthful generic fallback (category 'general',
    // low confidence, origin 'enriched') -- never a hallucinated specific
    // vertical like Customer Support/WhatsApp/Telegram.
    for (const pattern of brain.matchedPatterns) {
      expect(pattern.category).toBe('general');
      expect(pattern.classification.confidence).toBeLessThanOrEqual(30);
      const nameLower = pattern.name.toLowerCase();
      for (const forbidden of ['whatsapp', 'telegram', 'customer support', 'sales agent']) {
        expect(nameLower).not.toContain(forbidden);
      }
    }
  });

  it('a genuinely WhatsApp-specific prompt still correctly detects WhatsApp as a provider and infers real messaging capabilities (the fix removes false positives, not true positives)', async () => {
    const { analyzeAutomationPrompt } = await import('../lib/automation');
    const brain = await analyzeAutomationPrompt(
      'When a customer sends a WhatsApp message, use AI to reply and log it in a WhatsApp sales tracker.',
    );
    const providers = brain.providerResolutions.map((p) => p.provider.toLowerCase());
    const capabilityKeys = brain.capabilities.map((c) => c.key);

    expect(providers, `providers: ${providers.join(', ')}`).toContain('whatsapp');
    expect(capabilityKeys).toContain('send_message');
    expect(capabilityKeys).toContain('receive_message');
  });
});

// ─── E: Phase 9.8.2 — generate_workflow_json's schema no longer biases the
// model toward inventing an external platform/messaging step for a purely
// internal branch-and-set request ───────────────────────────────────────────

describe('D — generate_workflow_json tool schema does not force an external platform for internal branch-and-set automations', () => {
  it('platform is no longer a required parameter', async () => {
    const { AGENT_TOOLS } = await import('../lib/agent/tools');
    const tool = AGENT_TOOLS.find((t) => 'function' in t && t.function.name === 'generate_workflow_json');
    expect(tool).toBeTruthy();
    if (!tool || !('function' in tool)) return;
    const required = (tool.function.parameters as { required?: string[] })?.required ?? [];
    expect(required).not.toContain('platform');
  });

  it("action's description offers internal/deterministic examples, not only external-messaging ones", async () => {
    const { AGENT_TOOLS } = await import('../lib/agent/tools');
    const tool = AGENT_TOOLS.find((t) => 'function' in t && t.function.name === 'generate_workflow_json');
    if (!tool || !('function' in tool)) throw new Error('tool not found');
    const props = (tool.function.parameters as { properties?: Record<string, { description?: string }> })?.properties ?? {};
    const actionDesc = (props.action?.description ?? '').toLowerCase();
    const blockDesc = (props.block_blueprint?.description ?? '').toLowerCase();
    const platformDesc = (props.platform?.description ?? '').toLowerCase();

    // Internal-transformation examples must exist, not just messaging ones.
    expect(actionDesc).toMatch(/set_field|classify_record|update_status/);
    expect(blockDesc).toMatch(/condition|set_field/);
    // platform's description must explicitly say it can be omitted.
    expect(platformDesc).toMatch(/omit/);
  });

  it("the tool description explicitly warns against inventing a messaging/notification step for mark/tag/classify requests", async () => {
    const { AGENT_TOOLS } = await import('../lib/agent/tools');
    const tool = AGENT_TOOLS.find((t) => 'function' in t && t.function.name === 'generate_workflow_json');
    if (!tool || !('function' in tool)) throw new Error('tool not found');
    const description = (tool.function.description ?? '').toLowerCase();
    expect(description).toMatch(/mark|classify|tag/);
    expect(description).toMatch(/no external platform|omit platform/);
  });
});

describe('E — toProgressCards() deduplicates identical repeated errors from within-turn retries', () => {
  it('collapses consecutive identical "Hit a snag" events into one card with a retry count, matching the exact 3x production incident shape', async () => {
    const { toProgressCards } = await import('../lib/builder/runtime-state');
    const identicalError = {
      type: 'error' as const,
      label: 'Unsupported capability requested',
      detail: "This step type isn't available yet.",
    };
    const cards = toProgressCards([identicalError, identicalError, identicalError]);

    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Hit a snag');
    expect(cards[0].detail).toContain("This step type isn't available yet.");
    expect(cards[0].detail).toContain('3x');
  });

  it('does NOT collapse genuinely distinct errors into one card', async () => {
    const { toProgressCards } = await import('../lib/builder/runtime-state');
    const cards = toProgressCards([
      { type: 'error', label: 'Unsupported capability requested', detail: "This step type isn't available yet." },
      { type: 'error', label: 'Provider validation failed', detail: 'Missing: shopify | Extra: none' },
    ]);
    expect(cards).toHaveLength(2);
  });

  it('non-error events (e.g. successful generation) are never deduplicated away just because they repeat', async () => {
    const { toProgressCards } = await import('../lib/builder/runtime-state');
    const cards = toProgressCards([
      { type: 'generating_workflow', label: 'Workflow blueprint generated', detail: '4 nodes' },
      { type: 'generating_workflow', label: 'Workflow blueprint generated', detail: '4 nodes' },
    ]);
    // Identical successive events of any type are still collapsed (they
    // represent the same underlying occurrence repeated, e.g. a duplicate
    // SSE re-emit) -- this test documents that behavior explicitly rather
    // than leaving it implicit.
    expect(cards).toHaveLength(1);
    expect(cards[0].detail).toContain('2x');
  });
});
