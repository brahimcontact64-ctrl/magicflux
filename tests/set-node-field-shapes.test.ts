/**
 * Phase 9.8.3 — Set node runtime write fix.
 *
 * Root cause (found via the mandated end-to-end regression on the exact
 * Founder workflow -- verifying actual final output, not merely "correct
 * branch visited"): the current planner/generator emits
 * `parameters.fields = [{name, value}]` directly -- fields itself IS the
 * array. lib/workflow-runtime/node-handlers/set.ts's setHandler() only
 * recognized `fields.values = [...]` (v3 "Edit Fields") or
 * `values.{string,number,boolean}` (legacy). Since asRecord() explicitly
 * rejects arrays (returns {}), `asRecord(params.fields).values` was always
 * undefined for the flat shape, so applyV3Fields() received `undefined`,
 * treated it as zero assignments, and returned the input unchanged --
 * the node reported success and ran the correct branch, but never wrote
 * the intended classification field. A no-op silently masquerading as a
 * working Set node, for every AI-generated workflow using this (default)
 * shape, independent of anything about "VIP" specifically.
 */

import { describe, it, expect } from 'vitest';
import { setHandler } from '../lib/workflow-runtime/node-handlers/set';

const CTX = { mode: 'live' } as Parameters<typeof setHandler>[2];

function node(parameters: Record<string, unknown>) {
  return { id: '1', name: 'Set Field', type: 'n8n-nodes-base.set', parameters };
}

describe('setHandler — field assignment shapes (Phase 9.8.3)', () => {
  it('1: flat parameters.fields = [{name, value}] (current planner/generator output) actually writes the field', async () => {
    const result = await setHandler(node({ fields: [{ name: 'customerStatus', value: 'VIP' }] }), { order_amount: 150 }, CTX);
    expect(result.status).toBe('success');
    expect(result.outputData).toMatchObject({ order_amount: 150, customerStatus: 'VIP' });
  });

  it('2: existing fields.values[...] (v3 "Edit Fields") shape still works unchanged', async () => {
    const result = await setHandler(
      node({ mode: 'manual', fields: { values: [{ name: 'customerStatus', value: 'Standard' }] } }),
      { order_amount: 50 },
      CTX,
    );
    expect(result.outputData).toMatchObject({ order_amount: 50, customerStatus: 'Standard' });
  });

  it('3: existing legacy typed values.string/number/boolean shape still works unchanged', async () => {
    const result = await setHandler(
      node({
        values: {
          string: [{ name: 'priority', value: 'high' }],
          number: [{ name: 'score', value: '42' }],
          boolean: [{ name: 'approved', value: 'true' }],
        },
      }),
      {},
      CTX,
    );
    expect(result.outputData).toMatchObject({ priority: 'high', score: 42, approved: true });
  });

  it('4: overwrites an existing field on the input data', async () => {
    const result = await setHandler(node({ fields: [{ name: 'status', value: 'approved' }] }), { status: 'pending' }, CTX);
    expect(result.outputData).toMatchObject({ status: 'approved' });
  });

  it('5: creates a new field that did not previously exist', async () => {
    const result = await setHandler(node({ fields: [{ name: 'brandNewField', value: 'x' }] }), { existing: true }, CTX);
    expect(result.outputData).toMatchObject({ existing: true, brandNewField: 'x' });
  });

  it('6: multiple field assignments in one node, including a non-string type', async () => {
    const result = await setHandler(
      node({
        fields: [
          { name: 'status', value: 'VIP' },
          { name: 'priority', value: 'high' },
          { name: 'approved', value: true, type: 'boolean' },
          { name: 'score', value: '99', type: 'number' },
        ],
      }),
      { customer_name: 'Brahim Test' },
      CTX,
    );
    expect(result.outputData).toMatchObject({
      customer_name: 'Brahim Test',
      status: 'VIP',
      priority: 'high',
      approved: true,
      score: 99,
    });
  });

  it('generalizes beyond VIP: classify/approve/priority-style assignments all work identically', async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ name: 'status', value: 'approved' }, { status: 'approved' }],
      [{ name: 'status', value: 'rejected' }, { status: 'rejected' }],
      [{ name: 'priority', value: 'high' }, { priority: 'high' }],
      [{ name: 'priority', value: 'low' }, { priority: 'low' }],
      [{ name: 'qualification', value: 'qualified' }, { qualification: 'qualified' }],
    ];
    for (const [field, expected] of cases) {
      const result = await setHandler(node({ fields: [field] }), {}, CTX);
      expect(result.outputData).toMatchObject(expected);
    }
  });

  it('7: malformed field entries fail safely -- skipped with a log, never thrown, never applied', async () => {
    const result = await setHandler(
      node({
        fields: [
          null,
          'not-an-object',
          42,
          ['nested', 'array'],
          { value: 'no name here' }, // missing name/key
          { name: '', value: 'blank name' },
          { name: 'goodField', value: 'kept' }, // the one valid entry
        ],
      }),
      { base: true },
      CTX,
    );
    expect(result.status).toBe('success');
    expect(result.outputData).toMatchObject({ base: true, goodField: 'kept' });
    // Nothing from the malformed entries leaked into the output.
    expect(Object.keys(result.outputData as Record<string, unknown>).sort()).toEqual(['base', 'goodField'].sort());
    expect(result.logs.some((l) => /skipped/i.test(l))).toBe(true);
  });

  it('a totally malformed fields value (not an array, not {values:[...]}) fails safely to a pass-through, not a crash', async () => {
    const result = await setHandler(node({ fields: 'garbage-string' }), { untouched: 1 }, CTX);
    expect(result.status).toBe('success');
    expect(result.outputData).toMatchObject({ untouched: 1 });
  });

  it('only the invoked Set node mutates its own output -- a second, un-invoked Set node config has no bearing', async () => {
    // Simulates the exact Founder shape: two sibling Set nodes exist in the
    // graph (VIP / Standard), but only one is ever invoked per execution,
    // per the branch the IF node selected -- this handler only ever sees
    // and applies the ONE node it was called for.
    const vipResult = await setHandler(node({ fields: [{ name: 'customerStatus', value: 'VIP' }] }), { order_amount: 150 }, CTX);
    expect(vipResult.outputData).toMatchObject({ customerStatus: 'VIP' });
    expect(vipResult.outputData).not.toHaveProperty('customerStatus', 'Standard');

    const standardResult = await setHandler(node({ fields: [{ name: 'customerStatus', value: 'Standard' }] }), { order_amount: 50 }, CTX);
    expect(standardResult.outputData).toMatchObject({ customerStatus: 'Standard' });
  });
});
