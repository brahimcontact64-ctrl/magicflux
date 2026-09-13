/**
 * Phase 9.8.6B — "Configure Send Email -> Connect now" persisted after the
 * Phase 9.8.5/9.8.6 fixes because lib/conversation/user-safe-payload.ts's
 * sanitizeAutomationBrain() rebuilds automationBrain via an explicit field
 * allowlist and never included credentialIntelligence at all -- confirmed
 * live in production: a real SSE response's automationBrain only ever
 * carried [inferredIntent, capabilities, activatedSkillPacks,
 * matchedPatterns, providerResolutions, composition]. deriveIntegrationCards()
 * therefore always received an empty readiness array and failed every
 * credentialed provider closed, regardless of real connection state.
 *
 * Fix: sanitizeAutomationBrain() now explicitly preserves
 * credentialIntelligence -- readiness metadata only (provider, displayName,
 * missing[]/optional[] field descriptors, ready, confidence) -- with the
 * same defensive conventions (type checks, bounded lengths) already used
 * for every other field in this file.
 */

import { describe, it, expect } from 'vitest';
import { createUserSafeAssistantPayload } from '../lib/conversation/user-safe-payload';

function baseAutomationBrain(overrides: Record<string, unknown> = {}) {
  return {
    inferredIntent: 'Send an email now',
    capabilities: [{ key: 'email_send', reason: 'Email sending requested.', confidence: 64 }],
    activatedSkillPacks: [],
    matchedPatterns: [{ name: 'AI Workflow Assistant', category: 'general', score: 50, estimatedCost: 0.02, estimatedComplexity: 'simple', risk: 'low' }],
    providerResolutions: [{ provider: 'gmail', capabilities: ['email_send'], confidence: 99 }],
    composition: {
      executionFrequency: 'Event-driven',
      expectedInputs: [],
      expectedOutputs: [],
      complexity: 'simple',
      estimatedCostUsd: 0.02,
      latencyEstimateMs: 1200,
      risks: [],
    },
    ...overrides,
  };
}

function finalPayload(automationBrain: unknown) {
  return {
    payload: {
      assistant: { content: 'Ready to send.' },
      agentEvents: [],
      credentialRequests: [],
      approvalRequests: [],
      workflowGraph: null,
      automationBrain,
      workflow: null,
      persistedWorkflowId: null,
    },
  };
}

describe('sanitizeAutomationBrain / createUserSafeAssistantPayload — credentialIntelligence (Phase 9.8.6B)', () => {
  it('#1 & #5: credentialIntelligence survives sanitization end-to-end, with gmail ready:true when a connected email integration satisfies it', () => {
    const raw = baseAutomationBrain({
      credentialIntelligence: [
        {
          provider: 'gmail',
          displayName: 'Gmail',
          missing: [],
          optional: [{ key: 'oauth_google_gmail', label: 'Google OAuth', secret: true, source: 'oauth', description: 'Google account OAuth2 authorization', required: true }],
          ready: true,
          confidence: 100,
        },
      ],
    });

    const result = createUserSafeAssistantPayload('final', finalPayload(raw));
    const payload = (result as { payload: { automationBrain: { credentialIntelligence: Array<{ provider: string; ready: boolean }> } } }).payload;

    expect(payload.automationBrain).not.toBeNull();
    expect(payload.automationBrain.credentialIntelligence).toBeDefined();
    expect(payload.automationBrain.credentialIntelligence).toHaveLength(1);
    expect(payload.automationBrain.credentialIntelligence[0].provider).toBe('gmail');
    expect(payload.automationBrain.credentialIntelligence[0].ready).toBe(true);
  });

  it('#2: a disconnected provider correctly survives as ready:false, with its missing fields preserved', () => {
    const raw = baseAutomationBrain({
      credentialIntelligence: [
        {
          provider: 'gmail',
          displayName: 'Gmail',
          missing: [{ key: 'oauth_google_gmail', label: 'Google OAuth', secret: true, source: 'oauth', description: 'Google account OAuth2 authorization', required: true }],
          optional: [],
          ready: false,
          confidence: 100,
        },
      ],
    });

    const result = createUserSafeAssistantPayload('final', finalPayload(raw));
    const payload = (result as { payload: { automationBrain: { credentialIntelligence: Array<{ provider: string; ready: boolean; missing: Array<{ key: string; label: string }> }> } } }).payload;

    expect(payload.automationBrain.credentialIntelligence[0].ready).toBe(false);
    expect(payload.automationBrain.credentialIntelligence[0].missing).toHaveLength(1);
    expect(payload.automationBrain.credentialIntelligence[0].missing[0].key).toBe('oauth_google_gmail');
  });

  it('#3: malformed entries are dropped safely, never thrown, never producing garbage', () => {
    const raw = baseAutomationBrain({
      credentialIntelligence: [
        null,
        'not-an-object',
        42,
        { displayName: 'No provider here' }, // missing required `provider`
        { provider: '', ready: true }, // empty provider
        { provider: 'slack', ready: 'yes' /* wrong type */, missing: 'not-an-array', optional: null, confidence: 'high' },
        { provider: 'gmail', ready: true, missing: [], optional: [], confidence: 999 }, // confidence out of range, must clamp
      ],
    });

    const result = createUserSafeAssistantPayload('final', finalPayload(raw));
    const payload = (result as { payload: { automationBrain: { credentialIntelligence: Array<{ provider: string; ready: boolean; confidence: number; missing: unknown[] }> } } }).payload;

    // Only the two structurally-valid entries with a non-empty provider survive.
    expect(payload.automationBrain.credentialIntelligence).toHaveLength(2);
    const slack = payload.automationBrain.credentialIntelligence.find((c) => c.provider === 'slack')!;
    expect(slack.ready).toBe(false); // 'yes' !== true -> coerced to false, never thrown
    expect(Array.isArray(slack.missing)).toBe(true);
    expect(slack.missing).toEqual([]);
    const gmail = payload.automationBrain.credentialIntelligence.find((c) => c.provider === 'gmail')!;
    expect(gmail.confidence).toBe(100); // clamped into [0, 100]
  });

  it('#4: no credential value, token, or secret can leak through the sanitized shape', () => {
    const raw = baseAutomationBrain({
      credentialIntelligence: [
        {
          provider: 'gmail',
          displayName: 'Gmail',
          ready: true,
          confidence: 100,
          missing: [],
          optional: [],
          // Attempted injection: real secret-shaped fields directly on the
          // credentialIntelligence entry itself (not a field descriptor).
          access_token: 'ya29.super-secret-real-token',
          bot_token: 'xoxb-should-never-appear',
          smtp_pass: 'hunter2',
          credentials: { anything: 'raw-db-row-shaped-object' },
        },
      ],
    });

    const result = createUserSafeAssistantPayload('final', finalPayload(raw));
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('super-secret-real-token');
    expect(serialized).not.toContain('xoxb-should-never-appear');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('raw-db-row-shaped-object');

    const payload = (result as { payload: { automationBrain: { credentialIntelligence: Array<Record<string, unknown>> } } }).payload;
    const entry = payload.automationBrain.credentialIntelligence[0];
    expect(Object.keys(entry).sort()).toEqual(['confidence', 'displayName', 'missing', 'optional', 'provider', 'ready'].sort());
  });

  it('a field descriptor\'s own secret VALUE (as opposed to its schema metadata) is never present -- only key/label/secret-flag/source/description/required survive', () => {
    const raw = baseAutomationBrain({
      credentialIntelligence: [
        {
          provider: 'slack',
          displayName: 'Slack',
          ready: false,
          confidence: 100,
          missing: [
            {
              key: 'bot_token',
              label: 'Bot Token',
              secret: true,
              source: 'token',
              description: 'Slack Bot User OAuth Token',
              required: true,
              // Attempted injection: an actual secret value on the field descriptor.
              value: 'xoxb-1234-real-secret-value',
            },
          ],
          optional: [],
        },
      ],
    });

    const result = createUserSafeAssistantPayload('final', finalPayload(raw));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('xoxb-1234-real-secret-value');

    const payload = (result as { payload: { automationBrain: { credentialIntelligence: Array<{ missing: Array<Record<string, unknown>> }> } } }).payload;
    expect(Object.keys(payload.automationBrain.credentialIntelligence[0].missing[0]).sort()).toEqual(
      ['description', 'key', 'label', 'required', 'secret', 'source'].sort(),
    );
  });

  it('a turn carrying only credential-readiness data (no new capabilities/patterns/providers) is not discarded', () => {
    const raw = baseAutomationBrain({
      capabilities: [],
      matchedPatterns: [],
      providerResolutions: [],
      credentialIntelligence: [{ provider: 'gmail', displayName: 'Gmail', ready: true, confidence: 100, missing: [], optional: [] }],
    });

    const result = createUserSafeAssistantPayload('final', finalPayload(raw));
    const payload = (result as { payload: { automationBrain: unknown } }).payload;

    expect(payload.automationBrain).not.toBeNull();
  });

  it('a turn with genuinely nothing meaningful (including no credentialIntelligence) still returns null, unchanged from prior behavior', () => {
    const raw = baseAutomationBrain({ capabilities: [], matchedPatterns: [], providerResolutions: [], credentialIntelligence: [] });

    const result = createUserSafeAssistantPayload('final', finalPayload(raw));
    const payload = (result as { payload: { automationBrain: unknown } }).payload;

    expect(payload.automationBrain).toBeNull();
  });

  it('missing credentialIntelligence entirely on the raw object defaults to an empty array, not undefined or a crash', () => {
    const raw = baseAutomationBrain();
    delete (raw as Record<string, unknown>).credentialIntelligence;

    const result = createUserSafeAssistantPayload('final', finalPayload(raw));
    const payload = (result as { payload: { automationBrain: { credentialIntelligence: unknown[] } } }).payload;

    expect(payload.automationBrain.credentialIntelligence).toEqual([]);
  });
});
