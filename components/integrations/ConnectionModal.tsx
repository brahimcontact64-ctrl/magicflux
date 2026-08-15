'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  Link2,
  Loader2,
  XCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { getRequiredCredentials } from '@/lib/credentials/provider-registry';
import { isOAuthOnlyProvider, canSubmitForm } from '@/lib/credentials/automation-brain-utils';

type Stage = 'idle' | 'connecting' | 'success' | 'failed';

export type ConnectionModalProps = {
  open: boolean;
  provider: string;
  displayName: string;
  accessToken: string | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: (provider: string) => void;
};

export function ConnectionModal({
  open,
  provider,
  displayName,
  accessToken,
  onOpenChange,
  onSuccess,
}: ConnectionModalProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<Stage>('idle');
  const [errorLines, setErrorLines] = useState<string[]>([]);

  const fields = getRequiredCredentials(provider);
  const isOAuth = isOAuthOnlyProvider(fields);
  const isConnecting = stage === 'connecting';

  function handleClose() {
    if (isConnecting) return;
    setValues({});
    setStage('idle');
    setErrorLines([]);
    onOpenChange(false);
  }

  function setValue(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleOAuthRedirect() {
    if (!accessToken) {
      setErrorLines(['Authentication required. Please refresh the page and try again.']);
      return;
    }
    setStage('connecting');
    setErrorLines([]);
    try {
      const res = await fetch('/api/oauth/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ provider }),
      });
      const data = (await res.json()) as { redirectUrl?: string; error?: string };
      if (!res.ok || !data.redirectUrl) {
        setStage('failed');
        setErrorLines([data.error ?? 'Failed to start OAuth flow. Please try again.']);
        return;
      }
      // Navigate to the provider OAuth page — JWT is never in this URL
      if (typeof window !== 'undefined') {
        window.location.href = data.redirectUrl;
      }
    } catch {
      setStage('failed');
      setErrorLines(['Network error. Please check your connection and try again.']);
    }
  }

  async function handleConnect() {
    setStage('connecting');
    setErrorLines([]);

    try {
      const res = await fetch('/api/credentials/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ provider, credentials: values }),
      });

      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        errors?: string[];
        requiresOAuthFlow?: boolean;
      };

      if (!res.ok || !data.success) {
        const lines =
          Array.isArray(data.errors) && data.errors.length > 0
            ? data.errors
            : [data.error ?? 'Failed to connect. Please check your credentials.'];
        setStage('failed');
        setErrorLines(lines);
        return;
      }
    } catch {
      setStage('failed');
      setErrorLines(['Network error. Please check your connection and try again.']);
      return;
    }

    setStage('success');
    setTimeout(() => {
      handleClose();
      onSuccess(provider);
    }, 1100);
  }

  const oauthSubmitDisabled = !accessToken || stage === 'success';
  const submitDisabled = isOAuth
    ? oauthSubmitDisabled
    : isConnecting || stage === 'success' || !canSubmitForm(fields, values);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Connect {displayName}</DialogTitle>
          <DialogDescription>
            {stage === 'connecting'
              ? `Verifying ${displayName} credentials…`
              : stage === 'success'
              ? 'Connected successfully'
              : isOAuth
              ? `Authorize MagicFlux to access ${displayName} via OAuth.`
              : 'Enter your credentials below. They are encrypted at rest.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* State banner */}
          {stage === 'connecting' && (
            <div className="flex items-center gap-2 rounded-md border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-600 dark:text-blue-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0" />
              Connecting to {displayName}…
            </div>
          )}
          {stage === 'success' && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
              {displayName} connected successfully
            </div>
          )}

          {/* OAuth-only providers */}
          {isOAuth && stage !== 'success' && (
            <div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-3 text-xs text-muted-foreground">
              <p className="flex items-center gap-1.5 font-medium text-blue-700 dark:text-blue-300 mb-1">
                <Link2 className="h-3.5 w-3.5" />
                OAuth authorization required
              </p>
              <p>
                {displayName} uses OAuth. Click the button below to authorize
                MagicFlux. You will be redirected back after approving access.
              </p>
            </div>
          )}

          {/* API key / manual fields */}
          {!isOAuth && stage !== 'success' && (
            <div className="space-y-3">
              {fields.map((field) => (
                <div key={field.key} className="space-y-1">
                  <Label htmlFor={`field-${field.key}`} className="text-xs font-medium">
                    {field.label}
                    {field.required && (
                      <span className="ml-0.5 text-red-500">*</span>
                    )}
                  </Label>
                  <Input
                    id={`field-${field.key}`}
                    type={field.secret ? 'password' : 'text'}
                    placeholder={field.description}
                    value={values[field.key] ?? ''}
                    disabled={isConnecting}
                    onChange={(e) => setValue(field.key, e.target.value)}
                    autoComplete="off"
                    data-1p-ignore
                    className="h-8 text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground capitalize">
                    {field.source.replace(/_/g, ' ')}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Error lines */}
          {stage === 'failed' && errorLines.length > 0 && (
            <div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 space-y-0.5">
              {errorLines.map((line, i) => (
                <p key={i} className="flex items-start gap-1.5 text-[11px] text-red-600 dark:text-red-400">
                  <XCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                  {line}
                </p>
              ))}
            </div>
          )}
        </div>

        <div className={cn('flex gap-2', 'justify-end')}>
          <Button
            variant="outline"
            size="sm"
            onClick={handleClose}
            disabled={isConnecting}
            className="text-xs"
          >
            Cancel
          </Button>
          {stage !== 'success' && (
            <Button
              size="sm"
              onClick={isOAuth ? handleOAuthRedirect : handleConnect}
              disabled={submitDisabled}
              className="text-xs"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  Verifying…
                </>
              ) : isOAuth ? (
                <>
                  <Link2 className="mr-1.5 h-3 w-3" />
                  Continue with OAuth
                </>
              ) : (
                'Save credentials'
              )}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
