/**
 * Phase 9.8.4 — false "Invalid: core" provider-parity failure.
 *
 * Root cause: lib/agent/executor.ts's generate_workflow_json provider-parity
 * check computes TWO near-identical provider extractions from the same
 * WorkflowGraphSummary -- extractAllProvidersFromWorkflowGraph() (correct,
 * already excludes internal category labels like 'core'/'scheduler' via a
 * BLOCKED set) and an inline `rawGraphProviders` duplicate that only dropped
 * empty strings. A node with no external system (Manual Trigger, If, Set,
 * Wait) has provider: null and falls back to its WorkflowGraphNode.integration
 * bucket ('core' for triggers/conditions/utility) purely for cost-estimation
 * -- never meant to be validated as a provider name. Any workflow combining
 * such an internal node with a genuinely requested external platform (e.g.
 * Manual Trigger -> Send Email via Gmail) failed generation with a false
 * "Missing: none | Extra: none | Forbidden: none | Invalid: core".
 *
 * Fix: export isInternalProviderLabel() as the single source of truth (an
 * exported predicate, not a mutable Set) and use it in BOTH extraction
 * paths -- extractAllProvidersFromWorkflowGraph() already did; the inline
 * rawGraphProviders computation in executor.ts now does too -- so the two
 * paths cannot drift apart again.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  isInternalProviderLabel,
  extractAllProvidersFromWorkflowGraph,
  isCanonicalProvider,
  hasForbiddenProviderPattern,
  normalizeProvider,
} from '../lib/agent/provider-allowlist';
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
    requiresCredentials: false,
    credentialSchema: [],
    displayName: overrides.displayName ?? overrides.name ?? 'Node',
    kind: overrides.kind ?? 'utility',
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

/**
 * Mirrors the EXACT expression lib/agent/executor.ts now uses for
 * rawGraphProviders, using the same exported primitives it imports --
 * not a reimplementation of unverified logic, but the identical pattern,
 * pinned here alongside a source-scan assertion (below) that the real file
 * actually contains it.
 */
function computeRawGraphProviders(graph: WorkflowGraphSummary): string[] {
  return Array.from(
    new Set(
      (graph.nodes ?? [])
        .map((node) => normalizeProvider(String(node.provider ?? node.integration ?? '')))
        .filter((provider) => Boolean(provider) && !isInternalProviderLabel(provider))
    )
  );
}

describe('1: Manual Trigger + Email does not produce a false "Invalid: core"', () => {
  it('a graph with a Manual Trigger (provider null, integration "core") and a real Gmail node yields only "gmail", never "core"', () => {
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', kind: 'trigger', provider: null, integration: 'core' }),
      makeNode({ id: '2', name: 'Send Email', type: 'n8n-nodes-base.gmail', kind: 'action', provider: 'gmail', integration: 'gmail' }),
    ]);

    const rawGraphProviders = computeRawGraphProviders(graph);
    expect(rawGraphProviders).toEqual(['gmail']);
    expect(rawGraphProviders).not.toContain('core');

    const invalidProviders = rawGraphProviders.filter(
      (p) => !hasForbiddenProviderPattern(p) && !isCanonicalProvider(p)
    );
    expect(invalidProviders).toEqual([]);
  });

  it('source invariant: the real rawGraphProviders computation in executor.ts calls isInternalProviderLabel, not just .filter(Boolean)', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/agent/executor.ts'), 'utf8');
    const fnMatch = source.match(/const rawGraphProviders = Array\.from\(([\s\S]*?)\);/);
    expect(fnMatch, 'rawGraphProviders computation not found in executor.ts').toBeTruthy();
    expect(fnMatch![1]).toMatch(/isInternalProviderLabel/);
    expect(source).toMatch(/import\s*\{[^}]*isInternalProviderLabel[^}]*\}\s*from\s*['"]@\/lib\/agent\/provider-allowlist['"]/);
  });
});

describe('2: IF/Set/internal utility labels never appear as providers', () => {
  it('every BLOCKED internal category label is recognized by isInternalProviderLabel', () => {
    for (const label of ['core', 'integration', 'scheduler', 'webhook', 'utility', 'httprequest', 'http_request', 'ai_provider']) {
      expect(isInternalProviderLabel(label)).toBe(true);
    }
  });

  it('an If node and a Set node (both provider null, integration "core") contribute nothing to the provider list', () => {
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Check', type: 'n8n-nodes-base.if', kind: 'condition', provider: null, integration: 'core' }),
      makeNode({ id: '2', name: 'Assign', type: 'n8n-nodes-base.set', kind: 'utility', provider: null, integration: 'core' }),
    ]);
    expect(computeRawGraphProviders(graph)).toEqual([]);
    expect(extractAllProvidersFromWorkflowGraph(graph)).toEqual([]);
  });
});

describe('3: genuine invalid providers are still rejected', () => {
  it('a real (non-internal) but non-canonical provider name still surfaces as invalid', () => {
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Mystery Step', type: 'n8n-nodes-base.somecustomcrm', kind: 'action', provider: 'somecustomcrm', integration: 'somecustomcrm' }),
    ]);
    const rawGraphProviders = computeRawGraphProviders(graph);
    expect(rawGraphProviders).toEqual(['somecustomcrm']);
    const invalidProviders = rawGraphProviders.filter(
      (p) => !hasForbiddenProviderPattern(p) && !isCanonicalProvider(p)
    );
    expect(invalidProviders).toEqual(['somecustomcrm']);
  });
});

describe('4: forbidden providers are still rejected', () => {
  it('forbidden-pattern provider names are excluded from graphProviders and flagged as forbidden, not silently allowed', () => {
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Ping', type: 'n8n-nodes-base.notification_action', kind: 'action', provider: 'notification_action', integration: 'notification_action' }),
    ]);
    expect(extractAllProvidersFromWorkflowGraph(graph)).toEqual([]); // forbidden -> excluded from the "real providers" set
    const rawGraphProviders = computeRawGraphProviders(graph);
    expect(rawGraphProviders).toEqual(['notification_action']);
    expect(rawGraphProviders.filter((p) => hasForbiddenProviderPattern(p))).toEqual(['notification_action']);
    // isInternalProviderLabel must never accidentally suppress a forbidden pattern.
    expect(isInternalProviderLabel('notification_action')).toBe(false);
  });
});

describe('5: requested provider parity still catches missing/extra real providers', () => {
  it('flags a requested provider absent from the graph, and a graph provider not requested', () => {
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Trigger', type: 'n8n-nodes-base.webhook', kind: 'trigger', provider: null, integration: 'core' }),
      makeNode({ id: '2', name: 'Post to Slack', type: 'n8n-nodes-base.slack', kind: 'action', provider: 'slack', integration: 'slack' }),
    ]);
    const requestedProviders = ['gmail'];
    const graphProviders = extractAllProvidersFromWorkflowGraph(graph);
    const graphSet = new Set(graphProviders);
    const requestedSet = new Set(requestedProviders);

    const missingProviders = requestedProviders.filter((p) => !graphSet.has(p));
    const extraProviders = graphProviders.filter((p) => !requestedSet.has(p));

    expect(missingProviders).toEqual(['gmail']);
    expect(extraProviders).toEqual(['slack']);
  });

  it('parity passes cleanly when the graph exactly matches what was requested', () => {
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', kind: 'trigger', provider: null, integration: 'core' }),
      makeNode({ id: '2', name: 'Send Email', type: 'n8n-nodes-base.gmail', kind: 'action', provider: 'gmail', integration: 'gmail' }),
    ]);
    const requestedProviders = ['gmail'];
    const graphProviders = extractAllProvidersFromWorkflowGraph(graph);
    const graphSet = new Set(graphProviders);
    const requestedSet = new Set(requestedProviders);

    expect(requestedProviders.filter((p) => !graphSet.has(p))).toEqual([]);
    expect(graphProviders.filter((p) => !requestedSet.has(p))).toEqual([]);
  });
});

describe('6: the prior webhook -> if -> set conditional-classification scenario still passes', () => {
  it('a graph with only internal nodes (webhook, if, two sets) and no requested providers yields zero graph/raw providers', () => {
    const graph = makeGraph([
      makeNode({ id: '1', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', kind: 'trigger', provider: null, integration: 'core' }),
      makeNode({ id: '2', name: 'Check Order Amount', type: 'n8n-nodes-base.if', kind: 'condition', provider: null, integration: 'core' }),
      makeNode({ id: '3', name: 'Set VIP Status', type: 'n8n-nodes-base.set', kind: 'utility', provider: null, integration: 'core' }),
      makeNode({ id: '4', name: 'Set Standard Status', type: 'n8n-nodes-base.set', kind: 'utility', provider: null, integration: 'core' }),
    ]);

    // Matches executor.ts's own gating: with no requested providers, the
    // whole parity check block never runs -- confirmed here structurally by
    // asserting the graph legitimately has zero real providers either way,
    // so even if the check ran, it would find nothing to complain about.
    expect(extractAllProvidersFromWorkflowGraph(graph)).toEqual([]);
    expect(computeRawGraphProviders(graph)).toEqual([]);
  });
});
