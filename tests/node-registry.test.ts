/**
 * Node registry tests.
 *
 * Verifies that every node definition is complete, correctly typed,
 * and that the registry API works correctly.
 */

import { describe, it, expect } from 'vitest';
import {
  getAllNodeDefs,
  getNodeDef,
  getNodeDefsByCategory,
  getCategories,
  CATEGORY_META,
  validateNodeConfig,
} from '../lib/node-registry';
import type { NodeDef } from '../lib/node-registry';

// ═══════════════════════════════════════════════════════════════════════════
// Registry completeness
// ═══════════════════════════════════════════════════════════════════════════

describe('Node registry — completeness', () => {
  it('has at least 12 node definitions', () => {
    // googleDriveNode is intentionally excluded from the palette (Phase 7.5
    // release gate) — its runtime handler is a stub, so it's hidden rather
    // than offered as a node that can never actually execute.
    expect(getAllNodeDefs().length).toBeGreaterThanOrEqual(12);
  });

  it('includes all required node types', () => {
    const types = getAllNodeDefs().map((d) => d.type);
    expect(types).toContain('n8n-nodes-base.webhook');
    expect(types).toContain('n8n-nodes-base.emailSend');
    expect(types).toContain('n8n-nodes-base.slack');
    expect(types).toContain('n8n-nodes-base.airtable');
    expect(types).toContain('n8n-nodes-base.httpRequest');
    expect(types).toContain('n8n-nodes-base.wait');
    expect(types).toContain('n8n-nodes-base.if');
    expect(types).toContain('n8n-nodes-base.openAi');
  });

  it('has no duplicate node types', () => {
    const types = getAllNodeDefs().map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NodeDef structure
// ═══════════════════════════════════════════════════════════════════════════

describe('Node registry — NodeDef structure', () => {
  function assertNodeDef(def: NodeDef) {
    expect(typeof def.type).toBe('string');
    expect(def.type.length).toBeGreaterThan(0);
    expect(typeof def.label).toBe('string');
    expect(def.label.length).toBeGreaterThan(0);
    expect(typeof def.category).toBe('string');
    expect(typeof def.description).toBe('string');
    expect(def.description.length).toBeGreaterThan(0);
    // LucideIcon is a React forwardRef component — typeof is 'function' or 'object'
    expect(['function', 'object']).toContain(typeof def.icon);
    expect(typeof def.iconColor).toBe('string');
    expect(def.iconColor.length).toBeGreaterThan(0);
    expect(Array.isArray(def.fields)).toBe(true);
  }

  it('every NodeDef has required properties', () => {
    for (const def of getAllNodeDefs()) {
      assertNodeDef(def);
    }
  });

  it('every field has key, label, and type', () => {
    for (const def of getAllNodeDefs()) {
      for (const field of def.fields) {
        expect(typeof field.key).toBe('string');
        expect(field.key.length).toBeGreaterThan(0);
        expect(typeof field.label).toBe('string');
        expect(field.label.length).toBeGreaterThan(0);
        expect(typeof field.type).toBe('string');
      }
    }
  });

  it('select fields always have options array', () => {
    for (const def of getAllNodeDefs()) {
      for (const field of def.fields) {
        if (field.type === 'select') {
          expect(Array.isArray(field.options)).toBe(true);
          expect(field.options!.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('select options have label and value', () => {
    for (const def of getAllNodeDefs()) {
      for (const field of def.fields) {
        if (field.type === 'select') {
          for (const opt of field.options!) {
            expect(typeof opt.label).toBe('string');
            expect(typeof opt.value).toBe('string');
          }
        }
      }
    }
  });

  it('number fields respect min/max if both defined', () => {
    for (const def of getAllNodeDefs()) {
      for (const field of def.fields) {
        if (field.type === 'number' && field.min !== undefined && field.max !== undefined) {
          expect(field.min).toBeLessThan(field.max);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getNodeDef lookups
// ═══════════════════════════════════════════════════════════════════════════

describe('getNodeDef', () => {
  it('returns correct def for webhook', () => {
    const def = getNodeDef('n8n-nodes-base.webhook');
    expect(def).toBeDefined();
    expect(def!.label).toBe('Webhook');
    expect(def!.isTrigger).toBe(true);
  });

  it('returns correct def for slack', () => {
    const def = getNodeDef('n8n-nodes-base.slack');
    expect(def).toBeDefined();
    expect(def!.category).toBe('messaging');
  });

  it('returns correct def for openAi', () => {
    const def = getNodeDef('n8n-nodes-base.openAi');
    expect(def).toBeDefined();
    expect(def!.category).toBe('ai');
  });

  it('returns undefined for unknown type', () => {
    expect(getNodeDef('n8n-nodes-base.doesNotExist')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getNodeDef('')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Category API
// ═══════════════════════════════════════════════════════════════════════════

describe('Category API', () => {
  it('getCategories returns unique categories', () => {
    const cats = getCategories();
    expect(new Set(cats).size).toBe(cats.length);
  });

  it('all expected categories are present', () => {
    const cats = getCategories();
    expect(cats).toContain('trigger');
    expect(cats).toContain('messaging');
    expect(cats).toContain('storage');
    expect(cats).toContain('control');
    expect(cats).toContain('ai');
    expect(cats).toContain('http');
  });

  it('CATEGORY_META covers all returned categories', () => {
    for (const cat of getCategories()) {
      expect(CATEGORY_META[cat]).toBeDefined();
      expect(typeof CATEGORY_META[cat].label).toBe('string');
      expect(typeof CATEGORY_META[cat].order).toBe('number');
    }
  });

  it('getNodeDefsByCategory returns only matching defs', () => {
    const triggers = getNodeDefsByCategory('trigger');
    expect(triggers.length).toBeGreaterThan(0);
    for (const def of triggers) {
      expect(def.category).toBe('trigger');
    }
  });

  it('trigger nodes have isTrigger = true', () => {
    const triggers = getNodeDefsByCategory('trigger');
    for (const def of triggers) {
      expect(def.isTrigger).toBe(true);
    }
  });

  it('non-trigger categories do not have isTrigger', () => {
    const actions = getNodeDefsByCategory('messaging');
    for (const def of actions) {
      expect(def.isTrigger).toBeFalsy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// validateNodeConfig
// ═══════════════════════════════════════════════════════════════════════════

describe('validateNodeConfig', () => {
  const slackDef = getNodeDef('n8n-nodes-base.slack')!;

  it('returns no errors when all required fields are filled', () => {
    const errors = validateNodeConfig(
      { channel: '#general', message: 'Hello world' },
      slackDef.fields,
    );
    expect(errors).toHaveLength(0);
  });

  it('returns error for missing required field', () => {
    const errors = validateNodeConfig({ message: 'Hello' }, slackDef.fields);
    expect(errors.some((e) => e.key === 'channel')).toBe(true);
  });

  it('returns error for empty string required field', () => {
    const errors = validateNodeConfig({ channel: '', message: 'Hi' }, slackDef.fields);
    expect(errors.some((e) => e.key === 'channel')).toBe(true);
  });

  it('does not return error for optional field when missing', () => {
    const errors = validateNodeConfig(
      { channel: '#general', message: 'Hello' },
      slackDef.fields,
    );
    // username and iconEmoji are optional — should not be in errors
    expect(errors.some((e) => e.key === 'username')).toBe(false);
  });

  it('email node: reports missing recipient', () => {
    const emailDef = getNodeDef('n8n-nodes-base.emailSend')!;
    const errors = validateNodeConfig({ subject: 'Hi', body: 'Body' }, emailDef.fields);
    expect(errors.some((e) => e.key === 'to')).toBe(true);
  });

  it('http node: reports missing url', () => {
    const httpDef = getNodeDef('n8n-nodes-base.httpRequest')!;
    const errors = validateNodeConfig({ method: 'GET' }, httpDef.fields);
    expect(errors.some((e) => e.key === 'url')).toBe(true);
  });

  it('condition node: reports missing field expression', () => {
    const condDef = getNodeDef('n8n-nodes-base.if')!;
    const errors = validateNodeConfig({ operation: 'equals' }, condDef.fields);
    expect(errors.some((e) => e.key === 'field')).toBe(true);
  });

  it('openai node: reports missing prompt', () => {
    const aiDef = getNodeDef('n8n-nodes-base.openAi')!;
    const errors = validateNodeConfig({ model: 'gpt-4o' }, aiDef.fields);
    expect(errors.some((e) => e.key === 'prompt')).toBe(true);
  });

  it('returns empty errors array for node with no fields', () => {
    const errors = validateNodeConfig({}, []);
    expect(errors).toHaveLength(0);
  });
});
