/**
 * Phase 9.9.9 -- Part G: notification product-truth guard
 * (lib/agent/notification-content-guard.ts).
 *
 * A generated Email/Slack notification must be built ONLY from real
 * business fields -- never internal execution bookkeeping
 * (_conditionBranch, _conditionResult) and never a credential/secret/
 * token-shaped field name. This is a deterministic, generic denylist
 * check (never lead- or Sigma-Plus-specific) run at generation time
 * (lib/agent/executor.ts) and activation time (lib/workflow/lifecycle.ts),
 * matching the existing template-expression-guard.ts pattern.
 */

import { describe, it, expect } from 'vitest';
import { validateNotificationFieldAllowlist } from '../lib/agent/notification-content-guard';

function gmailNode(message: string, subject = 'Subject') {
  return { id: '1', name: 'Send Gmail Email', type: 'n8n-nodes-base.gmail', parameters: { to: 'x@example.com', subject, message } };
}

function slackNode(text: string) {
  return { id: '2', name: 'Slack Notification', type: 'n8n-nodes-base.slack', parameters: { channel: '#leads', text } };
}

describe('validateNotificationFieldAllowlist', () => {
  it('passes a notification built only from real business fields', () => {
    const result = validateNotificationFieldAllowlist([
      gmailNode('New lead: {{$json["name"]}}, budget {{$json["budget_max"]}}'),
      slackNode('Hot lead: {{$json["name"]}}'),
    ]);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a Gmail node referencing _conditionBranch', () => {
    const result = validateNotificationFieldAllowlist([gmailNode('Branch was {{$json["_conditionBranch"]}}')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/_conditionBranch/);
  });

  it('rejects a Slack node referencing _conditionResult', () => {
    const result = validateNotificationFieldAllowlist([slackNode('Result: {{$json["_conditionResult"]}}')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/_conditionResult/);
  });

  it.each([
    'access_token',
    'refresh_token',
    'client_secret',
    'webhook_secret',
    'api_key',
    'credential_id',
    'password',
  ])('rejects a notification referencing the credential/secret-shaped field "%s"', (field) => {
    const result = validateNotificationFieldAllowlist([gmailNode(`Value: {{$json["${field}"]}}`)]);
    expect(result.ok).toBe(false);
  });

  it('rejects the denylisted field even inside an optional block', () => {
    const result = validateNotificationFieldAllowlist([gmailNode('{{?access_token}}Token: {{$json["access_token"]}}{{/access_token}}')]);
    expect(result.ok).toBe(false);
  });

  it('a non-notification node type (Airtable) referencing an unusual field name is not checked by this guard', () => {
    const result = validateNotificationFieldAllowlist([
      { id: '3', name: 'Airtable', type: 'n8n-nodes-base.airtable', parameters: { fields: { Token: '={{$json["access_token"]}}' } } },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it('handles nodes with no message-style parameters at all', () => {
    expect(validateNotificationFieldAllowlist([{ id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} }])).toEqual({ ok: true });
  });

  it('tolerates malformed input gracefully', () => {
    expect(validateNotificationFieldAllowlist(undefined as unknown as unknown[])).toEqual({ ok: true });
    expect(validateNotificationFieldAllowlist([null, 42, 'x', {}])).toEqual({ ok: true });
  });

  it('is case-insensitive for the credential-shaped name pattern', () => {
    const result = validateNotificationFieldAllowlist([gmailNode('Value: {{$json["ACCESS_TOKEN"]}}')]);
    expect(result.ok).toBe(false);
  });
});
