/**
 * Phase 9.8.8 — Generic Pattern Fix.
 *
 * Root cause (production investigation, Founder Schedule -> Gmail attempt):
 * lib/automation/engine.ts's inferMarketWorkflowName() fallback (used only
 * when zero real automation_patterns DB rows scored above 0 and no domain
 * pack matched) grouped the generic, domain-neutral 'scheduling' capability
 * in the same OR-condition as genuine real-estate signals (lead_capture,
 * qualification, whatsapp_followups) -- so ANY scheduled request with no
 * other domain signal (e.g. "send an email at 14:45") was mislabeled
 * "Property Lead Engine". This suite pins the fix: scheduling alone must
 * never imply the property/lead vertical, while genuine property/lead
 * signals (routed through DOMAIN_PACKS' real_estate entry) still correctly
 * produce "Property Lead Engine".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeEmptyPatternDb() {
  return {
    from(table: string) {
      if (table === 'automation_patterns') {
        return { select: () => ({ limit: async () => ({ data: [], error: null }) }) };
      }
      if (table === 'skill_packs') {
        return { select: () => ({ limit: async () => ({ data: [], error: null }) }) };
      }
      throw new Error(`unexpected table in this fake: ${table}`);
    },
  };
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => makeEmptyPatternDb()),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Phase 9.8.8 — scheduling alone must never imply Property Lead Engine', () => {
  it('schedule + gmail ("send an email today at 14:45...") does NOT become Property Lead Engine', async () => {
    const { analyzeAutomationPrompt } = await import('../lib/automation');
    const prompt =
      'Send an email to nssmpro@gmail.com every day at 09:00 with the subject "MagicFlux Scheduled Test" ' +
      'and the message "This email was automatically sent by MagicFlux at the scheduled time".';

    const brain = await analyzeAutomationPrompt(prompt);
    const patternNames = brain.matchedPatterns.map((p) => p.name);

    expect(patternNames).not.toContain('Property Lead Engine');
    // Truthful generic label instead of a hallucinated vertical.
    expect(patternNames.some((n) => n === 'Scheduled Automation')).toBe(true);
  });

  it('a purely scheduled, domainless automation (no email/gmail either) still avoids Property Lead Engine', async () => {
    const { analyzeAutomationPrompt } = await import('../lib/automation');
    const brain = await analyzeAutomationPrompt('Run this workflow every 5 minutes.');
    const patternNames = brain.matchedPatterns.map((p) => p.name);
    expect(patternNames).not.toContain('Property Lead Engine');
  });

  it('genuine property/lead signals (buyer, seller, property lead) still correctly become Property Lead Engine', async () => {
    const { analyzeAutomationPrompt } = await import('../lib/automation');
    // Deliberately avoids any scheduling-cadence word (every/daily/schedule/etc.) --
    // those set executionMode to 'scheduled', which narrows the provider allowlist
    // to just ['scheduler'] and would incidentally reject the real_estate domain
    // pack's crm/calendar/whatsapp tools, unrelated to the fix under test here.
    const prompt =
      'Capture property leads from buyers and sellers and qualify them automatically, then notify our sales agents.';

    const brain = await analyzeAutomationPrompt(prompt);
    const patternNames = brain.matchedPatterns.map((p) => p.name);

    expect(patternNames).toContain('Property Lead Engine');
  });
});
