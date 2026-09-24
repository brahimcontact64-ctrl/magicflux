/**
 * Workflow #2 Phase C -- Follow-up Send: magicflux-nodes.followUpSend.
 *
 * A first-class, runtime-addressable node that turns Phase B's guarded
 * follow-up orchestration (lib/runtime/inbound-reply/send-followup.ts) into
 * a real workflow step, following the exact conventions
 * human-review.ts/wait.ts/email.ts already established. This handler does
 * NOT reimplement the send guard, the send lock, the Gmail API call, token
 * refresh, or outbound recording -- it resolves node parameters, calls
 * sendFollowupMessage(), and translates the result into a NodeHandlerResult.
 *
 * NOT YET PRODUCTION-READY: registered here (and in HANDLER_NODE_ALLOWLIST)
 * so this file is real, dispatchable, and directly testable -- exactly the
 * same posture googledrive.ts already has -- but blocked from actually
 * reaching a real workflow via node-capabilities.ts's BLOCKLIST (required
 * migrations 20260924000001/20260924000002 are unapplied, and no live Gmail
 * send-path certification has occurred). See node-capabilities.ts's own
 * BLOCKLIST entry for magicflux-nodes.followUpSend for the exact reasoning.
 */

import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';
import { getValidAccessToken } from '@/lib/credentials/oauth-refresh';
import { sendFollowupMessage } from '@/lib/runtime/inbound-reply/send-followup';
import { gmailOutboundProviderClient } from '@/lib/runtime/inbound-reply/gmail-send-adapter';
import { isSchemaMissingError } from '@/lib/runtime/inbound-reply/storage';
import { indeterminateFailure, configBlockedFailure } from './provider-outcome';
import { resolveFieldReference, resolveNotificationTemplate } from './json-field-reference';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function getParam(node: EngineNode, keys: string[]): string {
  const params = node.parameters ?? {};
  for (const key of keys) {
    const val = params[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return '';
}

/**
 * Node parameter schema -- the smallest safe shape needed:
 *   sequenceId  (required) -- the Phase A/B runtime_followup_sequences row
 *               to act on. Supports whole-value `={{$json["field"]}}`
 *               resolution (same narrow grammar every other handler uses)
 *               so a prior node's output can supply it -- never
 *               hard-coded to a specific workflow.
 *   provider    (optional, defaults 'gmail') -- validated against a small
 *               allowlist; only 'gmail' is currently implemented. A
 *               workflow requesting any other value fails validation
 *               rather than silently falling back to Gmail or a no-op, so
 *               this node never falsely advertises a provider it can't
 *               actually use.
 *   to          (required) -- recipient address, whole-value resolvable
 *               (mirrors emailHandler's own `resolveParam` convention for
 *               recipients).
 *   subject/body (required) -- embedded-template resolvable via the SAME
 *               resolveNotificationTemplate() emailHandler already uses
 *               (supports {{$json["field"]}} and {{?field}}...{{/field}}
 *               optional blocks).
 *
 * conversationId is deliberately NOT a parameter: sendFollowupMessage()
 * derives it internally from the resolved sequence, so exposing it here
 * would be redundant configuration a caller could get out of sync with the
 * real sequence -- the smallest safe schema omits it entirely.
 */
export type FollowUpSendValidationError = { field: string; reason: string };

function validateAndResolveParams(
  node: EngineNode,
  data: Record<string, unknown>
): { ok: true; sequenceId: string; provider: string; to: string; subject: string; body: string } | { ok: false; error: FollowUpSendValidationError } {
  const rawSequenceId = getParam(node, ['sequenceId']);
  if (!rawSequenceId) return { ok: false, error: { field: 'sequenceId', reason: 'sequenceId is required.' } };
  const resolvedSequenceId = resolveFieldReference(rawSequenceId, data);
  const sequenceId = typeof resolvedSequenceId === 'string' ? resolvedSequenceId : resolvedSequenceId != null ? String(resolvedSequenceId) : '';
  if (!sequenceId) return { ok: false, error: { field: 'sequenceId', reason: 'sequenceId resolved to an empty value.' } };

  const provider = (getParam(node, ['provider']) || 'gmail').toLowerCase();
  if (provider !== 'gmail') {
    return { ok: false, error: { field: 'provider', reason: `Provider "${provider}" is not supported yet -- only "gmail" is implemented.` } };
  }

  const rawTo = getParam(node, ['to', 'recipient']);
  if (!rawTo) return { ok: false, error: { field: 'to', reason: 'to (recipient) is required.' } };
  const resolvedTo = resolveFieldReference(rawTo, data);
  const to = typeof resolvedTo === 'string' ? resolvedTo : resolvedTo != null ? String(resolvedTo) : '';
  if (!to) return { ok: false, error: { field: 'to', reason: 'to (recipient) resolved to an empty value.' } };

  const subjectResult = resolveNotificationTemplate(getParam(node, ['subject']), data);
  if (!subjectResult.ok) return { ok: false, error: { field: 'subject', reason: subjectResult.reason } };

  const bodyResult = resolveNotificationTemplate(getParam(node, ['body', 'text', 'message']), data);
  if (!bodyResult.ok) return { ok: false, error: { field: 'body', reason: bodyResult.reason } };

  return { ok: true, sequenceId, provider, to, subject: subjectResult.value, body: bodyResult.value };
}

/**
 * Deterministic attempt-key convention (Workflow #2 Phase C's own explicit
 * requirement): derived from durable workflow identity available in
 * NodeHandlerContext -- executionId (this specific run) + node.id (this
 * specific step in the graph -- naturally distinguishes "step 1" from
 * "step 2" of a multi-step sequence, since each is a DIFFERENT node in the
 * graph with its own id, exactly like human-review.ts's own
 * (executionId, nodeId) durable-identity convention) + the resolved
 * sequenceId (which logical sequence this attempt belongs to). The SAME
 * three inputs on a genuine retry (same execution, same node, same
 * resolved sequence) always produce the SAME key; a different node (a
 * different follow-up step) or a different execution (a genuinely new
 * trigger) always produces a different one. No random/unstable component.
 */
export function buildDeterministicAttemptKey(params: { executionId: string; nodeId: string; sequenceId: string }): string {
  return `followup-send:${params.executionId}:${params.nodeId}:${params.sequenceId}`;
}

export type FollowUpSendResultCode =
  | 'SENT'
  | 'SUPPRESSED_SEQUENCE_REPLIED'
  | 'SUPPRESSED_SEQUENCE_CANCELLED'
  | 'SUPPRESSED_SEQUENCE_COMPLETED'
  | 'DUPLICATE_ALREADY_SENT'
  | 'LOCK_NOT_ACQUIRED'
  | 'PROVIDER_FAILED'
  | 'PROVIDER_INDETERMINATE';

export async function followUpSendHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);

  if (context.mode === 'test') {
    logs.push('Follow-up Send: simulated in test mode -- no real send, no sequence state touched.');
    return { status: 'simulated_success', outputData: { ...data, followup_send_result: 'SENT' as FollowUpSendResultCode }, logs };
  }

  const nodeId = String(node.id ?? node.name ?? '').trim();
  if (!context.userId || !context.workflowId || !context.executionId || !nodeId) {
    const error = 'Follow-up Send requires an active execution context (userId/workflowId/executionId).';
    logs.push(error);
    return { status: 'failed', outputData: null, logs, error };
  }

  const params = validateAndResolveParams(node, data);
  if (!params.ok) {
    const error = `Follow-up Send configuration error (${params.error.field}): ${params.error.reason}`;
    logs.push(error);
    return { status: 'failed', outputData: null, logs, error };
  }

  const attemptKey = buildDeterministicAttemptKey({ executionId: context.executionId, nodeId, sequenceId: params.sequenceId });

  let result;
  try {
    result = await sendFollowupMessage(
      { sequenceId: params.sequenceId, userId: context.userId, attemptKey, to: params.to, subject: params.subject, body: params.body },
      gmailOutboundProviderClient,
      (userId) => getValidAccessToken(userId, 'gmail')
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isSchemaMissingError({ message })) {
      // Migration-aware safety (Phase C explicit requirement): a missing
      // table/function must never be reported as "credential invalid" or
      // "provider failed" -- distinctly flagged, and treated as needing an
      // operator action (apply the migration), not a blind retry.
      const error = `INFRASTRUCTURE_NOT_READY: Follow-up Send's required database schema is not yet applied (${message}). This is not a credential or provider problem -- the required migration(s) must be applied before this node can run.`;
      logs.push(error);
      return { status: 'failed', outputData: null, logs, ...configBlockedFailure('Follow-up Send infrastructure check', 0, error) };
    }
    logs.push(`Follow-up Send: unexpected error -- ${message}`);
    return { status: 'failed', outputData: null, logs, error: message };
  }

  switch (result.outcome) {
    case 'sent': {
      logs.push(`Follow-up Send: sent to ${params.to} via ${params.provider}. providerMessageId=${result.providerMessageId}${result.sentDuringRaceWindow ? ' (NOTE: a reply committed during this send -- see sent_during_race_window)' : ''}`);
      return {
        status: 'success',
        outputData: {
          ...data,
          followup_send_result: 'SENT' as FollowUpSendResultCode,
          outbound_message_id: result.outboundMessageId,
          provider_message_id: result.providerMessageId,
          provider_thread_id: result.providerThreadId,
          sent_during_race_window: result.sentDuringRaceWindow,
        },
        logs,
      };
    }

    case 'duplicate_attempt': {
      logs.push('Follow-up Send: this exact logical attempt was already sent -- no duplicate send performed.');
      return {
        status: 'success',
        outputData: { ...data, followup_send_result: 'DUPLICATE_ALREADY_SENT' as FollowUpSendResultCode, outbound_message_id: result.existingOutboundMessageId },
        logs,
      };
    }

    case 'suppressed': {
      if (result.currentStatus === null) {
        // A missing sequence is a configuration/domain error (Phase C
        // explicit requirement), never ordinary business suppression --
        // the workflow was configured to act on a sequence that doesn't
        // exist. Non-retryable: retrying with the same bad sequenceId can
        // never succeed.
        const error = `Follow-up Send: ${result.reason}`;
        logs.push(error);
        return { status: 'failed', outputData: null, logs, error, nonRetryable: true, failureClass: 'blocked_configuration' };
      }
      if (result.currentStatus === 'active') {
        // Send-lock contention: transient, another attempt currently holds
        // the lease. Normal retryable failure -- the existing runtime retry
        // mechanism will naturally try again shortly, which is exactly the
        // right behavior for this condition (never permanently suppressed).
        logs.push(`Follow-up Send: ${result.reason}`);
        return { status: 'failed', outputData: { followup_send_result: 'LOCK_NOT_ACQUIRED' as FollowUpSendResultCode }, logs, error: `LOCK_NOT_ACQUIRED: ${result.reason}` };
      }
      // Genuine terminal-status suppression (replied/cancelled/completed) --
      // this IS the stop-on-reply feature working as intended. Successful
      // node completion, never a workflow crash.
      const code: FollowUpSendResultCode =
        result.currentStatus === 'replied' ? 'SUPPRESSED_SEQUENCE_REPLIED'
        : result.currentStatus === 'cancelled' ? 'SUPPRESSED_SEQUENCE_CANCELLED'
        : 'SUPPRESSED_SEQUENCE_COMPLETED';
      logs.push(`Follow-up Send: suppressed -- ${result.reason}`);
      return { status: 'success', outputData: { ...data, followup_send_result: code }, logs };
    }

    case 'credential_unavailable': {
      logs.push(`Follow-up Send: credential unavailable -- ${result.reason}`);
      // "No valid OAuth credentials stored" (oauth-refresh.ts's own exact
      // thrown message) means Gmail was never connected at all -- a
      // permanent configuration problem, not a transient one. Any other
      // credential-resolution failure (e.g. a refresh-endpoint network
      // blip) is treated as ordinary, retryable per existing runtime
      // semantics -- "temporarily unavailable," per Phase C's own wording.
      if (/no valid oauth credentials stored/i.test(result.reason)) {
        return { status: 'failed', outputData: null, logs, ...configBlockedFailure('Gmail credential resolution', 0, result.reason) };
      }
      return { status: 'failed', outputData: null, logs, error: result.reason };
    }

    case 'send_failed': {
      // A definite provider rejection (e.g. a clean 4xx/5xx HTTP response)
      // is a normal, safely-retryable failure -- mirrors the EXISTING
      // convention in lib/workflow-runtime/node-handlers/provider-outcome.ts's
      // own doc comment: "a clean HTTP error response... is a normal,
      // retryable failure -- never nonRetryable."
      logs.push(`Follow-up Send: provider rejected the send -- ${result.reason}`);
      return { status: 'failed', outputData: { followup_send_result: 'PROVIDER_FAILED' as FollowUpSendResultCode }, logs, error: `PROVIDER_FAILED: ${result.reason}` };
    }

    case 'send_indeterminate': {
      // Reuses the EXISTING indeterminate-failure contract emailHandler
      // already established -- never blindly retried, since the send may
      // have already reached Gmail.
      logs.push(`Follow-up Send: indeterminate outcome -- ${result.reason}`);
      return { status: 'failed', outputData: { followup_send_result: 'PROVIDER_INDETERMINATE' as FollowUpSendResultCode }, logs, ...indeterminateFailure('Follow-up Send', result.reason) };
    }
  }
}
