/**
 * Phase 9.9.4A — the shared safe template resolver
 * (lib/workflow-runtime/node-handlers/json-field-reference.ts).
 *
 * The exact production regression this exists to prevent: a generated
 * Airtable "fields" mapping and Slack/Gmail message templates that use an
 * embedded {{$json["field"]}} reference inside a larger string were never
 * interpolated at all -- the runtime handlers only resolved a whole-value
 * ={{$json["field"]}} expression, so real messages/records shipped with the
 * literal, un-interpolated template text still in them.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveTemplateValue,
  resolveTemplateParamValue,
  resolveFieldMapping,
  hasUnsupportedTemplateSyntax,
} from '../lib/workflow-runtime/node-handlers/json-field-reference';

describe('resolveTemplateValue', () => {
  it('a plain literal with no {{ at all is returned unchanged', () => {
    expect(resolveTemplateValue('Hello world', {})).toEqual({ ok: true, value: 'Hello world' });
  });

  it('non-string values (numbers, booleans, objects) pass through unchanged', () => {
    expect(resolveTemplateValue(42, {})).toEqual({ ok: true, value: 42 });
    expect(resolveTemplateValue(true, {})).toEqual({ ok: true, value: true });
    const obj = { a: 1 };
    expect(resolveTemplateValue(obj, {})).toEqual({ ok: true, value: obj });
  });

  it('exact whole-value expression preserves native type (number)', () => {
    const result = resolveTemplateValue('={{$json["confidence"]}}', { confidence: 0.92 });
    expect(result).toEqual({ ok: true, value: 0.92 });
  });

  it('exact whole-value expression preserves native type (boolean)', () => {
    const result = resolveTemplateValue('={{$json["needs_review"]}}', { needs_review: false });
    expect(result).toEqual({ ok: true, value: false });
  });

  it('exact whole-value expression with dot syntax works too', () => {
    const result = resolveTemplateValue('={{$json.name}}', { name: 'Ada' });
    expect(result).toEqual({ ok: true, value: 'Ada' });
  });

  it('one embedded template variable interpolates to a string', () => {
    const result = resolveTemplateValue('New Hot lead: {{$json["name"]}}', { name: 'Brahim' });
    expect(result).toEqual({ ok: true, value: 'New Hot lead: Brahim' });
  });

  it('multiple embedded template variables all interpolate', () => {
    const result = resolveTemplateValue(
      '{{$json["name"]}} <{{$json["email"]}}> scored {{$json["confidence"]}}',
      { name: 'Brahim', email: 'b@example.com', confidence: 0.92 }
    );
    expect(result).toEqual({ ok: true, value: 'Brahim <b@example.com> scored 0.92' });
  });

  it('embedded numeric/boolean values are stringified for interpolation, never left as literal objects', () => {
    const result = resolveTemplateValue('Confidence: {{$json["confidence"]}}', { confidence: 0.5 });
    expect(result).toEqual({ ok: true, value: 'Confidence: 0.5' });
  });

  it('a missing referenced field in a whole-value expression fails deterministically', () => {
    const result = resolveTemplateValue('={{$json["missing"]}}', { name: 'Ada' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe('missing');
      expect(result.reason).toMatch(/not present/i);
    }
  });

  it('a missing referenced field embedded in a template fails deterministically (never renders literal "undefined")', () => {
    const result = resolveTemplateValue('Hello {{$json["missing"]}}', { name: 'Ada' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('missing');
  });

  it('unsupported arbitrary expression syntax is left completely inert -- never evaluated', () => {
    const result = resolveTemplateValue('{{$json["name"].toUpperCase()}}', { name: 'ada' });
    // Not the supported grammar -- the whole occurrence is untouched, not executed.
    expect(result).toEqual({ ok: true, value: '{{$json["name"].toUpperCase()}}' });
  });

  it('unsupported arithmetic/expression syntax is left inert, not evaluated', () => {
    const result = resolveTemplateValue('Total: {{$json["a"] + $json["b"]}}', { a: 1, b: 2 });
    expect(result).toEqual({ ok: true, value: 'Total: {{$json["a"] + $json["b"]}}' });
  });
});

describe('resolveTemplateParamValue (message-style parameter helper)', () => {
  it('empty raw input resolves to an empty string, not a failure', () => {
    expect(resolveTemplateParamValue('', {})).toEqual({ ok: true, value: '' });
  });

  it('subject-style interpolation', () => {
    expect(resolveTemplateParamValue('New {{$json["classification"]}} Lead', { classification: 'Hot' }))
      .toEqual({ ok: true, value: 'New Hot Lead' });
  });

  it('body-style interpolation with multiple fields', () => {
    const result = resolveTemplateParamValue(
      'We have a new {{$json["classification"]}} lead: {{$json["name"]}}',
      { classification: 'Warm', name: 'Ada' }
    );
    expect(result).toEqual({ ok: true, value: 'We have a new Warm lead: Ada' });
  });

  it('propagates a missing-field failure', () => {
    const result = resolveTemplateParamValue('Hello {{$json["missing"]}}', {});
    expect(result.ok).toBe(false);
  });
});

describe('resolveFieldMapping (Airtable-style destination-field mapping)', () => {
  it('produces exactly the configured mapping -- the Phase 9.9.4 regression fixture', () => {
    const mapping = {
      Name: '={{$json["name"]}}',
      Email: '={{$json["email"]}}',
      Classification: '={{$json["classification"]}}',
      Confidence: '={{$json["confidence"]}}',
    };
    const data = { name: 'Brahim', email: 'b@example.com', classification: 'Hot', confidence: 0.92, budget: 5000, internal_secret: 'x' };

    const result = resolveFieldMapping(mapping, data);
    expect(result).toEqual({
      ok: true,
      record: { Name: 'Brahim', Email: 'b@example.com', Classification: 'Hot', Confidence: 0.92 },
    });
  });

  it('raw upstream fields not named as a mapping VALUE never leak into the result', () => {
    const mapping = { Name: '={{$json["name"]}}' };
    const data = { name: 'Ada', budget: 9999, secret_token: 'nope', _source: 'magicflux' };
    const result = resolveFieldMapping(mapping, data);
    expect(result).toEqual({ ok: true, record: { Name: 'Ada' } });
  });

  it('numeric Confidence stays a number, never stringified', () => {
    const result = resolveFieldMapping({ Confidence: '={{$json["confidence"]}}' }, { confidence: 0.75 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.Confidence).toBe(0.75);
    if (result.ok) expect(typeof result.record.Confidence).toBe('number');
  });

  it('a literal (non-expression) mapped value is used verbatim', () => {
    const result = resolveFieldMapping({ Source: 'magicflux' }, {});
    expect(result).toEqual({ ok: true, record: { Source: 'magicflux' } });
  });

  it('an unknown/missing mapped field fails deterministically, does not silently write a partial record', () => {
    const result = resolveFieldMapping({ Name: '={{$json["name"]}}', Phone: '={{$json["phone"]}}' }, { name: 'Ada' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe('Phone');
      expect(result.reason).toMatch(/phone/i);
    }
  });

  it('an empty mapping produces an empty record', () => {
    expect(resolveFieldMapping({}, { name: 'Ada' })).toEqual({ ok: true, record: {} });
  });
});

describe('hasUnsupportedTemplateSyntax', () => {
  it('a plain literal is supported', () => {
    expect(hasUnsupportedTemplateSyntax('Hello world')).toBe(false);
  });

  it('an exact whole-value $json reference is supported', () => {
    expect(hasUnsupportedTemplateSyntax('={{$json["name"]}}')).toBe(false);
  });

  it('an embedded $json reference inside a string is supported', () => {
    expect(hasUnsupportedTemplateSyntax('Hello {{$json["name"]}}!')).toBe(false);
  });

  it('multiple embedded references are all supported', () => {
    expect(hasUnsupportedTemplateSyntax('{{$json["a"]}} and {{$json["b"]}}')).toBe(false);
  });

  it('a function call inside {{ }} is rejected as unsupported', () => {
    expect(hasUnsupportedTemplateSyntax('{{$json["name"].toUpperCase()}}')).toBe(true);
  });

  it('arithmetic inside {{ }} is rejected as unsupported', () => {
    expect(hasUnsupportedTemplateSyntax('{{$json["a"] + $json["b"]}}')).toBe(true);
  });

  it('a non-$json expression inside {{ }} is rejected as unsupported', () => {
    expect(hasUnsupportedTemplateSyntax('{{ someFunction() }}')).toBe(true);
  });

  it('non-string values are never flagged', () => {
    expect(hasUnsupportedTemplateSyntax(42)).toBe(false);
    expect(hasUnsupportedTemplateSyntax(undefined)).toBe(false);
  });
});
