/**
 * Phase 9.8.7 — source invariants pinning the prompt/schema strengthening
 * so it cannot silently regress. Complements concrete-value-guard.test.ts
 * (the deterministic backstop) with the softer, first-line-of-defense
 * instructions given directly to the model.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('generate_workflow_json schema strengthening (lib/agent/tools.ts)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/agent/tools.ts'), 'utf8');

  it('nodes_description requires verbatim concrete literals and forbids placeholders when real values exist', () => {
    const match = source.match(/nodes_description:\s*\{[\s\S]*?\},/);
    expect(match, 'nodes_description property not found').toBeTruthy();
    const body = match![0].toLowerCase();
    expect(body).toMatch(/verbatim/);
    expect(body).toMatch(/recipient@example\.com/);
    expect(body).toMatch(/forbidden/);
  });

  it('destination requires verbatim recipient/address preservation', () => {
    const match = source.match(/destination:\s*\{[\s\S]*?\},/);
    expect(match, 'destination property not found').toBeTruthy();
    expect(match![0].toLowerCase()).toMatch(/verbatim/);
  });
});

describe('generateWorkflowJson() prompt strengthening (lib/agent/executor.ts)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/agent/executor.ts'), 'utf8');

  it('the prompt includes an unconditional "concrete values are authoritative" rule, generic across action types', () => {
    expect(source).toMatch(/concrete values are authoritative/i);
    expect(source.toLowerCase()).toMatch(/never invent, generalize, or replace/);
  });

  it('the raw user intent is threaded into the prompt when present', () => {
    expect(source).toMatch(/raw_user_intent/);
    expect(source).toMatch(/Raw User Request/);
  });

  it('ExecutionContext carries rawUserIntent, and the generate_workflow_json case forwards it into generateWorkflowJson()', () => {
    expect(source).toMatch(/rawUserIntent\?:\s*string/);
    expect(source).toMatch(/raw_user_intent:\s*ctx\.rawUserIntent/);
  });

  it('a deterministic post-generation guard runs before persistence', () => {
    const guardIdx = source.indexOf('checkConcreteValuesPreserved(ctx.rawUserIntent');
    const persistIdx = source.indexOf('ensurePersistedWorkflowDraft({');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(persistIdx);
  });
});

describe('lib/agent/loop.ts threads the current user message through to executeTool', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib/agent/loop.ts'), 'utf8');

  it('passes rawUserIntent: latestUserMessage into the executeTool context', () => {
    const match = source.match(/executeTool\(toolName, args, \{[\s\S]*?\}\);/);
    expect(match, 'executeTool call not found').toBeTruthy();
    expect(match![0]).toMatch(/rawUserIntent:\s*latestUserMessage/);
  });
});
