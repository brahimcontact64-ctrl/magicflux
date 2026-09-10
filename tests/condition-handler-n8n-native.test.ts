/**
 * Phase 9.8.2 — second production blocker, found via the mandated
 * end-to-end regression (generate -> persist -> activate -> invoke,
 * verifying actual node outputs, not merely HTTP 2xx). The exact Founder
 * workflow (Webhook -> If order_amount > 100 -> Set VIP / Set Standard)
 * activated successfully, but BOTH "Set VIP" and "Set Standard" executed
 * for every payload, regardless of order_amount.
 *
 * Root cause: lib/agent/executor.ts's generateWorkflowJson() explicitly
 * instructs the model to "use real n8n node types", so the AI correctly
 * generates n8n's actual native IF-node parameter shape --
 * `conditions: { number: [{ value1, operation, value2 }] }` with value1
 * often an expression like `={{$json["orderAmount"]}}`. This handler's
 * PRE-EXISTING logic only understood a different, undocumented custom
 * shape (`conditions: [{ field, operator, value }]`, a flat array). Since
 * the real n8n shape is an object, `Array.isArray(conditions)` was always
 * false, so the handler always took its "no conditions defined" fallback
 * -- returning `_conditionResult: true` and never setting
 * `_conditionBranch`. The traversal engine (runtime/workflow-engine.ts)
 * correctly follows only outputPorts[_conditionBranch] when that field is
 * a number, but falls back to following EVERY output port when it isn't
 * set -- which is exactly what happened for every AI-generated IF node,
 * silently defeating branching for every conditional workflow ever
 * generated this way, independent of anything about "VIP" specifically.
 */

import { describe, it, expect } from 'vitest';
import { conditionHandler } from '../lib/workflow-runtime/node-handlers/condition';

const CTX = {} as Parameters<typeof conditionHandler>[2];

function makeIfNode(conditions: unknown, combinator?: string) {
  return {
    id: '2',
    name: 'Check Order Amount',
    type: 'n8n-nodes-base.if',
    parameters: { conditions, ...(combinator ? { combinator } : {}) },
  };
}

describe('conditionHandler — n8n-native IF condition shape (Phase 9.8.2)', () => {
  it('the exact Founder condition: order_amount > 100 branches true for 150, false for 50', async () => {
    const node = makeIfNode({
      number: [{ value1: '={{$json["order_amount"]}}', operation: 'larger', value2: 100 }],
    });

    const trueResult = await conditionHandler(node, { order_amount: 150 }, CTX);
    expect(trueResult.outputData).toMatchObject({ _conditionResult: true, _conditionBranch: 0 });

    const falseResult = await conditionHandler(node, { order_amount: 50 }, CTX);
    expect(falseResult.outputData).toMatchObject({ _conditionResult: false, _conditionBranch: 1 });
  });

  it('resolves $json["field"] and $json.field bracket/dot expression forms identically', async () => {
    const bracketNode = makeIfNode({ number: [{ value1: '={{$json["amount"]}}', operation: 'larger', value2: 10 }] });
    const dotNode = makeIfNode({ number: [{ value1: '={{$json.amount}}', operation: 'larger', value2: 10 }] });

    expect((await conditionHandler(bracketNode, { amount: 20 }, CTX)).outputData).toMatchObject({ _conditionBranch: 0 });
    expect((await conditionHandler(dotNode, { amount: 20 }, CTX)).outputData).toMatchObject({ _conditionBranch: 0 });
  });

  it('supports string operations (equal, contains) on the native shape', async () => {
    const equalNode = makeIfNode({ string: [{ value1: '={{$json["status"]}}', operation: 'equal', value2: 'approved' }] });
    expect((await conditionHandler(equalNode, { status: 'approved' }, CTX)).outputData).toMatchObject({ _conditionBranch: 0 });
    expect((await conditionHandler(equalNode, { status: 'rejected' }, CTX)).outputData).toMatchObject({ _conditionBranch: 1 });

    const containsNode = makeIfNode({ string: [{ value1: '={{$json["tier"]}}', operation: 'contains', value2: 'gold' }] });
    expect((await conditionHandler(containsNode, { tier: 'gold-plus' }, CTX)).outputData).toMatchObject({ _conditionBranch: 0 });
  });

  it('AND-combines multiple rules across buckets by default; OR when explicitly requested', async () => {
    const andNode = makeIfNode({
      number: [{ value1: '={{$json["score"]}}', operation: 'larger', value2: 50 }],
      string: [{ value1: '={{$json["region"]}}', operation: 'equal', value2: 'US' }],
    });
    // Only one of the two conditions true -> AND fails.
    expect((await conditionHandler(andNode, { score: 90, region: 'EU' }, CTX)).outputData).toMatchObject({ _conditionBranch: 1 });
    expect((await conditionHandler(andNode, { score: 90, region: 'US' }, CTX)).outputData).toMatchObject({ _conditionBranch: 0 });

    const orNode = makeIfNode(
      {
        number: [{ value1: '={{$json["score"]}}', operation: 'larger', value2: 50 }],
        string: [{ value1: '={{$json["region"]}}', operation: 'equal', value2: 'US' }],
      },
      'or',
    );
    // Only one true, but combinator is OR -> passes.
    expect((await conditionHandler(orNode, { score: 90, region: 'EU' }, CTX)).outputData).toMatchObject({ _conditionBranch: 0 });
  });

  it('an unresolvable (non-$json, non-literal) value1 simply fails to match rather than throwing or silently guessing', async () => {
    const node = makeIfNode({ number: [{ value1: '={{$node["Other"].json.amount}}', operation: 'larger', value2: 10 }] });
    const result = await conditionHandler(node, { amount: 999 }, CTX);
    // Left side stays the literal unresolved string, Number(that) is NaN,
    // NaN > 10 is false -- fails closed to the "false" branch rather than
    // guessing the intended value.
    expect(result.outputData).toMatchObject({ _conditionBranch: 1 });
  });

  it('resolves the field by name even when the payload uses a different casing convention than the generated condition (e.g. orderAmount vs order_amount) -- the AI is not deterministic about casing, so branching must not depend on a casing coincidence', async () => {
    const camelNode = makeIfNode({ number: [{ value1: '={{$json["orderAmount"]}}', operation: 'larger', value2: 100 }] });
    expect((await conditionHandler(camelNode, { order_amount: 150 }, CTX)).outputData).toMatchObject({ _conditionBranch: 0 });
    expect((await conditionHandler(camelNode, { order_amount: 50 }, CTX)).outputData).toMatchObject({ _conditionBranch: 1 });

    const snakeNode = makeIfNode({ number: [{ value1: '={{$json["order_amount"]}}', operation: 'larger', value2: 100 }] });
    expect((await conditionHandler(snakeNode, { orderAmount: 150 }, CTX)).outputData).toMatchObject({ _conditionBranch: 0 });

    // Genuinely different field names must still NOT collide.
    const distinctFieldsNode = makeIfNode({ number: [{ value1: '={{$json["orderAmount"]}}', operation: 'larger', value2: 100 }] });
    const result = await conditionHandler(distinctFieldsNode, { totalAmount: 150 }, CTX);
    expect(result.outputData).toMatchObject({ _conditionBranch: 1 });
  });

  it('backward compatibility: the legacy custom {field, operator, value} flat-array shape still works unchanged', async () => {
    const node = makeIfNode([{ field: 'status', operator: 'equals', value: 'approved' }]);
    expect((await conditionHandler(node, { status: 'approved' }, CTX)).outputData).toMatchObject({ _conditionResult: true, _conditionBranch: 0 });
    expect((await conditionHandler(node, { status: 'pending' }, CTX)).outputData).toMatchObject({ _conditionResult: false, _conditionBranch: 1 });
  });

  it('no conditions at all (empty parameters) still passes through on the true branch without setting _conditionBranch, exactly as before (routing test compatibility)', async () => {
    const node = { id: '1', name: 'Fake', type: 'n8n-nodes-base.if', parameters: {} };
    const result = await conditionHandler(node, { anything: true }, CTX);
    expect(result.status).toBe('success');
    expect(result.outputData).toMatchObject({ _conditionResult: true });
    expect((result.outputData as Record<string, unknown>)._conditionBranch).toBeUndefined();
  });
});
