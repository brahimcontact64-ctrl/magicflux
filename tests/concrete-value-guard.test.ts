/**
 * Phase 9.8.7 — deterministic, fail-closed guard against generation
 * silently substituting placeholder text for a concrete literal the user
 * actually provided. Root cause was upstream (generateWorkflowJson() never
 * received the raw user text at all), fixed separately by threading
 * ctx.rawUserIntent through; this is the backstop that still runs even if
 * the model ignores the strengthened prompt/schema instructions.
 */

import { describe, it, expect } from 'vitest';
import { checkConcreteValuesPreserved } from '../lib/agent/concrete-value-guard';

const REAL_PROMPT =
  'Send an email now to nssmpro@gmail.com with the subject "MagicFlux Real Workflow Test" ' +
  'and the message "Hello Nassim! This email was sent automatically by MagicFlux 🚀"';

function emailNode(parameters: Record<string, unknown>) {
  return [
    { id: '1', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
    { id: '2', name: 'Send Email', type: 'n8n-nodes-base.gmail', parameters },
  ];
}

describe('checkConcreteValuesPreserved (Phase 9.8.7)', () => {
  it('#1: exact recipient from the user prompt is accepted', () => {
    const nodes = emailNode({ to: 'nssmpro@gmail.com', subject: 'MagicFlux Real Workflow Test', message: 'Hello Nassim! This email was sent automatically by MagicFlux 🚀' });
    expect(checkConcreteValuesPreserved(REAL_PROMPT, nodes)).toEqual({ ok: true });
  });

  it('#4: a placeholder recipient is rejected when the user supplied a real email', () => {
    const nodes = emailNode({ to: 'recipient@example.com', subject: 'MagicFlux Real Workflow Test', message: 'Hello Nassim!' });
    const result = checkConcreteValuesPreserved(REAL_PROMPT, nodes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/nssmpro@gmail\.com/);
  });

  it('a different (non-placeholder but still wrong) recipient is also rejected', () => {
    const nodes = emailNode({ to: 'someoneelse@gmail.com', subject: 'MagicFlux Real Workflow Test', message: 'Hello Nassim!' });
    expect(checkConcreteValuesPreserved(REAL_PROMPT, nodes).ok).toBe(false);
  });

  it('an empty recipient is rejected when the user supplied a real email', () => {
    const nodes = emailNode({ to: '', subject: 'MagicFlux Real Workflow Test', message: 'Hello Nassim!' });
    expect(checkConcreteValuesPreserved(REAL_PROMPT, nodes).ok).toBe(false);
  });

  it('#5: a placeholder subject is rejected when the user supplied an explicit subject', () => {
    const nodes = emailNode({ to: 'nssmpro@gmail.com', subject: 'Your Subject Here', message: 'Hello Nassim!' });
    const result = checkConcreteValuesPreserved(REAL_PROMPT, nodes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/subject/i);
  });

  it('#5: a placeholder body is rejected when the user supplied an explicit message', () => {
    const nodes = emailNode({ to: 'nssmpro@gmail.com', subject: 'MagicFlux Real Workflow Test', message: 'Your message content here.' });
    const result = checkConcreteValuesPreserved(REAL_PROMPT, nodes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/message|body/i);
  });

  it('a missing (empty) subject is rejected when the user supplied an explicit subject', () => {
    const nodes = emailNode({ to: 'nssmpro@gmail.com', subject: '', message: 'Hello Nassim!' });
    expect(checkConcreteValuesPreserved(REAL_PROMPT, nodes).ok).toBe(false);
  });

  it('does not reject a genuine, non-placeholder subject/body that simply is not byte-identical to the prompt wording', () => {
    // Free-text extraction of the user's exact wording is not attempted for
    // subject/body -- only "is it non-empty and non-placeholder" is
    // enforced, so a faithfully-preserved-but-not-character-identical
    // rendering (e.g. the model kept the emoji as text) still passes.
    const nodes = emailNode({ to: 'nssmpro@gmail.com', subject: 'MagicFlux Real Workflow Test', message: 'Hello Nassim! This email was sent automatically by MagicFlux (rocket emoji)' });
    expect(checkConcreteValuesPreserved(REAL_PROMPT, nodes).ok).toBe(true);
  });

  it('no email node in the graph -> always ok (nothing to check)', () => {
    const nodes = [{ id: '1', name: 'Post to Slack', type: 'n8n-nodes-base.slack', parameters: { channel: '#general', message: 'hi' } }];
    expect(checkConcreteValuesPreserved(REAL_PROMPT, nodes)).toEqual({ ok: true });
  });

  it('user request with no extractable concrete literal at all -> ok (nothing to enforce)', () => {
    const nodes = emailNode({ to: 'recipient@example.com', subject: 'Your Subject Here', message: 'Your message content here.' });
    expect(checkConcreteValuesPreserved('Set up an email automation for me.', nodes)).toEqual({ ok: true });
  });

  it('malformed/non-array nodes input never throws', () => {
    expect(checkConcreteValuesPreserved(REAL_PROMPT, null as unknown as unknown[])).toEqual({ ok: true });
    expect(checkConcreteValuesPreserved(REAL_PROMPT, undefined as unknown as unknown[])).toEqual({ ok: true });
    expect(checkConcreteValuesPreserved('', [])).toEqual({ ok: true });
  });

  it('a genuine example.com address in the user request itself (not a placeholder) is not treated as a real recipient', () => {
    // If the user's OWN request happens to reference an example.com address
    // (rare, but possible in a test/demo request), it is excluded from
    // consideration as "the real recipient" the same way a generated
    // placeholder would be -- conservative, avoids a false-positive
    // rejection driven by the extraction heuristic itself.
    const nodes = emailNode({ to: 'demo@example.com', subject: 'Demo', message: 'hi' });
    expect(checkConcreteValuesPreserved('Send a demo email to demo@example.com with subject "Demo" and message "hi"', nodes)).toEqual({ ok: true });
  });
});
