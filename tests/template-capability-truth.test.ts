/**
 * Phase 9.5.1A regression test #6 — NodePalette/templates must not offer
 * code/function nodes as executable V1 nodes. Several of lib/templates.ts's
 * predefined industry templates embed a code_transform (n8n-nodes-base.code)
 * step for bespoke field parsing that no deterministic native node can
 * replicate. Rather than rewriting that business logic (real risk of
 * getting it subtly wrong) or deleting the templates (against "prefer
 * Coming Soon over deleting historical/future product concepts"), each
 * template is tagged with `unavailableReason`, computed directly from the
 * same authoritative checkNodeCapability() every other layer uses.
 */

import { describe, it, expect } from 'vitest';
import { AUTOMATION_TEMPLATES } from '../lib/templates';
import { checkNodeCapability } from '../lib/workflow-runtime/node-capabilities';

describe('AUTOMATION_TEMPLATES capability truth', () => {
  it('every template flagged unavailableReason genuinely contains an incapable node', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      const nodes = (template.workflow as { nodes?: Array<{ type?: string; parameters?: unknown }> }).nodes ?? [];
      const anyIncapable = nodes.some((n) => !checkNodeCapability({ type: String(n.type ?? ''), parameters: n.parameters }).capable);
      expect(anyIncapable, template.id).toBe(Boolean(template.unavailableReason));
    }
  });

  it('at least one template uses a code node and is correctly flagged', () => {
    const codeTemplates = AUTOMATION_TEMPLATES.filter((t) => {
      const nodes = (t.workflow as { nodes?: Array<{ type?: string }> }).nodes ?? [];
      return nodes.some((n) => String(n.type ?? '').toLowerCase().includes('code'));
    });
    expect(codeTemplates.length).toBeGreaterThan(0);
    for (const t of codeTemplates) {
      expect(t.unavailableReason, t.id).toBe("Custom code execution isn't available yet.");
    }
  });

  it('unavailableReason, when present, is user-safe (no raw node type, no internal jargon)', () => {
    for (const template of AUTOMATION_TEMPLATES) {
      if (!template.unavailableReason) continue;
      expect(template.unavailableReason).not.toContain('n8n-nodes-base');
      expect(template.unavailableReason.toLowerCase()).not.toContain('handler');
      expect(template.unavailableReason.toLowerCase()).not.toContain('sandbox');
    }
  });
});
