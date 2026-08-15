/**
 * Execution compiler tests.
 *
 * Verifies topological sort, cycle detection, orphan detection,
 * and plan validity for various workflow shapes.
 */

import { describe, it, expect } from 'vitest';
import { compileWorkflow } from '../lib/execution/compiler';
import type { CompilerInput } from '../lib/execution/compiler';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function node(name: string, type = 'n8n-nodes-base.webhook') {
  return { name, type };
}

function trigger(name: string) {
  return { name, type: 'n8n-nodes-base.webhook' };
}

function action(name: string) {
  return { name, type: 'n8n-nodes-base.emailSend' };
}

function conn(src: string, ...targets: string[]) {
  return { [src]: { main: [targets.map((t) => ({ node: t }))] } };
}

function condConn(src: string, trueTarget: string, falseTarget: string) {
  return {
    [src]: {
      main: [
        [{ node: trueTarget }],
        [{ node: falseTarget }],
      ],
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Empty / minimal
// ═══════════════════════════════════════════════════════════════════════════

describe('compileWorkflow — empty / minimal', () => {
  it('returns invalid plan for empty nodes', () => {
    const plan = compileWorkflow({ nodes: [], connections: {} });
    expect(plan.valid).toBe(false);
    expect(plan.errors.length).toBeGreaterThan(0);
  });

  it('single trigger node produces valid plan with 1 step', () => {
    const plan = compileWorkflow({
      nodes: [trigger('Webhook')],
      connections: {},
    });
    expect(plan.valid).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].node.name).toBe('Webhook');
  });

  it('single action node produces invalid plan (no trigger)', () => {
    const plan = compileWorkflow({
      nodes: [action('Email')],
      connections: {},
    });
    expect(plan.valid).toBe(false);
    expect(plan.errors.some((e) => e.toLowerCase().includes('trigger'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Topological order
// ═══════════════════════════════════════════════════════════════════════════

describe('compileWorkflow — topological order', () => {
  it('linear A→B→C: A before B before C', () => {
    const input: CompilerInput = {
      nodes: [trigger('A'), action('B'), action('C')],
      connections: { ...conn('A', 'B'), ...conn('B', 'C') },
    };
    const plan = compileWorkflow(input);
    const names = plan.steps.map((s) => s.node.name);
    expect(names.indexOf('A')).toBeLessThan(names.indexOf('B'));
    expect(names.indexOf('B')).toBeLessThan(names.indexOf('C'));
  });

  it('step indices are 1-based and sequential', () => {
    const input: CompilerInput = {
      nodes: [trigger('A'), action('B')],
      connections: conn('A', 'B'),
    };
    const plan = compileWorkflow(input);
    expect(plan.steps[0].stepIndex).toBe(1);
    expect(plan.steps[1].stepIndex).toBe(2);
  });

  it('all nodes appear in steps', () => {
    const input: CompilerInput = {
      nodes: [trigger('T'), action('S'), action('A')],
      connections: { ...conn('T', 'S'), ...conn('T', 'A') },
    };
    const plan = compileWorkflow(input);
    expect(plan.steps).toHaveLength(3);
  });

  it('fan-out: both branches after trigger', () => {
    const input: CompilerInput = {
      nodes: [trigger('T'), action('Slack'), action('Email')],
      connections: { T: { main: [[{ node: 'Slack' }, { node: 'Email' }]] } },
    };
    const plan = compileWorkflow(input);
    const tIdx  = plan.steps.findIndex((s) => s.node.name === 'T');
    const sIdx  = plan.steps.findIndex((s) => s.node.name === 'Slack');
    const eIdx  = plan.steps.findIndex((s) => s.node.name === 'Email');
    expect(tIdx).toBeLessThan(sIdx);
    expect(tIdx).toBeLessThan(eIdx);
  });

  it('condition node: both branches appear after IF', () => {
    const input: CompilerInput = {
      nodes: [trigger('Webhook'), node('IF', 'n8n-nodes-base.if'), action('True'), action('False')],
      connections: {
        ...conn('Webhook', 'IF'),
        ...condConn('IF', 'True', 'False'),
      },
    };
    const plan = compileWorkflow(input);
    const ifIdx   = plan.steps.findIndex((s) => s.node.name === 'IF');
    const trueIdx = plan.steps.findIndex((s) => s.node.name === 'True');
    const falseIdx = plan.steps.findIndex((s) => s.node.name === 'False');
    expect(ifIdx).toBeLessThan(trueIdx);
    expect(ifIdx).toBeLessThan(falseIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// dependsOn
// ═══════════════════════════════════════════════════════════════════════════

describe('compileWorkflow — dependsOn', () => {
  it('trigger node has no dependencies', () => {
    const plan = compileWorkflow({
      nodes: [trigger('Webhook'), action('Email')],
      connections: conn('Webhook', 'Email'),
    });
    const triggerStep = plan.steps.find((s) => s.node.name === 'Webhook')!;
    expect(triggerStep.dependsOn).toHaveLength(0);
  });

  it('action node depends on its source', () => {
    const plan = compileWorkflow({
      nodes: [trigger('Webhook'), action('Email')],
      connections: conn('Webhook', 'Email'),
    });
    const emailStep = plan.steps.find((s) => s.node.name === 'Email')!;
    expect(emailStep.dependsOn).toContain('Webhook');
  });

  it('middle node depends on its predecessor', () => {
    const plan = compileWorkflow({
      nodes: [trigger('A'), action('B'), action('C')],
      connections: { ...conn('A', 'B'), ...conn('B', 'C') },
    });
    const bStep = plan.steps.find((s) => s.node.name === 'B')!;
    const cStep = plan.steps.find((s) => s.node.name === 'C')!;
    expect(bStep.dependsOn).toContain('A');
    expect(cStep.dependsOn).toContain('B');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cycle detection
// ═══════════════════════════════════════════════════════════════════════════

describe('compileWorkflow — cycle detection', () => {
  it('simple A→B→A cycle produces invalid plan', () => {
    const input: CompilerInput = {
      nodes: [trigger('A'), action('B')],
      connections: { ...conn('A', 'B'), ...conn('B', 'A') },
    };
    const plan = compileWorkflow(input);
    expect(plan.valid).toBe(false);
    expect(plan.errors.some((e) => e.toLowerCase().includes('cycle'))).toBe(true);
  });

  it('cycle nodes are listed in cycleNodeNames', () => {
    const input: CompilerInput = {
      nodes: [trigger('Start'), action('B'), action('C')],
      connections: { ...conn('Start', 'B'), ...conn('B', 'C'), ...conn('C', 'B') },
    };
    const plan = compileWorkflow(input);
    expect(plan.cycleNodeNames.length).toBeGreaterThan(0);
  });

  it('non-cycle nodes still appear in steps', () => {
    const input: CompilerInput = {
      nodes: [trigger('Start'), action('B'), action('C')],
      connections: { ...conn('Start', 'B'), ...conn('B', 'C'), ...conn('C', 'B') },
    };
    const plan = compileWorkflow(input);
    const names = plan.steps.map((s) => s.node.name);
    expect(names).toContain('Start');
  });

  it('self-loop is a cycle', () => {
    const input: CompilerInput = {
      nodes: [trigger('A')],
      connections: conn('A', 'A'),
    };
    const plan = compileWorkflow(input);
    expect(plan.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Orphan detection
// ═══════════════════════════════════════════════════════════════════════════

describe('compileWorkflow — orphan detection', () => {
  it('isolated action node is flagged as orphan', () => {
    const input: CompilerInput = {
      nodes: [trigger('Webhook'), action('Orphan')],
      connections: conn('Webhook', 'Webhook'), // no edges to/from Orphan
    };
    const plan = compileWorkflow(input);
    expect(plan.orphanNodeNames).toContain('Orphan');
  });

  it('isolated action produces a warning', () => {
    const input: CompilerInput = {
      nodes: [trigger('T'), action('O')],
      connections: {},
    };
    const plan = compileWorkflow(input);
    expect(plan.warnings.some((w) => w.toLowerCase().includes('isolated') || w.toLowerCase().includes('orphan'))).toBe(true);
  });

  it('isolated trigger is NOT flagged as orphan', () => {
    const input: CompilerInput = {
      nodes: [trigger('T')],
      connections: {},
    };
    const plan = compileWorkflow(input);
    expect(plan.orphanNodeNames).not.toContain('T');
  });

  it('connected node is not flagged as orphan', () => {
    const input: CompilerInput = {
      nodes: [trigger('T'), action('A')],
      connections: conn('T', 'A'),
    };
    const plan = compileWorkflow(input);
    expect(plan.orphanNodeNames).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Unknown connection sources / targets
// ═══════════════════════════════════════════════════════════════════════════

describe('compileWorkflow — unknown connection nodes', () => {
  it('unknown connection source produces a warning', () => {
    const input: CompilerInput = {
      nodes: [trigger('A')],
      connections: { Ghost: { main: [[{ node: 'A' }]] } },
    };
    const plan = compileWorkflow(input);
    expect(plan.warnings.some((w) => w.includes('Ghost'))).toBe(true);
  });

  it('plan does not crash on unknown target', () => {
    const input: CompilerInput = {
      nodes: [trigger('A')],
      connections: conn('A', 'Ghost'),
    };
    expect(() => compileWorkflow(input)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Disconnected branch detection
// ═══════════════════════════════════════════════════════════════════════════

describe('compileWorkflow — disconnected branch detection', () => {
  it('node not reachable from trigger produces warning', () => {
    const input: CompilerInput = {
      nodes: [trigger('T'), action('A'), action('B')],
      connections: {
        ...conn('T', 'A'),
        ...conn('B', 'A'), // B has an out-edge but is not reached from T
      },
    };
    const plan = compileWorkflow(input);
    expect(plan.warnings.some((w) => w.includes('B'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Valid plans
// ═══════════════════════════════════════════════════════════════════════════

describe('compileWorkflow — valid plans', () => {
  it('simple linear workflow is valid', () => {
    const plan = compileWorkflow({
      nodes: [trigger('Webhook'), action('Slack'), action('Airtable')],
      connections: { ...conn('Webhook', 'Slack'), ...conn('Slack', 'Airtable') },
    });
    expect(plan.valid).toBe(true);
    expect(plan.errors).toHaveLength(0);
  });

  it('condition workflow is valid', () => {
    const plan = compileWorkflow({
      nodes: [
        trigger('Webhook'),
        node('IF', 'n8n-nodes-base.if'),
        action('Email'),
        action('Slack'),
      ],
      connections: {
        ...conn('Webhook', 'IF'),
        ...condConn('IF', 'Email', 'Slack'),
      },
    });
    expect(plan.valid).toBe(true);
  });
});
