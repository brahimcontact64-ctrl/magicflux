/**
 * Phase 9.9.4A — template-expression product-truth guard
 * (lib/agent/template-expression-guard.ts). Rejects generation/activation of
 * a node whose message-style parameters or Airtable field mapping use
 * `{{ ... }}` syntax outside the runtime's supported contract, before it
 * can ever reach a live run and silently render as inert, un-interpolated
 * text.
 */

import { describe, it, expect } from 'vitest';
import { validateSupportedTemplateSyntax } from '../lib/agent/template-expression-guard';

describe('validateSupportedTemplateSyntax', () => {
  it('accepts a plain literal message', () => {
    const nodes = [{ id: '1', name: 'Notify', type: 'n8n-nodes-base.slack', parameters: { text: 'Hello world' } }];
    expect(validateSupportedTemplateSyntax(nodes)).toEqual({ ok: true });
  });

  it('accepts an exact whole-value expression', () => {
    const nodes = [{ id: '1', name: 'Send', type: 'n8n-nodes-base.gmail', parameters: { subject: '={{$json["subjectLine"]}}' } }];
    expect(validateSupportedTemplateSyntax(nodes)).toEqual({ ok: true });
  });

  it('accepts an embedded reference inside a larger string', () => {
    const nodes = [{ id: '1', name: 'Send', type: 'n8n-nodes-base.gmail', parameters: { body: 'Hello {{$json["name"]}}, welcome!' } }];
    expect(validateSupportedTemplateSyntax(nodes)).toEqual({ ok: true });
  });

  it('accepts a real-shaped Airtable field mapping', () => {
    const nodes = [{
      id: '1', name: 'Save', type: 'n8n-nodes-base.airtable',
      parameters: { fields: { Name: '={{$json["name"]}}', Classification: '={{$json["classification"]}}' } },
    }];
    expect(validateSupportedTemplateSyntax(nodes)).toEqual({ ok: true });
  });

  it('rejects a function call inside {{ }}', () => {
    const nodes = [{ id: '1', name: 'Send', type: 'n8n-nodes-base.gmail', parameters: { subject: '{{$json["name"].toUpperCase()}}' } }];
    const result = validateSupportedTemplateSyntax(nodes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.node).toBe('Send');
      expect(result.reason).toMatch(/unsupported template syntax/i);
    }
  });

  it('rejects arithmetic inside {{ }}', () => {
    const nodes = [{ id: '1', name: 'Send', type: 'n8n-nodes-base.gmail', parameters: { text: 'Total: {{$json["a"] + $json["b"]}}' } }];
    expect(validateSupportedTemplateSyntax(nodes).ok).toBe(false);
  });

  it('rejects unsupported syntax inside an Airtable field mapping value', () => {
    const nodes = [{
      id: '1', name: 'Save', type: 'n8n-nodes-base.airtable',
      parameters: { fields: { Name: '{{$json["name"].trim()}}' } },
    }];
    const result = validateSupportedTemplateSyntax(nodes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/fields\.Name/);
  });

  it('ignores nodes with no message-style parameters at all', () => {
    const nodes = [{ id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: { path: 'x' } }];
    expect(validateSupportedTemplateSyntax(nodes)).toEqual({ ok: true });
  });

  it('handles malformed/non-array input safely', () => {
    expect(validateSupportedTemplateSyntax(undefined as unknown as unknown[])).toEqual({ ok: true });
    expect(validateSupportedTemplateSyntax([null, 42, 'x', {}])).toEqual({ ok: true });
  });

  it('the exact generated Phase 9.9.4 shape (embedded lead-name references) passes', () => {
    const nodes = [
      { id: '9', name: 'Slack Notification (Hot)', type: 'n8n-nodes-base.slack', parameters: { text: 'New Hot lead: {{$json["name"]}}', channel: '#leads' } },
      { id: '10', name: 'Send Email (Hot)', type: 'n8n-nodes-base.gmail', parameters: { to: 'brahim.beldjilali.dev@gmail.com', body: 'We have a new Hot lead: {{$json["name"]}}', subject: 'New Hot Lead' } },
      { id: '8', name: 'Save to Airtable (Hot)', type: 'n8n-nodes-base.airtable', parameters: { baseId: '', tableId: '', operation: 'create', fields: { Name: '={{$json["name"]}}', Email: '={{$json["email"]}}', Classification: 'Hot' } } },
    ];
    expect(validateSupportedTemplateSyntax(nodes)).toEqual({ ok: true });
  });
});
