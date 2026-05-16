'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, PlugZap, Store, MessageSquare, Database, Trash2, Pencil, Mail } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { supabase } from '@/lib/supabase-client';
import { UsageSummaryWidget } from '@/components/billing/usage-summary';
import { IntegrationStatusBadge } from '@/components/app/integration-status-badge';
import { apiRequest } from '@/lib/api/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type IntegrationRow = {
  provider: string;
  status: 'connected' | 'invalid' | 'not_connected';
  last_verified_at: string | null;
  masked_info?: string;
  created_at: string | null;
};

type UsageSummary = {
  connected_integrations: number;
  integrations_limit: number;
};

type ProviderConfig = {
  id: string;
  title: string;
  icon: React.ElementType;
  fields: Array<{ key: string; label: string; type: string; placeholder: string }>;
};

type CatalogProvider = {
  provider: string;
  category?: string;
  requiredCredentials?: Array<{
    key: string;
    label: string;
    secret: boolean;
    placeholder?: string;
  }>;
};

const PROVIDERS: ProviderConfig[] = [
  {
    id: 'shopify',
    title: 'Shopify',
    icon: Store,
    fields: [
      { key: 'SHOP_DOMAIN', label: 'SHOP_DOMAIN', type: 'text', placeholder: 'my-store.myshopify.com' },
      { key: 'ADMIN_ACCESS_TOKEN', label: 'ADMIN_ACCESS_TOKEN', type: 'password', placeholder: 'shpat_xxx...' },
    ],
  },
  {
    id: 'slack',
    title: 'Slack',
    icon: MessageSquare,
    fields: [
      { key: 'WEBHOOK_URL', label: 'WEBHOOK_URL', type: 'password', placeholder: 'https://hooks.slack.com/services/...' },
    ],
  },
  {
    id: 'airtable',
    title: 'Airtable',
    icon: Database,
    fields: [
      { key: 'AIRTABLE_TOKEN', label: 'AIRTABLE_TOKEN', type: 'password', placeholder: 'patXXXXXXXX...' },
      { key: 'BASE_ID', label: 'BASE_ID', type: 'text', placeholder: 'appXXXXXXXX...' },
      { key: 'TABLE_NAME', label: 'TABLE_NAME', type: 'text', placeholder: 'Leads' },
    ],
  },
  {
    id: 'email',
    title: 'Email (SMTP)',
    icon: Mail,
    fields: [
      { key: 'SMTP_HOST', label: 'SMTP_HOST', type: 'text', placeholder: 'smtp.gmail.com' },
      { key: 'SMTP_PORT', label: 'SMTP_PORT', type: 'text', placeholder: '587' },
      { key: 'SMTP_USER', label: 'SMTP_USER', type: 'text', placeholder: 'you@example.com' },
      { key: 'SMTP_PASS', label: 'SMTP_PASS', type: 'password', placeholder: '••••••••••••' },
      { key: 'FROM_EMAIL', label: 'FROM_EMAIL', type: 'text', placeholder: 'you@example.com' },
    ],
  },
];

export default function IntegrationsSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [rows, setRows] = useState<IntegrationRow[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [catalogProviders, setCatalogProviders] = useState<CatalogProvider[]>([]);

  const categoryIcon = useCallback((category?: string): React.ElementType => {
    if (category === 'database') return Database;
    if (category === 'messaging') return MessageSquare;
    if (category === 'payments') return Store;
    if (category === 'llm') return PlugZap;
    return PlugZap;
  }, []);

  const titleFromProvider = useCallback((provider: string): string => {
    return provider
      .split(/[_-]/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }, []);

  const getAuthHeaders = useCallback(async (): Promise<HeadersInit | null> => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      toast.error('Session expired. Please login again.');
      return null;
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }, []);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const headers = await getAuthHeaders();
      if (!headers) return;

      const payload = await apiRequest<{ integrations?: IntegrationRow[] }>(
        '/api/integrations',
        { headers, cache: 'no-store' },
        'Failed to load integrations'
      );
      setRows(payload?.integrations ?? []);

      const catalogPayload = await apiRequest<{ providers?: CatalogProvider[] }>(
        '/api/integrations/catalog',
        { headers, cache: 'no-store' },
        'Failed to load provider catalog'
      );
      setCatalogProviders(catalogPayload?.providers ?? []);

      const usageRes = await fetch('/api/billing/usage', { headers, cache: 'no-store' });
      if (usageRes.ok) {
        const usagePayload = await usageRes.json().catch(() => null) as UsageSummary | null;
        if (usagePayload) setUsage(usagePayload);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load integrations');
    } finally {
      setLoading(false);
    }
  }, [getAuthHeaders]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const providerConfigs = useMemo<ProviderConfig[]>(() => {
    if (catalogProviders.length === 0) return PROVIDERS;

    return catalogProviders.map((provider) => ({
      id: provider.provider,
      title: titleFromProvider(provider.provider),
      icon: categoryIcon(provider.category),
      fields: (provider.requiredCredentials ?? []).map((field) => ({
        key: field.key,
        label: field.label,
        type: field.secret ? 'password' : 'text',
        placeholder: field.placeholder ?? '',
      })),
    }));
  }, [catalogProviders, categoryIcon, titleFromProvider]);

  const byProvider = useMemo(() => {
    const map = new Map<string, IntegrationRow>();
    for (const row of rows) map.set(row.provider, row);
    return map;
  }, [rows]);

  const planLimitReached = useMemo(() => {
    if (!usage) return false;
    if (usage.integrations_limit === -1) return false;
    return usage.connected_integrations >= usage.integrations_limit;
  }, [usage]);

  const activeProviderConfig = useMemo(() => {
    if (!editing) return null;
    return providerConfigs.find((p) => p.id === editing) ?? null;
  }, [editing, providerConfigs]);

  const formatLastVerified = (iso: string | null) => {
    if (!iso) return 'Never verified';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return 'Never verified';
    const mins = Math.floor((Date.now() - then) / 60_000);
    if (mins < 1) return 'Last verified: just now';
    if (mins < 60) return `Last verified: ${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.floor(mins / 60);
    return `Last verified: ${hours} hour${hours === 1 ? '' : 's'} ago`;
  };

  const startEdit = (provider: string) => {
    setEditing(provider);
    setFormValues({});
    setIsModalOpen(true);
  };

  const saveProvider = async (provider: string) => {
    setSaving(provider);
    try {
      const headers = await getAuthHeaders();
      if (!headers) return;

      await apiRequest<{ success?: boolean }>(
        '/api/integrations/save',
        {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider, credentials: formValues }),
        },
        'Failed to save integration'
      );

      toast.success('Integration saved and verified');
      setEditing(null);
      setFormValues({});
      setIsModalOpen(false);
      await fetchRows();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save integration');
    } finally {
      setSaving(null);
    }
  };

  const verifyProvider = async (provider: string) => {
    setVerifying(provider);
    try {
      const headers = await getAuthHeaders();
      if (!headers) return;
      const payload = await apiRequest<{ success?: boolean; error?: string }>(
        '/api/integrations/verify',
        {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider, credentials: formValues }),
        },
        'Verification failed'
      );
      if (!payload?.success) throw new Error(payload?.error ?? 'Verification failed');
      toast.success('Verification successful');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Verification failed');
    } finally {
      setVerifying(null);
    }
  };

  const runTestAction = async (provider: string) => {
    setActing(provider);
    try {
      const headers = await getAuthHeaders();
      if (!headers) return;

      let action = 'verify_shop';
      const body: Record<string, unknown> = { provider };
      if (provider === 'email') {
        const destinationEmail = window.prompt('Destination email for test message:');
        if (!destinationEmail) return;
        action = 'send_test_email';
        body.destinationEmail = destinationEmail;
      }
      if (provider === 'slack') action = 'send_test_message';
      if (provider === 'airtable') action = 'create_test_record';

      body.action = action;

      const payload = await apiRequest<{ success?: boolean; error?: string }>(
        '/api/integrations/test-action',
        {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        },
        'Action failed'
      );
      if (!payload?.success) throw new Error(payload?.error ?? 'Action failed');
      toast.success('Test action completed');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Test action failed');
    } finally {
      setActing(null);
    }
  };

  const disconnectProvider = async (provider: string) => {
    setDisconnecting(provider);
    try {
      const headers = await getAuthHeaders();
      if (!headers) return;

      await apiRequest<{ success?: boolean }>(
        `/api/integrations?provider=${provider}`,
        {
        method: 'DELETE',
        headers,
        },
        'Failed to disconnect integration'
      );

      toast.success(`${provider} disconnected`);
      if (editing === provider) {
        setEditing(null);
        setFormValues({});
        setIsModalOpen(false);
      }
      await fetchRows();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to disconnect integration');
    } finally {
      setDisconnecting(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="h-14 border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10 flex items-center px-6 gap-4">
        <Link href="/" className="flex items-center gap-2 group">
          <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center group-hover:scale-105 transition-transform">
            <PlugZap className="w-3.5 h-3.5 text-primary-foreground" />
          </div>
          <span className="font-semibold text-sm">MagicFlux</span>
        </Link>
        <div className="w-px h-4 bg-border" />
        <span className="text-xs text-muted-foreground">Settings / Integrations</span>
        <div className="flex-1" />
        <ThemeToggle />
        <Link href="/dashboard">
          <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </Button>
        </Link>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-bold">Integrations</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Connect real provider credentials so generated workflows can execute in production.
          </p>
        </div>

        <div className="mb-6 rounded-xl border border-border bg-card p-4">
          <UsageSummaryWidget />
        </div>

        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-56 rounded-xl border border-border bg-card animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {providerConfigs.map(cfg => {
              const row = byProvider.get(cfg.id);
              const status = row?.status ?? 'not_connected';
              const Icon = cfg.icon;
              const canCreateNew = status !== 'not_connected' || !planLimitReached;

              return (
                <div key={cfg.id} className="rounded-xl border border-border bg-card p-4 space-y-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-md bg-primary/15 border border-primary/25 flex items-center justify-center">
                        <Icon className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold">{cfg.title}</p>
                        <div className="mt-1">
                          <IntegrationStatusBadge status={status} />
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{formatLastVerified(row?.last_verified_at ?? null)}</p>
                        {row?.masked_info && <p className="text-[11px] text-muted-foreground">{row.masked_info}</p>}
                        {!canCreateNew && (
                          <p className="text-[11px] text-amber-300 mt-1">Integration limit reached on current plan.</p>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="h-8 gap-1.5"
                      onClick={() => startEdit(cfg.id)}
                      disabled={saving === cfg.id || disconnecting === cfg.id || acting === cfg.id || verifying === cfg.id || !canCreateNew}
                    >
                      {saving === cfg.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5" />}
                      {status === 'not_connected' ? 'Connect' : 'Edit credentials'}
                    </Button>

                    {status !== 'not_connected' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        onClick={() => runTestAction(cfg.id)}
                        disabled={acting === cfg.id || saving === cfg.id || disconnecting === cfg.id}
                      >
                        {acting === cfg.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Test Action'}
                      </Button>
                    )}

                    {editing === cfg.id && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        onClick={() => verifyProvider(cfg.id)}
                        disabled={verifying === cfg.id || saving === cfg.id}
                      >
                        {verifying === cfg.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Verify'}
                      </Button>
                    )}

                    {status !== 'not_connected' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5"
                        onClick={() => disconnectProvider(cfg.id)}
                        disabled={disconnecting === cfg.id || saving === cfg.id}
                      >
                        {disconnecting === cfg.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        Disconnect
                      </Button>
                    )}
                  </div>

                  {!canCreateNew && (
                    <Link href="/pricing" className="text-xs text-primary hover:underline">
                      Upgrade plan to add more integrations
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {activeProviderConfig ? `Connect ${activeProviderConfig.title}` : 'Connect Integration'}
              </DialogTitle>
              <DialogDescription>
                Enter credentials. MagicFlux will run a real verification request before saving.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              {(activeProviderConfig?.fields ?? []).map((field) => (
                <div key={field.key} className="space-y-1">
                  <label className="text-xs text-muted-foreground">{field.label}</label>
                  <input
                    type={field.type}
                    placeholder={field.placeholder}
                    value={formValues[field.key] ?? ''}
                    onChange={(e) => setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs focus:outline-none focus:border-primary"
                  />
                </div>
              ))}
            </div>

            <DialogFooter>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setIsModalOpen(false);
                  setEditing(null);
                  setFormValues({});
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => editing && saveProvider(editing)}
                disabled={!editing || saving === editing}
              >
                {editing && saving === editing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                Verify & Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}
