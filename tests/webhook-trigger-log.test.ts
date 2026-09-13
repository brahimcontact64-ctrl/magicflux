/**
 * Phase 9.8.7 — Manual Trigger observability cleanup. webhookHandler is a
 * generic passthrough shared by every trigger type (manual, webhook,
 * schedule all route here via the generic 'trigger'/'webhook' substring
 * match in node-handlers/index.ts's pickHandler()), but its live-mode log
 * line used to unconditionally say "using incoming webhook payload"
 * regardless of the actual trigger type -- confusing (and, on a Manual
 * Trigger, flatly wrong) in the execution timeline. No runtime/data-flow
 * behavior change: outputData is identical either way.
 */

import { describe, it, expect } from 'vitest';
import { webhookHandler } from '../lib/workflow-runtime/node-handlers/webhook';

const CTX = { mode: 'live' as const, integrations: [], sampleData: { fallback: true }, previews: { emails: [], slackMessages: [], airtableRecords: [] } };

describe('webhookHandler live-mode trigger log text (Phase 9.8.7)', () => {
  it('#8: Manual Trigger no longer says "using incoming webhook payload"', async () => {
    const node = { id: '1', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} };
    const result = await webhookHandler(node, { some: 'data' }, CTX);

    expect(result.logs.join(' ')).not.toMatch(/webhook/i);
    expect(result.logs).toContain('Trigger: manual run started.');
  });

  it('Schedule Trigger logs "schedule fired", not webhook wording', async () => {
    const node = { id: '1', name: 'Schedule Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {} };
    const result = await webhookHandler(node, { firedAt: '2026-01-01' }, CTX);

    expect(result.logs.join(' ')).not.toMatch(/webhook/i);
    expect(result.logs).toContain('Trigger: schedule fired.');
  });

  it('#9: a genuine Webhook Trigger keeps its existing webhook-specific wording, unchanged', async () => {
    const node = { id: '1', name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', parameters: {} };
    const result = await webhookHandler(node, { body: 'real webhook payload' }, CTX);

    expect(result.logs).toContain('Trigger: using incoming webhook payload.');
  });

  it('data flow (outputData) is identical regardless of trigger type -- this is purely a log-text fix', async () => {
    const manualResult = await webhookHandler({ id: '1', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} }, { x: 1 }, CTX);
    const webhookResult = await webhookHandler({ id: '2', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} }, { x: 1 }, CTX);

    expect(manualResult.outputData).toEqual(webhookResult.outputData);
    expect(manualResult.status).toBe('success');
    expect(webhookResult.status).toBe('success');
  });

  it('test mode is unaffected by this change (still the pre-existing sample-data message)', async () => {
    const node = { id: '1', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', parameters: {} };
    const result = await webhookHandler(node, {}, { ...CTX, mode: 'test' });

    expect(result.status).toBe('simulated_success');
    expect(result.logs).toContain('Trigger: using provided sample data for test run.');
  });
});
