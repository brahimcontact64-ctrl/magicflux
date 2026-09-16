/**
 * Phase 9.8.6 — Builder integration cards must use authoritative readiness.
 *
 * Root cause: lib/builder/runtime-state.ts's deriveIntegrationCards() hard-
 * coded `connected: provider === 'supabase' && !request` -- every real
 * provider (gmail, slack, airtable, ...) was unconditionally reported as
 * NOT connected regardless of actual connection state, and the one
 * exception was a magic string, not a general rule. This was never wired
 * to the server-computed, alias-aware credentialIntelligence readiness
 * (lib/credentials/storage.ts's verifyProviderConnection, fixed in Phase
 * 9.8.5), so the "Configure X -> Connect now" card and the Approve+Deploy
 * blocking gate stayed wrong even after that fix shipped.
 *
 * Fix: deriveIntegrationCards() now takes a 4th `readiness` argument (the
 * authoritative server-computed credentialIntelligence, already alias-
 * aware) and derives `connected` from it for every provider that has a
 * registered credential requirement; a provider with none (e.g. 'supabase',
 * the platform's own backend) is inherently ready, with no special-cased
 * provider name. `connected` no longer depends on whether a
 * (possibly stale/model-generated) credential request exists for that
 * provider.
 */

import { describe, it, expect } from 'vitest';
import { deriveIntegrationCards, type CredentialReadinessItem } from '../lib/builder/runtime-state';
import type { WorkflowGraphNode, WorkflowGraphSummary } from '../lib/agent/workflow-graph';

function makeNode(overrides: Partial<WorkflowGraphNode>): WorkflowGraphNode {
  return {
    id: overrides.id ?? 'node-1',
    name: overrides.name ?? 'Node',
    label: overrides.label ?? 'Node',
    type: overrides.type ?? 'n8n-nodes-base.unknown',
    position: [0, 0],
    integration: overrides.integration ?? 'core',
    provider: overrides.provider ?? null,
    capability: overrides.capability ?? 'workflow_step',
    requiresCredentials: overrides.requiresCredentials ?? true,
    credentialSchema: overrides.credentialSchema ?? [],
    displayName: overrides.displayName ?? overrides.name ?? 'Node',
    kind: overrides.kind ?? 'action',
    estimatedLatencyMs: 0,
    estimatedCostUsd: 0,
  };
}

function makeGraph(nodes: WorkflowGraphNode[]): WorkflowGraphSummary {
  return {
    nodes,
    edges: [],
    executionOrder: nodes.map((n) => n.id),
    integrations: [],
    estimatedLatencyMs: 0,
    estimatedCostUsd: 0,
    retryNodes: [],
    branches: 0,
  };
}

describe('deriveIntegrationCards — authoritative readiness (Phase 9.8.6)', () => {
  it('#1: a connected Gmail/Email integration reports connected:true on the card', () => {
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Send Email', type: 'n8n-nodes-base.gmail', provider: 'gmail', integration: 'gmail' }),
    ]);
    const readiness: CredentialReadinessItem[] = [{ provider: 'gmail', ready: true }];

    const cards = deriveIntegrationCards(graph, [], ['gmail'], readiness);

    expect(cards).toHaveLength(1);
    expect(cards[0].provider).toBe('gmail');
    expect(cards[0].connected).toBe(true);
  });

  it('#2: a disconnected Gmail integration reports connected:false', () => {
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Send Email', type: 'n8n-nodes-base.gmail', provider: 'gmail', integration: 'gmail' }),
    ]);
    const readiness: CredentialReadinessItem[] = [{ provider: 'gmail', ready: false }];

    const cards = deriveIntegrationCards(graph, [], ['gmail'], readiness);

    expect(cards).toHaveLength(1);
    expect(cards[0].connected).toBe(false);
  });

  it('#3: a connected Slack integration reports connected:true', () => {
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Post to Slack', type: 'n8n-nodes-base.slack', provider: 'slack', integration: 'slack' }),
    ]);
    const readiness: CredentialReadinessItem[] = [{ provider: 'slack', ready: true }];

    const cards = deriveIntegrationCards(graph, [], ['slack'], readiness);

    expect(cards).toHaveLength(1);
    expect(cards[0].connected).toBe(true);
  });

  it('#4: Supabase no longer needs a special hardcoded path -- it goes through the exact same general readiness mechanism as every other credentialed provider', () => {
    // Supabase DOES have registered credentials (project_url, anon_key --
    // see lib/credentials/provider-registry.ts), so unlike a genuinely
    // credential-free provider it is only "connected" when the authoritative
    // readiness map actually says so -- proving there is no hidden
    // `provider === 'supabase'` special case left anywhere in the function.
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Supabase Step', type: 'n8n-nodes-base.supabase', provider: 'supabase', integration: 'supabase' }),
    ]);

    const connectedCards = deriveIntegrationCards(graph, [], ['supabase'], [{ provider: 'supabase', ready: true }]);
    expect(connectedCards).toHaveLength(1);
    expect(connectedCards[0].connected).toBe(true);

    // Same provider, no readiness entry this time -- must now correctly
    // report disconnected, exactly like gmail/slack/any other provider
    // would (test #5). Under the old hardcoded rule this was unconditionally
    // true regardless of readiness; now it is not.
    const disconnectedCards = deriveIntegrationCards(graph, [], ['supabase'], []);
    expect(disconnectedCards[0].connected).toBe(false);
  });

  it('a provider with no registered credential requirement at all is inherently ready with no readiness entry needed', () => {
    // Distinguishes "no special case for this provider's NAME" (test #4,
    // where 'supabase' genuinely does require credentials) from "a
    // provider that truly requires nothing to connect stays usable". Every
    // real provider in lib/credentials/provider-registry.ts today happens
    // to have at least one registered credential field, so this uses a
    // synthetic name purely to exercise the fallback branch of the rule
    // itself (providerHasCredentials() === false), not a real product case.
    const graph = makeGraph([
      makeNode({ id: '1', name: 'No-Credential Step', type: 'n8n-nodes-base.somethingInternal', provider: 'no_credential_required_provider', integration: 'no_credential_required_provider', kind: 'utility' }),
    ]);
    const cards = deriveIntegrationCards(graph, [], ['no_credential_required_provider'], []);

    expect(cards).toHaveLength(1);
    expect(cards[0].connected).toBe(true);
  });

  it('#5: an unknown/unregistered credentialed provider cannot become connected accidentally (fails closed when absent from readiness)', () => {
    // A provider name the workflow graph carries but that never appears in
    // the authoritative readiness array (e.g. a bug upstream omitted it,
    // or it is a real provider that genuinely has no verified connection).
    // Only providers with zero registered credential requirements default
    // to ready; anything else must be explicitly confirmed.
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Send Email', type: 'n8n-nodes-base.gmail', provider: 'gmail', integration: 'gmail' }),
    ]);
    const cards = deriveIntegrationCards(graph, [], ['gmail'], []); // readiness omitted entirely

    expect(cards).toHaveLength(1);
    expect(cards[0].connected).toBe(false);
  });

  it('#10: a connected integration is not blocked by stale/model-generated credential-request metadata', () => {
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Send Email', type: 'n8n-nodes-base.gmail', provider: 'gmail', integration: 'gmail' }),
    ]);
    // The model called request_credential for gmail even though it is
    // actually connected -- a stale/LLM-generated claim.
    const staleRequests = [{ provider: 'gmail', reason: 'to send an email using Gmail.' }];
    const readiness: CredentialReadinessItem[] = [{ provider: 'gmail', ready: true }];

    const cards = deriveIntegrationCards(graph, staleRequests, ['gmail'], readiness);

    expect(cards).toHaveLength(1);
    expect(cards[0].connected).toBe(true); // authoritative readiness wins over the stale request
  });

  it('does not regress: a genuinely missing credentialed provider with a real request still shows disconnected, with the request reason surfaced', () => {
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Send Email', type: 'n8n-nodes-base.gmail', provider: 'gmail', integration: 'gmail' }),
    ]);
    const requests = [{ provider: 'gmail', reason: 'to send an email using Gmail.' }];
    const readiness: CredentialReadinessItem[] = [{ provider: 'gmail', ready: false }];

    const cards = deriveIntegrationCards(graph, requests, ['gmail'], readiness);

    expect(cards[0].connected).toBe(false);
    expect(cards[0].reason).toBe('to send an email using Gmail.');
  });

  describe('Phase 9.9.8A -- multiple nodes sharing one provider get one generic card, not the last node\'s specific name', () => {
    it('reproduces the exact production defect: three Airtable action nodes (Hot/Warm/Cold) collapse to a single card unconditionally overwritten by whichever node is processed last', () => {
      const graph = makeGraph([
        makeNode({ id: '1', name: 'Save to Airtable (Hot)', type: 'n8n-nodes-base.airtable', provider: 'airtable', integration: 'airtable', displayName: 'Save to Airtable (Hot)' }),
        makeNode({ id: '2', name: 'Save to Airtable (Warm)', type: 'n8n-nodes-base.airtable', provider: 'airtable', integration: 'airtable', displayName: 'Save to Airtable (Warm)' }),
        makeNode({ id: '3', name: 'Save to Airtable (Cold)', type: 'n8n-nodes-base.airtable', provider: 'airtable', integration: 'airtable', displayName: 'Save to Airtable (Cold)' }),
      ]);
      const cards = deriveIntegrationCards(graph, [], ['airtable'], [{ provider: 'airtable', ready: true }]);

      expect(cards).toHaveLength(1);
      // Before the fix this was "Save to Airtable (Cold)" -- the last node
      // processed -- making the single provider-level card look like it
      // belonged to one specific action instead of the provider as a whole.
      expect(cards[0].displayName).toBe('Airtable');
      expect(cards[0].displayName).not.toContain('Hot');
      expect(cards[0].displayName).not.toContain('Warm');
      expect(cards[0].displayName).not.toContain('Cold');
    });

    it('a genuinely single-node provider keeps that one action\'s specific, more informative display name', () => {
      const graph = makeGraph([
        makeNode({ id: '1', name: 'Save to Airtable', type: 'n8n-nodes-base.airtable', provider: 'airtable', integration: 'airtable', displayName: 'Save New Leads to Airtable' }),
      ]);
      const cards = deriveIntegrationCards(graph, [], ['airtable'], [{ provider: 'airtable', ready: true }]);

      expect(cards).toHaveLength(1);
      expect(cards[0].displayName).toBe('Save New Leads to Airtable');
    });

    it('is provider-agnostic -- the same collapse applies to any provider with multiple credentialed nodes, e.g. two Slack nodes', () => {
      const graph = makeGraph([
        makeNode({ id: '1', name: 'Notify Sales (Hot)', type: 'n8n-nodes-base.slack', provider: 'slack', integration: 'slack', displayName: 'Notify Sales (Hot)' }),
        makeNode({ id: '2', name: 'Notify Support (Cold)', type: 'n8n-nodes-base.slack', provider: 'slack', integration: 'slack', displayName: 'Notify Support (Cold)' }),
      ]);
      const cards = deriveIntegrationCards(graph, [], ['slack'], [{ provider: 'slack', ready: true }]);

      expect(cards).toHaveLength(1);
      expect(cards[0].displayName).toBe('Slack');
    });
  });
});
