'use client';

import { useState } from 'react';
import { CheckCircle2, AlertCircle, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getProviderDisplayName } from '@/lib/credentials/provider-registry';
import { ConnectionModal } from '@/components/integrations/ConnectionModal';

interface Props {
  provider: string;
  connected: boolean;
  accessToken: string | null;
  onRefresh?: () => void;
}

export function CredentialCard({ provider, connected, accessToken, onRefresh }: Props) {
  const [modalOpen, setModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const displayName = getProviderDisplayName(provider);

  async function handleDelete() {
    if (!confirm(`Remove ${displayName} credentials? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await fetch('/api/credentials/delete', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ provider }),
      });
      onRefresh?.();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      className={cn(
        'flex items-center justify-between rounded-lg border p-3 transition-colors',
        connected
          ? 'border-border bg-card'
          : 'border-dashed border-border/60 bg-muted/20',
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={cn(
            'rounded-full p-1 flex-shrink-0',
            connected
              ? 'bg-emerald-100 dark:bg-emerald-900/40'
              : 'bg-muted',
          )}
        >
          {connected ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
          <p className="text-xs text-muted-foreground">
            {connected ? 'Credentials stored and encrypted' : 'Not connected'}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0 ml-3">
        {connected && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={handleDelete}
            disabled={deleting}
            title="Remove credentials"
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive transition-colors" />
          </Button>
        )}
        <Button
          variant={connected ? 'outline' : 'default'}
          size="sm"
          className="h-7 text-xs"
          onClick={() => setModalOpen(true)}
        >
          {connected ? (
            <>
              <RefreshCw className="mr-1 h-3 w-3" />
              Update
            </>
          ) : (
            'Connect'
          )}
        </Button>
      </div>

      <ConnectionModal
        open={modalOpen}
        provider={provider}
        displayName={displayName}
        accessToken={accessToken}
        onOpenChange={setModalOpen}
        onSuccess={() => {
          setModalOpen(false);
          onRefresh?.();
        }}
      />
    </div>
  );
}
