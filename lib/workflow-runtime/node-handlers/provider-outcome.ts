/**
 * Phase 9.9.11 -- Part E/H: shared provider-call outcome classification.
 *
 * Root cause this exists to fix: airtableHandler/slackHandler (unlike
 * emailHandler's existing classifySmtpFailure()) treated every failure
 * identically -- a clean 4xx/5xx HTTP response (the provider definitely
 * received and explicitly rejected the request -- safe to retry, nothing
 * was created) and a network-level throw/timeout (the request may have
 * already reached and been processed by the provider before the response
 * was lost -- retrying risks a REAL duplicate Airtable row / Slack message)
 * were both just `status:'failed'`, and node-runner.ts's retry loop cannot
 * tell them apart -- it would blindly retry both, which is exactly how a
 * timed-out-but-actually-successful create can become two rows.
 *
 * None of Airtable, Slack, or Gmail's APIs support a caller-supplied
 * idempotency key for the operations these handlers perform (see the
 * Phase 9.9.11 report's provider truth table) -- so this classification,
 * not a provider-side guarantee, is what keeps a genuinely ambiguous
 * outcome from being blindly retried. A response actually received from
 * the provider (any status) means the provider explicitly accepted or
 * rejected the request -- that outcome is trustworthy. A thrown error from
 * fetch() itself (DNS failure, connection reset, timeout) means we cannot
 * prove the request never reached the provider -- classified indeterminate,
 * mirroring the exact reasoning emailHandler's classifySmtpFailure() already
 * applies to an SMTP connection dropping during/after the DATA command.
 */

export type FetchAttemptOutcome =
  | { kind: 'response'; response: Response }
  | { kind: 'indeterminate'; message: string };

/** Runs `fetch()` and classifies a thrown error as indeterminate rather than a normal, safely-retryable failure -- never throws itself. */
export async function fetchWithOutcome(input: string | URL, init?: RequestInit): Promise<FetchAttemptOutcome> {
  try {
    const response = await fetch(input, init);
    return { kind: 'response', response };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'indeterminate',
      message: `The request may or may not have reached the provider before this failed: ${message}`,
    };
  }
}

/**
 * Builds the (error, nonRetryable) pair a handler's `status:'failed'` return
 * should carry for an indeterminate outcome -- reuses the EXISTING
 * `nonRetryable` contract (lib/workflow-runtime/types.ts, already respected
 * by node-runner.ts's retry loop) so an indeterminate write is never
 * automatically retried at any layer, exactly like emailHandler's DATA-
 * command case.
 */
export function indeterminateFailure(operationLabel: string, message: string): { error: string; nonRetryable: true; failureClass: 'indeterminate' } {
  return {
    error: `INDETERMINATE: ${operationLabel} may have already succeeded remotely -- ${message}. Not retrying automatically to avoid a duplicate; this requires manual verification.`,
    nonRetryable: true,
    failureClass: 'indeterminate',
  };
}

/**
 * Phase 9.9.14 -- Part C/J: a DEFINITIVE provider rejection proving nothing
 * was created (a revoked/invalid credential, a permission error) is a
 * completely different situation from indeterminateFailure() above: the
 * provider explicitly responded, so there is zero ambiguity about whether
 * the side effect happened -- it did not. Retrying immediately cannot
 * possibly succeed (the same bad credential will fail identically every
 * time) and just wastes the node's retry budget hammering the provider, so
 * this is nonRetryable too -- but unlike an indeterminate outcome, it is
 * safe to retry LATER, once an operator actually fixes the configuration,
 * which is why failureClass is 'blocked_configuration' (ledgered 'failed',
 * reclaimable) rather than 'indeterminate' (the ledger's CAS rules never
 * allow reclaiming that).
 */
export function configBlockedFailure(operationLabel: string, statusCode: number, providerMessage: string): { error: string; nonRetryable: true; failureClass: 'blocked_configuration' } {
  return {
    error: `CONFIG_BLOCKED: ${operationLabel} was rejected by the provider (HTTP ${statusCode}) -- ${providerMessage}. This is a configuration problem (revoked/invalid credential or missing permission), not a transient failure -- retrying now cannot succeed. Reconnect the integration, then retry.`,
    nonRetryable: true,
    failureClass: 'blocked_configuration',
  };
}

/** True for the HTTP status codes that unambiguously mean "the credential/authorization itself is invalid," never a transient provider condition. */
export function isAuthRejectionStatus(status: number): boolean {
  return status === 401 || status === 403;
}
