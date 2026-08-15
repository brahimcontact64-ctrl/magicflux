'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { CredentialCard } from './CredentialCard';
import { getAllNodeDefs } from '@/lib/node-registry';
import { supabase } from '@/lib/supabase-client';
import { getProviderDisplayName } from '@/lib/credentials/provider-registry';
import type { NodeDef } from '@/lib/node-registry';

type StatusFilter = 'all' | 'connected' | 'missing';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRequiredProviders(): string[] {
  const providers = new Set<string>();
  for (const def of getAllNodeDefs()) {
    const p = (def as NodeDef & { credentialProvider?: string }).credentialProvider;
    if (p) providers.add(p);
  }
  return [...providers].sort();
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProviderStatus {
  provider: string;
  connected: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CredentialsPage() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const providers = getRequiredProviders();

  // Resolve Supabase access token once on mount
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null);
    });
  }, []);

  const loadStatuses = useCallback(async () => {
    setLoading(true);
    try {
      const results = await Promise.all(
        providers.map(async (provider): Promise<ProviderStatus> => {
          try {
            const headers: HeadersInit = accessToken
              ? { Authorization: `Bearer ${accessToken}` }
              : {};
            const res = await fetch(
              `/api/credentials/status?provider=${encodeURIComponent(provider)}`,
              { headers },
            );
            if (!res.ok) return { provider, connected: false };
            const data = (await res.json()) as { connected: boolean };
            return { provider, connected: data.connected };
          } catch {
            return { provider, connected: false };
          }
        }),
      );
      setStatuses(results);
    } finally {
      setLoading(false);
    }
  }, [providers.join(','), accessToken]);

  useEffect(() => {
    loadStatuses();
  }, [loadStatuses]);

  const connectedCount = statuses.filter((s) => s.connected).length;

  const visibleStatuses = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return statuses.filter((s) => {
      if (statusFilter === 'connected' && !s.connected) return false;
      if (statusFilter === 'missing' && s.connected) return false;
      if (!query) return true;
      return (
        s.provider.toLowerCase().includes(query) ||
        getProviderDisplayName(s.provider).toLowerCase().includes(query)
      );
    });
  }, [statuses, searchQuery, statusFilter]);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-3xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-violet-50 p-2 dark:bg-violet-950/40">
            <KeyRound className="h-5 w-5 text-violet-600 dark:text-violet-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Credentials</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {loading
                ? 'Checking connections…'
                : `${connectedCount} of ${providers.length} services connected`}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={loadStatuses}
          disabled={loading}
        >
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Search + filter */}
      {providers.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search credentials…"
              className="pl-8 h-9"
            />
          </div>
          <div className="flex gap-1">
            {(['all', 'connected', 'missing'] as const).map((filter) => (
              <Button
                key={filter}
                type="button"
                variant={statusFilter === filter ? 'default' : 'outline'}
                size="sm"
                onClick={() => setStatusFilter(filter)}
                className="capitalize"
              >
                {filter}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Cards */}
      <div className="space-y-2">
        {providers.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No credential-requiring integrations found.
          </p>
        ) : loading ? (
          Array.from({ length: providers.length }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-muted/30 animate-pulse" />
          ))
        ) : visibleStatuses.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No credentials match your search.
          </p>
        ) : (
          visibleStatuses.map((s) => (
            <CredentialCard
              key={s.provider}
              provider={s.provider}
              connected={s.connected}
              accessToken={accessToken}
              onRefresh={loadStatuses}
            />
          ))
        )}
      </div>
    </div>
  );
}
