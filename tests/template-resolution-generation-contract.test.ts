/**
 * Phase 9.9.4A — source invariants pinning the template-expression contract
 * in the generation prompt and its deterministic guard, so the contract
 * cannot silently regress.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('generateWorkflowJson() prompt documents the template expression contract (lib/agent/executor.ts)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/agent/executor.ts'), 'utf8');

  it('mentions the TEMPLATE EXPRESSION CONTRACT section', () => {
    expect(source).toMatch(/TEMPLATE EXPRESSION CONTRACT/);
  });

  it('documents all three supported shapes: literal, whole-value, embedded', () => {
    expect(source).toMatch(/plain literal string/);
    expect(source).toMatch(/exact whole-value expression/);
    expect(source).toMatch(/EMBEDDED/);
  });

  it('explicitly forbids function calls/arithmetic/pipes inside {{ }}', () => {
    expect(source.toLowerCase()).toMatch(/function calls.*arithmetic|arithmetic.*function calls/s);
  });

  it('the deterministic template-syntax guard runs before persistence', () => {
    const guardIdx = source.indexOf('validateSupportedTemplateSyntax(');
    const persistIdx = source.indexOf('ensurePersistedWorkflowDraft({');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(persistIdx);
  });
});

describe('activateWorkflow() rejects unsupported template syntax before activation (lib/workflow/lifecycle.ts)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/workflow/lifecycle.ts'), 'utf8');

  it('imports and calls the template-syntax guard', () => {
    expect(source).toMatch(/validateSupportedTemplateSyntax/);
  });

  it('folds the guard result into the same errors array as the other activation checks', () => {
    // Phase 9.9.17A -- this collection now lives in the shared
    // runActivationGuards() helper (reused by both activateWorkflow() and
    // publishNewVersion()) rather than inline in activateWorkflow() itself.
    const idx = source.indexOf('async function runActivationGuards');
    expect(idx).toBeGreaterThan(-1);
    const section = source.slice(idx, idx + 1600);
    expect(section).toMatch(/templateSyntaxErrors/);
    expect(section).toMatch(/return \[/);
  });
});

describe('the runtime handlers all funnel through the one shared resolver (lib/workflow-runtime/node-handlers/json-field-reference.ts)', () => {
  it('airtable.ts uses resolveFieldMapping', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/workflow-runtime/node-handlers/airtable.ts'), 'utf8');
    expect(source).toMatch(/resolveFieldMapping/);
    expect(source).not.toMatch(/\.\.\.data,\s*_source:\s*['"]magicflux['"]/);
  });

  // Phase 9.9.9 -- email.ts/slack.ts now call resolveNotificationTemplate()
  // (json-field-reference.ts) for subject/body/text -- a strict superset of
  // resolveTemplateParamValue() that ALSO supports the notification-only
  // {{?field}}...{{/field}} optional-block primitive; a raw string with no
  // such block resolves identically to the plain strict resolver (verified
  // in tests/notification-optional-template.test.ts).
  it('email.ts uses resolveNotificationTemplate for subject/body', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/workflow-runtime/node-handlers/email.ts'), 'utf8');
    expect(source).toMatch(/resolveNotificationTemplate/);
  });

  it('slack.ts uses resolveNotificationTemplate for text', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/workflow-runtime/node-handlers/slack.ts'), 'utf8');
    expect(source).toMatch(/resolveNotificationTemplate/);
  });
});
