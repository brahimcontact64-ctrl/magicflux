'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Link2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getProviderDisplayName } from '@/lib/credentials/provider-registry';
import { ConnectionModal } from '@/components/integrations/ConnectionModal';
import { supabase } from '@/lib/supabase-client';

type Status = 'loading' | 'connected' | 'missing';

interface Props {
  provider: string;
}

export function CredentialPicker({ provider }: Props) {
  const [status, setStatus] = useState<Status>('loading');
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const displayName = getProviderDisplayName(provider);

  // Resolve access token from Supabase session
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null);
    });
  }, []);

  async function checkStatus(token: string | null) {
    setStatus('loading');
    try {
      const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(
        `/api/credentials/status?provider=${encodeURIComponent(provider)}`,
        { headers },
      );
      if (res.ok) {
        const data = (await res.json()) as { connected: boolean };
        setStatus(data.connected ? 'connected' : 'missing');
      } else {
        setStatus('missing');
      }
    } catch {
      setStatus('missing');
    }
  }

  useEffect(() => {
    checkStatus(accessToken);
  }, [provider, accessToken]);

  return (
    <>
      <div
        className={cn(
          'flex items-center justify-between rounded-md px-2.5 py-2 text-xs border',
          status === 'connected'
            ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-800'
            : status === 'loading'
            ? 'bg-muted/30 border-border'
            : 'bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800',
        )}
      >
        <div className="flex items-center gap-1.5">
          {status === 'loading' && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
          {status === 'connected' && (
            <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
          )}
          {status === 'missing' && (
            <AlertCircle className="h-3 w-3 text-red-500" />
          )}
          <span
            className={cn(
              status === 'connected'
                ? 'text-emerald-700 dark:text-emerald-300'
                : status === 'missing'
                ? 'text-red-600 dark:text-red-400'
                : 'text-muted-foreground',
            )}
          >
            {status === 'loading'
              ? `Checking ${displayName}…`
              : status === 'connected'
              ? `${displayName} connected`
              : `${displayName} not connected`}
          </span>
        </div>

        {status !== 'loading' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px]"
            onClick={() => setModalOpen(true)}
          >
            <Link2 className="h-2.5 w-2.5 mr-1" />
            {status === 'connected' ? 'Manage' : 'Connect'}
          </Button>
        )}
      </div>

      <ConnectionModal
        open={modalOpen}
        provider={provider}
        displayName={displayName}
        accessToken={accessToken}
        onOpenChange={setModalOpen}
        onSuccess={() => {
          setStatus('connected');
          setModalOpen(false);
        }}
      />
    </>
  );
}
