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
  {
    id: 'p-whatsapp', name: 'Whatsapp Sales Agent', category: 'sales', description: 'WhatsApp-based sales agent',
    intent_keywords: ['whatsapp', 'sales agent'], required_tools: [], optional_tools: [],
    required_capabilities: [], risk: 'low', estimated_cost: 0, estimated_complexity: 'simple',
    schedule_patterns: [], examples: [], popularity_score: 100, kind: 'abstract_template',
    classification: baseClassification(),
  },
  {
    id: 'p-support', name: 'Customer Support', category: 'support', description: 'Customer support ticketing',
    intent_keywords: ['support ticket', 'customer support'], required_tools: [], optional_tools: [],
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

  it('a genuinely WhatsApp-specific prompt still correctly matches a WhatsApp-flavored capability/pattern (the fix removes false positives, not true positives)', async () => {
    const { analyzeAutomationPrompt } = await import('../lib/automation');
    const brain = await analyzeAutomationPrompt(
      'When a customer sends a WhatsApp message, use AI to reply and log it in a WhatsApp sales tracker.',
    );
    const patternNames = brain.matchedPatterns.map((p) => p.name.toLowerCase());
    const capabilityKeys = brain.capabilities.map((c) => c.key);
    const hasWhatsappSignal =
      patternNames.some((n) => n.includes('whatsapp')) || capabilityKeys.some((k) => k.includes('whatsapp'));
    expect(hasWhatsappSignal, `patterns: ${patternNames.join(', ')} | capabilities: ${capabilityKeys.join(', ')}`).toBe(true);
  });
});
