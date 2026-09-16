/**
 * Phase 9.9.9 -- Part B/C/D/G: Context-Aware Notification generator's
 * runtime primitive -- resolveNotificationTemplate() and its supporting
 * exports in lib/workflow-runtime/node-handlers/json-field-reference.ts.
 *
 * Root problem this fixes: a lead-classification (or similar business-
 * object) notification is only useful when it includes whatever real
 * context fields the workflow's input actually carries, but those fields
 * are genuinely OPTIONAL per execution (confirmed from real production
 * payloads: one lead has budget_max but not budget_min, another the
 * reverse, another neither) -- so a notification template referencing them
 * with the EXISTING strict resolver would fail the whole node closed on
 * whichever field happens to be missing from a given lead. This is
 * deliberately NOT a general conditional engine: exactly one named-field
 * presence test per `{{?field}}...{{/field}}` block, no boolean
 * composition, no nesting, no arithmetic -- and the existing strict
 * `{{$json["field"]}}` grammar and its fail-closed missing-reference
 * behavior are completely unchanged for any reference outside a block.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveNotificationTemplate,
  hasMalformedOptionalBlockSyntax,
  extractReferencedFields,
} from '../lib/workflow-runtime/node-handlers/json-field-reference';

describe('resolveNotificationTemplate -- rich email body generation', () => {
  // Authoring convention: each optional block occupies its own full line,
  // so a missing field drops that whole line (including its newline)
  // cleanly -- exactly the intended email-body shape documented in
  // resolveNotificationTemplate()'s own doc comment.
  const EMAIL_BODY = [
    'New lead received',
    '',
    'Name: {{$json["name"]}}',
    'Email: {{$json["email"]}}',
    '{{?company}}Company: {{$json["company"]}}{{/company}}',
    '{{?service}}Service: {{$json["service"]}}{{/service}}',
    '{{?budget_max}}Budget: {{$json["budget_max"]}} {{$json["budget_currency"]}}{{/budget_max}}',
    '{{?urgency}}Urgency: {{$json["urgency"]}}{{/urgency}}',
    '{{?desired_start}}Desired start: {{$json["desired_start"]}}{{/desired_start}}',
    '{{?purchase_intent}}Purchase intent: {{$json["purchase_intent"]}}{{/purchase_intent}}',
    'Classification: {{$json["classification"]}}',
    '{{?ai_confidence}}AI confidence: {{$json["ai_confidence"]}}{{/ai_confidence}}',
    '{{?project_description}}Project description:',
    '{{$json["project_description"]}}{{/project_description}}',
  ].join('\n');

  it('renders every field when the full real production payload is present', () => {
    const data = {
      name: 'brahim',
      email: 'beldjilalibrahim94@gmail.com',
      company: 'sigma',
      service: 'ecommerce',
      budget_max: 700000,
      budget_currency: 'DZD',
      urgency: 'urgent',
      desired_start: 'asap',
      purchase_intent: 'ready-to-start',
      classification: 'Hot',
      ai_confidence: 0.95,
      project_description: 'We are ready to start immediately.',
    };
    const result = resolveNotificationTemplate(EMAIL_BODY, data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('Name: brahim');
    expect(result.value).toContain('Company: sigma');
    expect(result.value).toContain('Budget: 700000 DZD');
    expect(result.value).toContain('Urgency: urgent');
    expect(result.value).toContain('Desired start: asap');
    expect(result.value).toContain('Purchase intent: ready-to-start');
    expect(result.value).toContain('Classification: Hot');
    expect(result.value).toContain('AI confidence: 0.95');
    expect(result.value).toContain('Project description:\nWe are ready to start immediately.');
  });

  it('missing optional fields are cleanly omitted -- no blank sections, no failure, no literal "undefined"', () => {
    // Matches a real production payload shape: no company, no budget, no
    // desired_start, no ai_confidence (never went through Human Review).
    const data = {
      name: 'brahim zaki',
      email: 'beldjilalibrahim94@gmail.com',
      service: 'ecommerce',
      classification: 'Cold',
    };
    const result = resolveNotificationTemplate(EMAIL_BODY, data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('undefined');
    expect(result.value).not.toContain('Company:');
    expect(result.value).not.toContain('Budget:');
    expect(result.value).not.toContain('Urgency:');
    expect(result.value).not.toContain('Desired start:');
    expect(result.value).not.toContain('Purchase intent:');
    expect(result.value).not.toContain('AI confidence:');
    expect(result.value).not.toContain('Project description:');
    // No run of 2+ blank lines left behind by a dropped block.
    expect(result.value).not.toMatch(/\n{3,}/);
    expect(result.value).toContain('Name: brahim zaki');
    expect(result.value).toContain('Service: ecommerce');
    expect(result.value).toContain('Classification: Cold');
  });

  it('a REQUIRED field (outside any optional block) missing from the data still fails the node closed -- existing behavior not weakened', () => {
    const data = { email: 'x@example.com' }; // no "name"
    const result = resolveNotificationTemplate(EMAIL_BODY, data);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/"name"/);
  });
});

describe('resolveNotificationTemplate -- concise Slack summary generation', () => {
  const SLACK_TEXT =
    '🔥 Hot lead — {{$json["name"]}}' +
    '{{?service}} | {{$json["service"]}}{{/service}}' +
    '{{?budget_max}} | Budget: {{$json["budget_max"]}} {{$json["budget_currency"]}}{{/budget_max}}' +
    '{{?desired_start}} | Start: {{$json["desired_start"]}}{{/desired_start}}';

  it('renders every segment when all optional fields are present', () => {
    const data = { name: 'brahim', service: 'ecommerce', budget_max: 700000, budget_currency: 'DZD', desired_start: 'asap' };
    const result = resolveNotificationTemplate(SLACK_TEXT, data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('🔥 Hot lead — brahim | ecommerce | Budget: 700000 DZD | Start: asap');
  });

  it('a missing optional field drops its ENTIRE segment, including its own separator -- no orphan " | "', () => {
    const data = { name: 'brahim' }; // no service/budget/desired_start
    const result = resolveNotificationTemplate(SLACK_TEXT, data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('🔥 Hot lead — brahim');
    expect(result.value).not.toContain('|');
    expect(result.value).not.toContain('undefined');
  });

  it('a single-line message is still concise (no email-style multi-line dump)', () => {
    const data = { name: 'brahim', service: 'ecommerce' };
    const result = resolveNotificationTemplate(SLACK_TEXT, data);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.split('\n')).toHaveLength(1);
  });
});

describe('resolveNotificationTemplate -- safety and backward compatibility', () => {
  it('a plain literal with no template syntax at all is returned unchanged', () => {
    const result = resolveNotificationTemplate('Automated message from MagicFlux.', {});
    expect(result).toEqual({ ok: true, value: 'Automated message from MagicFlux.' });
  });

  it('a template with ONLY strict {{$json[...]}} references (no optional blocks) behaves identically to the pre-existing strict resolver', () => {
    const result = resolveNotificationTemplate('New Hot lead: {{$json["name"]}}', { name: 'brahim' });
    expect(result).toEqual({ ok: true, value: 'New Hot lead: brahim' });
  });

  it('never dumps the raw $json object -- a bare {{$json}} reference (no field accessor) is left inert, never interpolated', () => {
    const result = resolveNotificationTemplate('Raw: {{$json}}', { name: 'brahim', secret_token: 'sk-should-never-appear' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Left completely inert -- literal text, not JSON.stringify(data).
    expect(result.value).toBe('Raw: {{$json}}');
    expect(result.value).not.toContain('secret_token');
    expect(result.value).not.toContain('sk-should-never-appear');
  });

  it('arbitrary expression syntax inside {{ }} is still left inert, never evaluated', () => {
    const result = resolveNotificationTemplate('Hi {{$json["name"].toUpperCase()}}', { name: 'brahim' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('Hi {{$json["name"].toUpperCase()}}');
  });

  it('empty raw input resolves to an empty string, never a failure', () => {
    expect(resolveNotificationTemplate('', { name: 'brahim' })).toEqual({ ok: true, value: '' });
  });
});

describe('hasMalformedOptionalBlockSyntax -- generation-time structural validation', () => {
  it('a well-formed, matched block is not malformed', () => {
    expect(hasMalformedOptionalBlockSyntax('{{?company}}Company: {{$json["company"]}}{{/company}}')).toBe(false);
  });

  it('an unpaired open block (no matching close) is malformed', () => {
    expect(hasMalformedOptionalBlockSyntax('{{?company}}Company: x')).toBe(true);
  });

  it('an unpaired close block (no matching open) is malformed', () => {
    expect(hasMalformedOptionalBlockSyntax('Company: x{{/company}}')).toBe(true);
  });

  it('a mismatched field name between open and close is malformed', () => {
    expect(hasMalformedOptionalBlockSyntax('{{?company}}Company: x{{/service}}')).toBe(true);
  });

  it('plain text with no optional-block markers at all is never malformed', () => {
    expect(hasMalformedOptionalBlockSyntax('New Hot lead: {{$json["name"]}}')).toBe(false);
  });
});

describe('extractReferencedFields -- used by the notification content guard', () => {
  it('extracts strict $json references, both bracket and dot shapes', () => {
    expect(extractReferencedFields('Hi {{$json["name"]}}, from {{$json.company}}').sort()).toEqual(['company', 'name']);
  });

  it('extracts optional-block field names', () => {
    expect(extractReferencedFields('{{?budget_max}}Budget: {{$json["budget_max"]}}{{/budget_max}}').sort()).toEqual(['budget_max']);
  });

  it('returns no duplicates for a field referenced more than once', () => {
    expect(extractReferencedFields('{{$json["name"]}} {{$json["name"]}}')).toEqual(['name']);
  });

  it('returns an empty array for a non-string or a string with no references', () => {
    expect(extractReferencedFields(42)).toEqual([]);
    expect(extractReferencedFields('plain text')).toEqual([]);
  });
});
