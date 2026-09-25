import 'server-only';

import { assertLocalSupabaseTargetOrExit } from './production-guard';
import { PHASE_D_STAGING_MARKER } from './seed-staging-data';
import type { GmailApiClient, PollGmailResult } from '@/lib/runtime/inbound-reply/gmail-poll';
import type { FollowupSendResult, OutboundProviderClient } from '@/lib/runtime/inbound-reply/types';
import { sendFollowupMessage } from '@/lib/runtime/inbound-reply/send-followup';
import { pollGmailInboundReplies } from '@/lib/runtime/inbound-reply/gmail-poll';
import { getFollowupSequenceForOwner } from '@/lib/runtime/inbound-reply/storage';

/**
 * Workflow #2 Phase D.1 -- the local-only certification harness. Structured
 * as independently-callable STAGES, not one long blocking script: the "send"
 * stage returns as soon as the message is sent, so a human can go read
 * their inbox and reply on their own time; a LATER, separate invocation of
 * the "check reply" stage picks up wherever the previous one left off. No
 * stage ever sleeps/polls in a loop waiting for a human -- "no reply yet" is
 * a normal, safe, re-checkable result, never a hang or a failure.
 *
 * Every stage:
 *   - calls assertLocalSupabaseTargetOrExit() first, refusing anything but
 *     a recognized local Supabase target.
 *   - logs only the fixed CertificationEvidence shape below -- structurally
 *     impossible to accidentally include a message body, an OAuth token, or
 *     any other secret, since logEvidence() only ever accepts that one
 *     narrow type, never an arbitrary object.
 *   - reuses lib/runtime/inbound-reply/{send-followup,gmail-poll,storage}.ts
 *     verbatim -- no parallel execution path.
 *
 * Phase D.1 itself only prepares and unit-tests this harness (against
 * injected fakes) -- it is not invoked against a real Gmail account or a
 * real send in this milestone. A human runs it for real in Phase D.2, after
 * a dedicated test Gmail mailbox is connected in the local staging
 * environment.
 */

export type CertificationEvidence = {
  stage: 'sent' | 'awaiting_reply' | 'reply_processed' | 'suppression_verified' | 'duplicate_verified' | 'error';
  executionId: string;
  sequenceId: string;
  conversationId: string;
  providerMessageId?: string | null;
  providerThreadId?: string | null;
  correlationMethod?: string;
  sequenceStatus?: string;
  suppressionResult?: string;
  note?: string;
  timestamp: string;
};

function logEvidence(evidence: CertificationEvidence): void {
  console.log(`[phase-d-cert] ${JSON.stringify(evidence)}`);
}

export type SendStageResult = { ok: true; evidence: CertificationEvidence } | { ok: false; evidence: CertificationEvidence };

/** Stage 1: real Follow-up Send. Pauses here (no polling loop) -- the human replies on their own schedule. */
export async function runSendStage(params: {
  supabaseUrl: string;
  sequenceId: string;
  userId: string;
  executionId: string;
  conversationId: string;
  to: string;
  provider: OutboundProviderClient;
  getAccessToken: (userId: string) => Promise<string>;
}): Promise<SendStageResult> {
  assertLocalSupabaseTargetOrExit(params.supabaseUrl);

  const attemptKey = `${PHASE_D_STAGING_MARKER}:${params.executionId}:cert-node:${params.sequenceId}`;
  const result: FollowupSendResult = await sendFollowupMessage(
    { sequenceId: params.sequenceId, userId: params.userId, attemptKey, to: params.to, subject: `${PHASE_D_STAGING_MARKER} certification message`, body: 'This is an automated Phase D certification message. Please reply to this email to continue the certification.' },
    params.provider,
    params.getAccessToken
  );

  if (result.outcome !== 'sent') {
    const evidence: CertificationEvidence = { stage: 'error', executionId: params.executionId, sequenceId: params.sequenceId, conversationId: params.conversationId, note: `send stage did not reach 'sent': ${result.outcome}`, timestamp: new Date().toISOString() };
    logEvidence(evidence);
    return { ok: false, evidence };
  }

  const evidence: CertificationEvidence = {
    stage: 'sent',
    executionId: params.executionId,
    sequenceId: params.sequenceId,
    conversationId: params.conversationId,
    providerMessageId: result.providerMessageId,
    providerThreadId: result.providerThreadId,
    timestamp: new Date().toISOString(),
  };
  logEvidence(evidence);
  return { ok: true, evidence };
}

export type ReplyCheckStageResult =
  | { ok: true; status: 'awaiting_reply'; evidence: CertificationEvidence }
  | { ok: true; status: 'reply_processed'; evidence: CertificationEvidence }
  | { ok: false; evidence: CertificationEvidence };

/** Stage 2: poll Gmail once and process whatever inbound replies exist. Returns 'awaiting_reply' (not an error) if nothing has arrived yet -- safe to call again later. */
export async function runReplyCheckStage(params: {
  supabaseUrl: string;
  userId: string;
  executionId: string;
  sequenceId: string;
  conversationId: string;
  gmailClient: GmailApiClient;
}): Promise<ReplyCheckStageResult> {
  assertLocalSupabaseTargetOrExit(params.supabaseUrl);

  let pollResult: PollGmailResult;
  try {
    pollResult = await pollGmailInboundReplies(params.userId, params.gmailClient);
  } catch (err) {
    const evidence: CertificationEvidence = { stage: 'error', executionId: params.executionId, sequenceId: params.sequenceId, conversationId: params.conversationId, note: err instanceof Error ? err.message : String(err), timestamp: new Date().toISOString() };
    logEvidence(evidence);
    return { ok: false, evidence };
  }

  if (pollResult.outcome !== 'processed' || pollResult.messageResults.length === 0) {
    const evidence: CertificationEvidence = { stage: 'awaiting_reply', executionId: params.executionId, sequenceId: params.sequenceId, conversationId: params.conversationId, note: `poll outcome: ${pollResult.outcome}, no new messages yet`, timestamp: new Date().toISOString() };
    logEvidence(evidence);
    return { ok: true, status: 'awaiting_reply', evidence };
  }

  const sequence = await getFollowupSequenceForOwner(params.sequenceId, params.userId);
  const evidence: CertificationEvidence = {
    stage: 'reply_processed',
    executionId: params.executionId,
    sequenceId: params.sequenceId,
    conversationId: params.conversationId,
    sequenceStatus: sequence?.status,
    timestamp: new Date().toISOString(),
  };
  logEvidence(evidence);
  return { ok: true, status: 'reply_processed', evidence };
}

/** Stage 3: attempt the next follow-up -- must be suppressed if the sequence was replied to. */
export async function runSuppressionVerificationStage(params: {
  supabaseUrl: string;
  sequenceId: string;
  userId: string;
  executionId: string;
  conversationId: string;
  to: string;
  provider: OutboundProviderClient;
  getAccessToken: (userId: string) => Promise<string>;
}): Promise<{ ok: boolean; evidence: CertificationEvidence }> {
  assertLocalSupabaseTargetOrExit(params.supabaseUrl);

  const attemptKey = `${PHASE_D_STAGING_MARKER}:${params.executionId}:cert-node-followup-2:${params.sequenceId}`;
  const result = await sendFollowupMessage(
    { sequenceId: params.sequenceId, userId: params.userId, attemptKey, to: params.to, subject: `${PHASE_D_STAGING_MARKER} second follow-up`, body: 'This should never be sent if the sequence was already replied to.' },
    params.provider,
    params.getAccessToken
  );

  const suppressionResult = result.outcome === 'suppressed' && result.currentStatus === 'replied' ? 'SUPPRESSED_SEQUENCE_REPLIED' : result.outcome;
  const evidence: CertificationEvidence = {
    stage: 'suppression_verified',
    executionId: params.executionId,
    sequenceId: params.sequenceId,
    conversationId: params.conversationId,
    suppressionResult,
    timestamp: new Date().toISOString(),
  };
  logEvidence(evidence);
  return { ok: suppressionResult === 'SUPPRESSED_SEQUENCE_REPLIED', evidence };
}

/** Stage 4: re-run the reply-check stage again (a re-delivery/duplicate history entry) and confirm it is an idempotent no-op -- no second transition, no second event. */
export async function runDuplicateReplayVerificationStage(params: {
  supabaseUrl: string;
  userId: string;
  executionId: string;
  sequenceId: string;
  conversationId: string;
  gmailClient: GmailApiClient;
}): Promise<{ ok: boolean; evidence: CertificationEvidence }> {
  assertLocalSupabaseTargetOrExit(params.supabaseUrl);

  const before = await getFollowupSequenceForOwner(params.sequenceId, params.userId);
  const replay = await runReplyCheckStage(params);
  const after = await getFollowupSequenceForOwner(params.sequenceId, params.userId);

  const noStateChange = before?.status === after?.status && before?.repliedAt === after?.repliedAt;
  const evidence: CertificationEvidence = {
    stage: 'duplicate_verified',
    executionId: params.executionId,
    sequenceId: params.sequenceId,
    conversationId: params.conversationId,
    sequenceStatus: after?.status,
    note: noStateChange ? 'idempotent no-op confirmed' : 'STATE CHANGED ON REPLAY -- NOT IDEMPOTENT',
    timestamp: new Date().toISOString(),
  };
  logEvidence(evidence);
  return { ok: replay.ok && noStateChange, evidence };
}
