'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Link2,
  XCircle,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ConnectionModal } from '@/components/integrations/ConnectionModal';
import {
  DEBOUNCE_MS,
  getConnectButtonLabel,
  getStatusConfig,
  shouldShowConnectButton,
} from '@/lib/credentials/automation-brain-utils';
import type { AutomationRequirementsResult, IntegrationRequirement, IntegrationStatus } from '@/lib/credentials/intelligence';

// ── Icon map ──────────────────────────────────────────────────────────────────

const STATUS_ICONS: Record<IntegrationStatus, React.ElementType> = {
  ready: CheckCircle2,
  missing: AlertTriangle,
  invalid: XCircle,
  oauth_required: Link2,
};

// ── Sub-components ────────────────────────────────────────────────────────────

function BrainSkeleton() {
  return (
    <div className="space-y-2 p-3" aria-label="Loading integrations…">
      <Skeleton className="h-3 w-32" />
      {[0, 1].map((i) => (
        <div key={i} className="rounded-lg border border-border p-3 space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-2.5 w-40" />
          <Skeleton className="h-2.5 w-28" />
        </div>
      ))}
    </div>
  );
}

function IntegrationRow({
  item,
  onConnect,
}: {
  item: IntegrationRequirement;
  onConnect: (provider: string) => void;
}) {
  const cfg = getStatusConfig(item.status);
  const Icon = STATUS_ICONS[item.status];
  const showButton = shouldShowConnectButton(item.status);

  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5 space-y-1.5',
        cfg.bgClass,
        cfg.borderClass
      )}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <p className={cn('flex items-center gap-1.5 text-xs font-semibold', cfg.colorClass)}>
          <Icon className="h-3.5 w-3.5 flex-shrink-0" />
          {item.displayName}
        </p>
        <span className={cn('text-[10px] font-medium', cfg.colorClass)}>
          {item.status === 'ready' ? '✓ Ready' : cfg.label}
        </span>
      </div>

      {/* Missing key list */}
      {item.missing.length > 0 && item.status !== 'ready' && (
        <div>
          <p className="text-[10px] text-muted-foreground font-medium mb-0.5">Missing:</p>
          <ul className="space-y-0.5">
            {item.missing.map((key) => (
              <li key={key} className="text-[10px] text-muted-foreground flex items-center gap-1">
                <span className="opacity-50">–</span>
                <span>{key}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Connect button */}
      {showButton && (
        <button
          onClick={() => onConnect(item.provider)}
          className={cn(
            'mt-0.5 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors',
            'hover:opacity-80',
            cfg.colorClass,
            cfg.borderClass
          )}
        >
          {getConnectButtonLabel(item.status)}
        </button>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export type AutomationBrainProps = {
  prompt: string;
  accessToken: string | null;
};

export function AutomationBrain({ prompt, accessToken }: AutomationBrainProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AutomationRequirementsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Incrementing this key triggers a background re-fetch without changing the prompt.
  const [refreshKey, setRefreshKey] = useState(0);

  // OAuth success banner: set to the provider name when returning from OAuth flow
  const [oauthSuccessProvider, setOauthSuccessProvider] = useState<string | null>(null);

  // Modal state
  const [modalProvider, setModalProvider] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // Detect returning from OAuth redirect: show success banner + trigger re-fetch
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth') !== 'success') return;

    const oauthProvider = params.get('provider') ?? 'Unknown provider';
    setOauthSuccessProvider(oauthProvider);
    setRefreshKey((v) => v + 1);

    // Remove ?oauth=success&provider=... from the URL without a page reload
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);
  }, []);

  useEffect(() => {
    const trimmed = prompt.trim();

    if (!trimmed) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }

    const timer = setTimeout(async () => {
      // Cancel any in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      try {
        const res = await fetch('/api/integrations/intelligence', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({ prompt: trimmed }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          setError(err.error ?? 'Failed to analyze integrations');
          setResult(null);
        } else {
          const data = (await res.json()) as AutomationRequirementsResult;
          setResult(data);
          setError(null);
        }
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return;
        setError('Could not reach the intelligence service');
        setResult(null);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [prompt, accessToken, refreshKey]);

  function openConnect(provider: string) {
    setModalProvider(provider);
    setModalOpen(true);
  }

  function handleConnectSuccess(provider: string) {
    // Optimistically mark the provider ready while the debounce re-fetches
    setResult((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        integrations: prev.integrations.map((i) =>
          i.provider === provider
            ? { ...i, connected: true, missing: [], status: 'ready' as IntegrationStatus }
            : i
        ),
        allReady: prev.integrations.every((i) =>
          i.provider === provider ? true : i.status === 'ready'
        ),
        blockers: prev.blockers.filter((p) => p !== provider),
      };
    });

    // Trigger a real background re-fetch to sync server-side verification state.
    setTimeout(() => {
      setRefreshKey((v) => v + 1);
    }, 500);
  }

  // Nothing to show when prompt is blank
  if (!prompt.trim() && !loading && !result) return null;

  const activeItem = result?.integrations.find((i) => i.provider === modalProvider) ?? null;

  return (
    <>
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Brain className="h-3.5 w-3.5 text-primary flex-shrink-0" />
          <span className="text-xs font-semibold text-foreground">Automation Brain</span>
          {result && !loading && (
            <span className="ml-auto text-[10px] text-muted-foreground">
              {result.allReady ? 'All ready' : `${result.blockers.length} pending`}
            </span>
          )}
        </div>

        {/* OAuth success banner */}
        {oauthSuccessProvider && (
          <div className="flex items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
            <span className="flex-1 text-[11px] text-emerald-700 dark:text-emerald-300 font-medium">
              {oauthSuccessProvider} connected
            </span>
            <button
              onClick={() => setOauthSuccessProvider(null)}
              className="text-[10px] text-emerald-600 dark:text-emerald-400 hover:opacity-70"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        {/* Body */}
        {loading ? (
          <BrainSkeleton />
        ) : error ? (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">{error}</p>
        ) : result ? (
          <div className="p-3">
            {result.integrations.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No integrations detected in this prompt.
              </p>
            ) : (
              <>
                <p className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wide font-medium">
                  Detected integrations
                </p>
                <div className="space-y-2">
                  {result.integrations.map((item) => (
                    <IntegrationRow
                      key={item.provider}
                      item={item}
                      onConnect={openConnect}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>

      {/* Connection modal */}
      {activeItem && (
        <ConnectionModal
          open={modalOpen}
          provider={activeItem.provider}
          displayName={activeItem.displayName}
          accessToken={accessToken}
          onOpenChange={(open) => {
            setModalOpen(open);
            if (!open) setModalProvider(null);
          }}
          onSuccess={handleConnectSuccess}
        />
      )}
    </>
  );
}
