'use client';

import { useState } from 'react';
import { Loader2, PlayCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useControlApi } from './use-control-api';

/**
 * Incident 9.9.17M -- a deliberately temporary, single-purpose diagnostic
 * control. Triggers exactly one real getValidAccessToken()/refreshOAuthToken()
 * call for the CALLER's own Gmail credential from Vercel's own runtime, so a
 * Vercel-side refresh attempt can be observed directly instead of inferred
 * from historical timestamps. Provider is fixed to 'gmail' -- there is no
 * input for any other value. Displays only sanitized outcome/classification
 * and one-way fingerprints -- never a token or secret.
 */

type Outcome = 'refresh_succeeded' | 'no_refresh_needed' | 'config_fault' | 'reconnect_required' | 'transient' | 'unknown' | 'error';

type Result = {
  provider: string;
  preCheck: { hadStoredToken: boolean; wasAlreadyExpiredOrDueForRefresh: boolean | null; attemptedNetworkCall: boolean };
  outcome: Outcome;
  httpStatus?: number | null;
  oauthErrorCode?: string | null;
  sanitizedDescription?: string | null;
  clientFingerprint?: { clientIdFingerprint: string | null; clientSecretFingerprint: string | null } | null;
  refreshTokenFingerprint?: string | null;
  refreshTokenFingerprintBefore?: string | null;
  refreshTokenFingerprintAfter?: string | null;
  refreshTokenRotated?: boolean | null;
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  refresh_succeeded: 'Refresh succeeded (real Google exchange completed)',
  no_refresh_needed: 'No refresh attempted -- stored token was still fresh',
  config_fault: 'Platform OAuth-client fault (Google rejected the client, not the user)',
  reconnect_required: 'Reconnect required (grant genuinely dead/revoked)',
  transient: 'Transient provider/network failure',
  unknown: 'Unrecognized Google error code',
  error: 'Error before reaching Google',
};

export function OAuthRefreshTestPanel() {
  const { post } = useControlApi();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const run = async () => {
    setRunning(true);
    setResult(null);
    const res = await post<Result>('/api/runtime/control/oauth-refresh-test', { provider: 'gmail' });
    if (res) setResult(res);
    setRunning(false);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Triggers exactly one real Gmail OAuth refresh attempt for your own connected credential, from Vercel&apos;s
        runtime, under your session. Never displays a token or secret -- only sanitized outcome and one-way
        fingerprints.
      </p>
      <Button size="sm" disabled={running} onClick={run}>
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <PlayCircle className="h-3.5 w-3.5 mr-1" />}
        Run Gmail refresh test
      </Button>

      {result ? (
        <div className="rounded-lg border border-border p-3 space-y-2 text-xs">
          <div className="font-medium">{OUTCOME_LABEL[result.outcome] ?? result.outcome}</div>
          <div className="text-muted-foreground space-y-1">
            <div>had stored token: {String(result.preCheck.hadStoredToken)}</div>
            <div>was due for refresh: {String(result.preCheck.wasAlreadyExpiredOrDueForRefresh)}</div>
            <div>attempted a real network call to Google: {String(result.preCheck.attemptedNetworkCall)}</div>
            {result.httpStatus != null ? <div>Google HTTP status: {result.httpStatus}</div> : null}
            {result.oauthErrorCode ? <div>OAuth error code: {result.oauthErrorCode}</div> : null}
            {result.sanitizedDescription ? <div>description: {result.sanitizedDescription}</div> : null}
            {result.clientFingerprint ? (
              <div>
                client fingerprint: {result.clientFingerprint.clientIdFingerprint} / {result.clientFingerprint.clientSecretFingerprint}
              </div>
            ) : null}
            {result.refreshTokenFingerprint ? <div>refresh-token fingerprint: {result.refreshTokenFingerprint}</div> : null}
            {result.refreshTokenFingerprintBefore ? (
              <div>refresh-token fingerprint before → after: {result.refreshTokenFingerprintBefore} → {result.refreshTokenFingerprintAfter}</div>
            ) : null}
            {result.refreshTokenRotated != null ? <div>refresh token rotated: {String(result.refreshTokenRotated)}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
