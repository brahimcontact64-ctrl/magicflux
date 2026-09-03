/**
 * Phase 9.5.1A — the primary, LLM-driven canonical generation path
 * (lib/agent/executor.ts's 'generate_workflow_json' tool, reached via the
 * real /builder chat flow through runAgentLoop) had NO node-capability
 * check at all before this fix, unlike lib/planner's deterministic path.
 * findIncapableNodes() is the pure filtering logic the tool handler now
 * runs on every LLM-generated node array before accepting it -- factored
 * out specifically so it's testable without mocking the tool-execution
 * pipeline's tracing/observability/queueing infrastructure.
 */

import { describe, it, expect } from 'vitest';
import { findIncapableNodes } from '../lib/agent/capability-filter';

describe('findIncapableNodes', () => {
  it('returns empty for an all-supported node array', () => {
    const nodes = [
      { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
      { name: 'Notify', type: 'n8n-nodes-base.slack' },
      { name: 'Shape', type: 'n8n-nodes-base.set' },
    ];
    expect(findIncapableNodes(nodes)).toEqual([]);
  });

  it('flags an LLM-generated code node (regression test #1)', () => {
    const nodes = [
      { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
      { name: 'Custom Logic', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return $input.all();' } },
    ];
    const result = findIncapableNodes(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Custom Logic');
    expect(result[0].userMessage).toBe("Custom code execution isn't available yet.");
    expect(result[0].userMessage).not.toContain('n8n-nodes-base');
    expect(result[0].userMessage.toLowerCase()).not.toContain('sandbox');
  });

  it('flags an LLM-generated function node the same way (regression test #2)', () => {
    const nodes = [{ name: 'Legacy Step', type: 'n8n-nodes-base.function' }];
    const result = findIncapableNodes(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].userMessage).toBe("Custom code execution isn't available yet.");
  });

  it('flags every incapable node, not just the first', () => {
    const nodes = [
      { name: 'A', type: 'n8n-nodes-base.code' },
      { name: 'B', type: 'n8n-nodes-base.slack' },
      { name: 'C', type: 'n8n-nodes-base.hubspot' },
    ];
    const result = findIncapableNodes(nodes);
    expect(result.map((r) => r.name).sort()).toEqual(['A', 'C']);
  });

  it('handles a non-array / malformed input safely', () => {
    expect(findIncapableNodes(undefined)).toEqual([]);
    expect(findIncapableNodes(null)).toEqual([]);
    expect(findIncapableNodes('not an array')).toEqual([]);
    expect(findIncapableNodes([null, 42, 'x', {}])).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'step' })]),
    );
  });
});
