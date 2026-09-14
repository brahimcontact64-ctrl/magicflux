/**
 * Phase 9.9.4D — source invariants pinning the deterministic Airtable
 * field-preservation contract, so it cannot silently regress back to
 * prompt-example-anchored field selection.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('generate_workflow_json tool schema declares record_identity_fields (lib/agent/tools.ts)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/agent/tools.ts'), 'utf8');

  it('declares the record_identity_fields parameter', () => {
    expect(source).toMatch(/record_identity_fields/);
  });

  it('documents it as a separate, deterministic-enforcement mechanism, not an illustrative example', () => {
    const idx = source.indexOf('record_identity_fields:');
    const section = source.slice(idx, idx + 900);
    expect(section).toMatch(/deterministic/i);
    expect(section).toMatch(/enforced/i);
  });
});

describe('generateWorkflowJson() prompt documents the deterministic Airtable completeness requirement (lib/agent/executor.ts)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/agent/executor.ts'), 'utf8');

  it('references record_identity_fields in the AIRTABLE CONFIGURATION CONTRACT', () => {
    const idx = source.indexOf('AIRTABLE CONFIGURATION CONTRACT');
    expect(idx).toBeGreaterThan(-1);
    const section = source.slice(idx, idx + 2500);
    expect(section).toMatch(/record_identity_fields/);
    expect(section).toMatch(/DETERMINISTIC COMPLETENESS REQUIREMENT/);
  });

  it('no longer anchors the fields example to a fixed illustrative list (Name/Email/Classification)', () => {
    const idx = source.indexOf('AIRTABLE CONFIGURATION CONTRACT');
    const section = source.slice(idx, idx + 2500);
    expect(section).not.toMatch(/e\.g\. "Name", "Email", "Classification"/);
  });

  it('the deterministic Airtable persistence guard runs before persistence', () => {
    const guardIdx = source.indexOf('validateAirtablePersistenceCompleteness(');
    const persistIdx = source.indexOf('ensurePersistedWorkflowDraft({');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(persistIdx);
  });

  it('the recordIdentityFields argument is extracted from the tool call and threaded into generation', () => {
    expect(source).toMatch(/const recordIdentityFields = Array\.isArray\(args\.record_identity_fields\)/);
    expect(source).toMatch(/record_identity_fields:\s*recordIdentityFields/);
  });
});

describe('the field-reference check is shared, not duplicated (lib/workflow-runtime/node-handlers/json-field-reference.ts)', () => {
  it('human-review-routing-guard.ts and airtable-persistence-guard.ts both import referencesJsonField from the shared module', () => {
    const humanReviewGuard = fs.readFileSync(path.join(process.cwd(), 'lib/agent/human-review-routing-guard.ts'), 'utf8');
    const airtableGuard = fs.readFileSync(path.join(process.cwd(), 'lib/agent/airtable-persistence-guard.ts'), 'utf8');
    expect(humanReviewGuard).toMatch(/import\s*\{[^}]*referencesJsonField[^}]*\}\s*from\s*['"]@\/lib\/workflow-runtime\/node-handlers\/json-field-reference['"]/);
    expect(airtableGuard).toMatch(/import\s*\{[^}]*referencesJsonField[^}]*\}\s*from\s*['"]@\/lib\/workflow-runtime\/node-handlers\/json-field-reference['"]/);
  });
});
