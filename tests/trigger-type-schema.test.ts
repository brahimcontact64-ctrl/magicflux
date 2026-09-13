/**
 * Phase 9.8.6 — immediate/manual trigger generation.
 *
 * Root cause: generate_workflow_json's `trigger` argument was a free-form
 * string whose description listed six examples (new_email, new_order,
 * webhook, schedule, new_message, form_submit) -- none of which represent
 * a one-time/immediate "do this now" request. Facing "send an email now",
 * the model had no listed option that fit and improvised: one real
 * production session picked "webhook" (an externally-callable endpoint
 * nobody asked for), an independent reproduction invented an entirely
 * unlisted value ("new_message"). Separately, "new_email" mapped to
 * n8n-nodes-base.gmailTrigger, which lib/workflow-runtime/node-capabilities.ts
 * explicitly blocklists as a silent no-op (send-only handler, no real
 * inbox-watching) -- so it was never a real option either.
 *
 * Fix: the schema now constrains `trigger` to an explicit enum of values
 * the native runtime actually supports end-to-end (manual_trigger, webhook,
 * schedule, new_order), with explicit guidance to use manual_trigger for
 * one-time/immediate requests and never substitute webhook unless an
 * externally-callable endpoint was actually requested. A defense-in-depth
 * check in executor.ts (isSupportedTriggerType()) fails the tool call
 * closed if the model deviates from the enum anyway.
 */

import { describe, it, expect } from 'vitest';
import { SUPPORTED_TRIGGER_TYPES, isSupportedTriggerType, AGENT_TOOLS } from '../lib/agent/tools';

function getGenerateWorkflowJsonTool() {
  const tool = AGENT_TOOLS.find((t) => 'function' in t && t.function.name === 'generate_workflow_json');
  if (!tool || !('function' in tool)) throw new Error('generate_workflow_json tool not found');
  return tool.function;
}

describe('generate_workflow_json trigger schema (Phase 9.8.6)', () => {
  it('is enum-constrained, not free-form text', () => {
    const fn = getGenerateWorkflowJsonTool();
    const params = fn.parameters as { properties: { trigger: { type: string; enum?: string[] } } };
    expect(params.properties.trigger.type).toBe('string');
    expect(Array.isArray(params.properties.trigger.enum)).toBe(true);
    expect(params.properties.trigger.enum).toEqual([...SUPPORTED_TRIGGER_TYPES]);
  });

  it('#6: manual_trigger is a supported, listed value for one-time/immediate requests', () => {
    expect(SUPPORTED_TRIGGER_TYPES).toContain('manual_trigger');
    const fn = getGenerateWorkflowJsonTool();
    const description = (fn.parameters as { properties: { trigger: { description: string } } }).properties.trigger.description;
    expect(description.toLowerCase()).toMatch(/manual_trigger/);
    expect(description.toLowerCase()).toMatch(/one-time|immediate|do this now/);
  });

  it('#7: webhook remains supported for an explicit externally-callable endpoint request', () => {
    expect(SUPPORTED_TRIGGER_TYPES).toContain('webhook');
    const fn = getGenerateWorkflowJsonTool();
    const description = (fn.parameters as { properties: { trigger: { description: string } } }).properties.trigger.description;
    expect(description.toLowerCase()).toMatch(/never use webhook.*unless.*explicitly/);
  });

  it('#8: schedule remains supported for recurring/time-based automations', () => {
    expect(SUPPORTED_TRIGGER_TYPES).toContain('schedule');
  });

  it('never-supported inbox-watching/ambiguous values are no longer offered as examples', () => {
    expect(SUPPORTED_TRIGGER_TYPES).not.toContain('new_email' as never);
    expect(SUPPORTED_TRIGGER_TYPES).not.toContain('new_message' as never);
    expect(SUPPORTED_TRIGGER_TYPES).not.toContain('form_submit' as never);
    const fn = getGenerateWorkflowJsonTool();
    const description = (fn.parameters as { properties: { trigger: { description: string } } }).properties.trigger.description;
    expect(description).not.toMatch(/new_email/);
    expect(description).not.toMatch(/new_message/);
    expect(description).not.toMatch(/form_submit/);
  });

  describe('#9: isSupportedTriggerType — defense-in-depth against a model deviation from the enum', () => {
    it('accepts every genuinely supported value', () => {
      for (const value of SUPPORTED_TRIGGER_TYPES) {
        expect(isSupportedTriggerType(value)).toBe(true);
      }
    });

    it('rejects an invented/unsupported value', () => {
      expect(isSupportedTriggerType('new_message')).toBe(false);
      expect(isSupportedTriggerType('new_email')).toBe(false);
      expect(isSupportedTriggerType('form_submit')).toBe(false);
      expect(isSupportedTriggerType('anything_the_model_makes_up')).toBe(false);
      expect(isSupportedTriggerType('')).toBe(false);
    });
  });
});
