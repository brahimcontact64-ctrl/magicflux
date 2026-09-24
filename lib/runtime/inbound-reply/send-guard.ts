import 'server-only';

import { getFollowupSequenceForOwner } from './storage';
import type { SequenceStatus } from './types';

/**
 * Workflow #2 Phase A -- the mandatory race-condition protection.
 *
 * "Follow-up becomes due" and "reply arrives" can happen at approximately
 * the same time. Removing a BullMQ job is not sufficient by itself (a job
 * already dequeued/running cannot be un-dequeued, and a distributed queue
 * offers no hard guarantee a removal request beats an in-flight worker).
 * The only correct guarantee is an AUTHORITATIVE, durable state check
 * performed immediately before the actual provider send call -- as close
 * to the send as the calling code can get it, so the window between "check"
 * and "send" is as small as possible (a residual, unavoidable window with
 * any check-then-act pattern; eliminating it entirely would require the
 * provider send itself to be transactional with the DB check, which no
 * email/Slack/SMS provider API supports).
 *
 * Every current and future follow-up-sending node handler MUST call
 * assertSequenceSendable() immediately before its provider API call and
 * suppress the send on any non-'active' result. No such node exists yet in
 * this phase (out of scope: Workflow #2 UI/template) -- this function and
 * its own race-condition test (see
 * tests/inbound-reply-send-guard.test.ts) are the deliverable; wiring a
 * real send node to call it is later work.
 */
export type SendGuardResult = { sendable: true } | { sendable: false; reason: string; currentStatus: SequenceStatus | null };

export async function assertSequenceSendable(sequenceId: string, userId: string): Promise<SendGuardResult> {
  const sequence = await getFollowupSequenceForOwner(sequenceId, userId);

  if (!sequence) {
    // Workflow #2 Phase C finding: an unknown sequence id is never sendable
    // -- fail closed, not open -- but this is a DIFFERENT fact from the
    // sequence genuinely being 'cancelled' (a domain/configuration error --
    // e.g. a misconfigured node parameter -- vs. a normal, expected business
    // outcome). Previously collapsed into currentStatus:'cancelled', which a
    // caller could not distinguish from a real cancellation; a caller that
    // needs to tell them apart (e.g. a node handler classifying "missing
    // sequence" as a configuration error rather than routine suppression)
    // checks for `currentStatus === null` specifically.
    return { sendable: false, reason: 'Follow-up sequence not found.', currentStatus: null };
  }

  if (sequence.status !== 'active') {
    return { sendable: false, reason: `Sequence is "${sequence.status}", not active -- follow-up send suppressed.`, currentStatus: sequence.status };
  }

  return { sendable: true };
}
