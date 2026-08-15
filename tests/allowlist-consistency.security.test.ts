/**
 * Allowlist consistency tests
 *
 * Enforces that PROVIDER_NODE_ALLOWLIST (lib/integrations.ts) and
 * HANDLER_NODE_ALLOWLIST (lib/workflow-runtime/node-handlers/index.ts)
 * stay in sync at all times.
 *
 * A node type that appears in one list but not the other represents a
 * configuration gap: either a node will be reported as requiring credentials
 * it cannot actually use, or a handler will fire for a node type that was
 * never intended to receive real API credentials.
 *
 * These tests run at CI time. Adding a provider to only one list causes an
 * immediate, explicit test failure rather than a silent runtime inconsistency.
 */

import { describe, it, expect } from 'vitest';
import { PROVIDER_NODE_ALLOWLIST } from '../lib/integrations';
import { HANDLER_NODE_ALLOWLIST } from '../lib/workflow-runtime/node-handlers';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect every unique node type present in PROVIDER_NODE_ALLOWLIST. */
function allProviderNodeTypes(): Set<string> {
  const types = new Set<string>();
  for (const nodeSet of PROVIDER_NODE_ALLOWLIST.values()) {
    for (const t of nodeSet) types.add(t);
  }
  return types;
}

/** Collect every unique node type present in HANDLER_NODE_ALLOWLIST. */
function allHandlerNodeTypes(): Set<string> {
  return new Set(HANDLER_NODE_ALLOWLIST.keys());
}

// ─── A: Every provider node type has a handler ────────────────────────────────
//
// For every (provider → nodeTypes) entry in PROVIDER_NODE_ALLOWLIST,
// each nodeType must be registered in HANDLER_NODE_ALLOWLIST.
// Failure here means credential injection can target a node that has no handler.

describe('A — Every PROVIDER_NODE_ALLOWLIST type has a handler entry', () => {

  for (const [provider, nodeTypes] of PROVIDER_NODE_ALLOWLIST) {
    for (const nodeType of nodeTypes) {
      it(`provider "${provider}" / node "${nodeType}" → handler exists`, () => {
        expect(
          HANDLER_NODE_ALLOWLIST.has(nodeType),
          `"${nodeType}" is in PROVIDER_NODE_ALLOWLIST[${provider}] but missing from HANDLER_NODE_ALLOWLIST`
        ).toBe(true);
      });
    }
  }

});

// ─── B: Every handler node type has a provider allowlist entry ────────────────
//
// Reverse validation: no node type may be in HANDLER_NODE_ALLOWLIST without a
// corresponding entry in PROVIDER_NODE_ALLOWLIST.
// Failure here means a handler fires for a node that was never allowlisted for
// credential injection.

describe('B — Every HANDLER_NODE_ALLOWLIST type has a provider allowlist entry', () => {

  const providerNodeTypes = allProviderNodeTypes();

  for (const nodeType of HANDLER_NODE_ALLOWLIST.keys()) {
    it(`handler node "${nodeType}" → provider allowlist entry exists`, () => {
      expect(
        providerNodeTypes.has(nodeType),
        `"${nodeType}" is in HANDLER_NODE_ALLOWLIST but missing from PROVIDER_NODE_ALLOWLIST`
      ).toBe(true);
    });
  }

});

// ─── C: Required provider coverage ───────────────────────────────────────────
//
// Assert that the five core integration providers are present in
// PROVIDER_NODE_ALLOWLIST. Adding a provider that matters operationally without
// updating this list is a sign of an incomplete migration.

describe('C — Required providers are present in PROVIDER_NODE_ALLOWLIST', () => {

  const REQUIRED_PROVIDERS = [
    'shopify',
    'slack',
    'airtable',
    'gmail',
    'google_drive',
  ] as const;

  for (const provider of REQUIRED_PROVIDERS) {
    it(`provider "${provider}" is listed`, () => {
      expect(
        PROVIDER_NODE_ALLOWLIST.has(provider),
        `Required provider "${provider}" is missing from PROVIDER_NODE_ALLOWLIST`
      ).toBe(true);
    });
  }

  it('PROVIDER_NODE_ALLOWLIST has at least as many providers as the required set', () => {
    for (const p of REQUIRED_PROVIDERS) {
      expect(PROVIDER_NODE_ALLOWLIST.has(p)).toBe(true);
    }
  });

});

// ─── D: Unknown providers are rejected ───────────────────────────────────────
//
// Verify that a hypothetical future provider (e.g. 'hubspot') does NOT appear
// in either allowlist until it has been explicitly added to both.
// This test fails immediately if someone adds a provider to one side only.

describe('D — Unknown / hypothetical providers are absent from both lists', () => {

  const UNKNOWN_PROVIDERS = ['hubspot', 'salesforce', 'zendesk', 'stripe', 'twilio'];
  const UNKNOWN_NODE_TYPES = [
    'n8n-nodes-base.hubspot',
    'n8n-nodes-base.salesforce',
    'n8n-nodes-base.zendesk',
    'n8n-nodes-base.stripe',
    'n8n-nodes-base.twilio',
  ];

  for (const provider of UNKNOWN_PROVIDERS) {
    it(`"${provider}" is NOT in PROVIDER_NODE_ALLOWLIST`, () => {
      expect(PROVIDER_NODE_ALLOWLIST.has(provider as never)).toBe(false);
    });
  }

  for (const nodeType of UNKNOWN_NODE_TYPES) {
    it(`"${nodeType}" is NOT in HANDLER_NODE_ALLOWLIST`, () => {
      expect(HANDLER_NODE_ALLOWLIST.has(nodeType)).toBe(false);
    });
  }

});

// ─── E: List sizes are equal (no orphan entries) ─────────────────────────────
//
// The total set of unique node types across both lists must be identical.
// A size mismatch means at least one entry exists on one side only.

describe('E — Both lists cover exactly the same set of node types', () => {

  it('unique node-type count is equal in both lists', () => {
    const providerTypes = allProviderNodeTypes();
    const handlerTypes  = allHandlerNodeTypes();

    const onlyInProvider = [...providerTypes].filter(t => !handlerTypes.has(t));
    const onlyInHandler  = [...handlerTypes].filter(t => !providerTypes.has(t));

    expect(
      onlyInProvider,
      `Node types in PROVIDER_NODE_ALLOWLIST but NOT in HANDLER_NODE_ALLOWLIST: ${onlyInProvider.join(', ')}`
    ).toHaveLength(0);

    expect(
      onlyInHandler,
      `Node types in HANDLER_NODE_ALLOWLIST but NOT in PROVIDER_NODE_ALLOWLIST: ${onlyInHandler.join(', ')}`
    ).toHaveLength(0);
  });

  it('both lists are non-empty', () => {
    expect(allProviderNodeTypes().size).toBeGreaterThan(0);
    expect(allHandlerNodeTypes().size).toBeGreaterThan(0);
  });

});

// ─── F: HANDLER_NODE_ALLOWLIST is read-only ───────────────────────────────────
//
// Verify the exported map cannot be mutated at runtime.

describe('F — HANDLER_NODE_ALLOWLIST is immutable at runtime', () => {

  it('attempting to set a new entry throws or is silently ignored (frozen map)', () => {
    const sizeBefore = HANDLER_NODE_ALLOWLIST.size;
    try {
      // ReadonlyMap type prevents this at compile time; this confirms runtime behaviour
      (HANDLER_NODE_ALLOWLIST as Map<string, unknown>).set('n8n-nodes-base.evil', () => null);
    } catch {
      // Mutation throws in strict mode with Object.freeze — pass
    }
    // Whether it throws or not, the size must be unchanged
    expect(HANDLER_NODE_ALLOWLIST.size).toBe(sizeBefore);
    expect(HANDLER_NODE_ALLOWLIST.has('n8n-nodes-base.evil')).toBe(false);
  });

});
