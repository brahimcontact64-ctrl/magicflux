'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bot, Brain, Building2, CheckCircle2, CircleAlert, ExternalLink, Loader2, PlugZap, Send } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type IntegrationUiState = 'not_connected' | 'validating' | 'connected' | 'failed';
type FieldDef = { key: string; label: string; placeholder: string; type?: 'text' | 'password' };
type CredentialSchemaField = { key: string; label: string; required: boolean };

type ProviderConfig = {
  key: string;
  name: string;
  logo: React.ReactNode;
  helpText: string;
  quickSetup: string[];
  docsUrl?: string;
  credentialSchema?: CredentialSchemaField[];
  helperActions?: Array<{ label: string; href?: string; action?: 'test_connection' }>;
};

function titleFromProvider(provider: string): string {
  return provider
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function fallbackProviderUiConfig(provider: string): ProviderConfig {
  return {
    key: provider,
    name: titleFromProvider(provider),
    logo: <PlugZap className="w-4 h-4" />,
    helpText: 'Connect credentials for this provider. MagicFlux will validate before saving.',
    quickSetup: ['Review required credentials below before connecting.'],
    helperActions: [{ label: 'Test connection', action: 'test_connection' }],
  };
}

const PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    key: 'openai',
    name: 'OpenAI',
    logo: <Brain className="w-4 h-4" />,
    helpText: 'Used for AI generation logic in your workflow.',
    quickSetup: ['Create an API key in OpenAI dashboard', 'Paste it below to connect'],
    docsUrl: 'https://platform.openai.com/api-keys',
    helperActions: [
      { label: 'Open OpenAI dashboard', href: 'https://platform.openai.com/api-keys' },
      { label: 'Test connection', action: 'test_connection' },
    ],
  },
  telegram: {
    key: 'telegram',
    name: 'Telegram',
    logo: <Send className="w-4 h-4" />,
    helpText: 'Used to send or receive Telegram messages.',
    quickSetup: ['Create bot via @BotFather', 'Copy Bot Token and target Chat ID'],
    docsUrl: 'https://core.telegram.org/bots#6-botfather',
    helperActions: [
      { label: 'Open Telegram bot setup', href: 'https://t.me/BotFather' },
      { label: 'Test connection', action: 'test_connection' },
    ],
  },
  coinmarketcap: {
    key: 'coinmarketcap',
    name: 'CoinMarketCap',
    logo: <Building2 className="w-4 h-4" />,
    helpText: 'Used for live crypto market pricing data.',
    quickSetup: ['Create API key in CoinMarketCap Developer Portal'],
    docsUrl: 'https://coinmarketcap.com/api/',
    helperActions: [{ label: 'Test connection', action: 'test_connection' }],
  },
  supabase: {
    key: 'supabase',
    name: 'Supabase',
    logo: <PlugZap className="w-4 h-4" />,
    helpText: 'Used for database and auth integration.',
    quickSetup: ['Supabase uses your project environment configuration.'],
    docsUrl: 'https://supabase.com/dashboard',
  },
  shopify: {
    key: 'shopify',
    name: 'Shopify',
    logo: <Building2 className="w-4 h-4" />,
    helpText: 'Used for ecommerce order and product automation.',
    quickSetup: ['Create a private app token in Shopify admin'],
    helperActions: [{ label: 'Test connection', action: 'test_connection' }],
  },
  slack: {
    key: 'slack',
    name: 'Slack',
    logo: <Send className="w-4 h-4" />,
    helpText: 'Used for team notifications and message routing.',
    quickSetup: ['Create an incoming webhook in Slack app settings'],
    helperActions: [{ label: 'Test connection', action: 'test_connection' }],
  },
  airtable: {
    key: 'airtable',
    name: 'Airtable',
    logo: <Building2 className="w-4 h-4" />,
    helpText: 'Used for records, CRM, and operational tracking.',
    quickSetup: ['Create Airtable personal access token and choose base/table'],
    helperActions: [{ label: 'Test connection', action: 'test_connection' }],
  },
  email: {
    key: 'email',
    name: 'Gmail / SMTP',
    logo: <Bot className="w-4 h-4" />,
    helpText: 'Used for email-based triggers and notifications.',
    quickSetup: ['Use SMTP details and an app password if Gmail is used'],
    helperActions: [{ label: 'Test connection', action: 'test_connection' }],
  },
};

const STATUS_LABEL: Record<IntegrationUiState, string> = {
  not_connected: 'Not connected',
  validating: 'Validating',
  connected: 'Connected',
  failed: 'Failed',
};

type IntegrationConnectModalProps = {
  open: boolean;
  sessionId: string;
  providers: string[];
  accessToken: string;
  onOpenChange: (open: boolean) => void;
  onConnected: (provider: string) => void;
};

export function IntegrationConnectModal({
  open,
  sessionId,
  providers,
  accessToken,
  onOpenChange,
  onConnected,
}: IntegrationConnectModalProps) {
  const [activeProvider, setActiveProvider] = useState<string>(providers[0] ?? '');
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [providerState, setProviderState] = useState<Record<string, { state: IntegrationUiState; message?: string }>>({});
  const [providerSchemas, setProviderSchemas] = useState<Record<string, CredentialSchemaField[]>>({});

  const supportedProviders = useMemo(
    () => Array.from(new Set(providers.map((provider) => provider.toLowerCase()).filter(Boolean))),
    [providers]
  );

  const currentProvider = supportedProviders.includes(activeProvider) ? activeProvider : (supportedProviders[0] ?? '');
  const currentConfig = PROVIDERS[currentProvider] ?? (currentProvider ? fallbackProviderUiConfig(currentProvider) : undefined);
  const currentFields: FieldDef[] = useMemo(() => {
    const schema = providerSchemas[currentProvider] ?? currentConfig?.credentialSchema ?? [];
    return schema.map((field) => ({
      key: field.key,
      label: field.label,
      placeholder: field.label,
      type: /(token|secret|password|key|credential)/i.test(field.key) ? 'password' : 'text',
    }));
  }, [currentConfig?.credentialSchema, currentProvider, providerSchemas]);

  useEffect(() => {
    if (!open || !accessToken) return;

    let cancelled = false;

    async function hydrateStates() {
      try {
        const [integrationsRes, conversationRes] = await Promise.all([
          fetch('/api/integrations', { headers: { Authorization: `Bearer ${accessToken}` } }).then((res) => res.json().catch(() => null)),
          fetch(`/api/conversation?sessionId=${encodeURIComponent(sessionId)}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          }).then((res) => res.json().catch(() => null)),
        ]);

        if (cancelled) return;

        const integrationStatuses = new Map<string, string>();
        (integrationsRes?.integrations ?? []).forEach((row: { provider: string; status: string }) => {
          integrationStatuses.set(String(row.provider).toLowerCase(), String(row.status));
        });

        const collected = (conversationRes?.state?.collectedCredentials ?? {}) as Record<string, unknown>;
        const graphNodes = Array.isArray(conversationRes?.workflowGraph?.nodes)
          ? (conversationRes.workflowGraph.nodes as Array<Record<string, unknown>>)
          : [];
        const nextSchemas: Record<string, CredentialSchemaField[]> = {};

        for (const node of graphNodes) {
          const rawProvider = typeof node.provider === 'string' ? node.provider.toLowerCase() : '';
          if (!rawProvider || !supportedProviders.includes(rawProvider)) continue;

          const schema = Array.isArray(node.credentialSchema)
            ? (node.credentialSchema as Array<Record<string, unknown>>)
                .map((field) => {
                  const key = String(field.key ?? '').trim().toLowerCase();
                  const label = String(field.label ?? '').trim();
                  if (!key || !label) return null;
                  return {
                    key,
                    label,
                    required: field.required !== false,
                  };
                })
                .filter((field): field is CredentialSchemaField => Boolean(field))
            : [];

          if (schema.length === 0) continue;

          if (!nextSchemas[rawProvider]) {
            nextSchemas[rawProvider] = [];
          }

          const existingKeys = new Set(nextSchemas[rawProvider].map((field) => field.key));
          for (const field of schema) {
            if (existingKeys.has(field.key)) continue;
            nextSchemas[rawProvider].push(field);
            existingKeys.add(field.key);
          }
        }

        const nextState: Record<string, { state: IntegrationUiState; message?: string }> = {};

        for (const provider of supportedProviders) {
          const integrationStatus = integrationStatuses.get(provider);
          const conversationConnected = collected[`${provider}_connected`] === 'true';

          if (integrationStatus === 'connected' || conversationConnected) {
            nextState[provider] = { state: 'connected', message: 'Connected successfully' };
          } else if (integrationStatus === 'invalid') {
            nextState[provider] = { state: 'failed', message: 'Invalid credentials detected' };
          } else {
            nextState[provider] = { state: 'not_connected' };
          }
        }

        setProviderSchemas(nextSchemas);
        setProviderState(nextState);
      } catch {
        // silent hydrate failure
      }
    }

    hydrateStates();
    return () => {
      cancelled = true;
    };
  }, [accessToken, open, sessionId, supportedProviders]);

  async function connectProvider(provider: string) {
    const config = PROVIDERS[provider] ?? fallbackProviderUiConfig(provider);
    if (!config || !accessToken) return;

    const schema = providerSchemas[provider] ?? config.credentialSchema ?? [];
    const fields: FieldDef[] = schema.map((field) => ({
      key: field.key,
      label: field.label,
      placeholder: field.label,
      type: /(token|secret|password|key|credential)/i.test(field.key) ? 'password' : 'text',
    }));

    if (schema.length === 0) {
      setProviderState((prev) => ({
        ...prev,
        [provider]: {
          state: 'failed',
          message: 'No credential requirements defined.',
        },
      }));
      return;
    }

    const providerValues = values[provider] ?? {};
    const requiredFieldKeys = new Set(
      schema.filter((field) => field.required).map((field) => field.key)
    );
    const missingField = fields.find(
      (field) => requiredFieldKeys.has(field.key) && !(providerValues[field.key] ?? '').trim()
    );
    if (missingField) {
      setProviderState((prev) => ({
        ...prev,
        [provider]: {
          state: 'failed',
          message: `${missingField.label} is required`,
        },
      }));
      return;
    }

    setProviderState((prev) => ({ ...prev, [provider]: { state: 'validating', message: 'Validating credentials...' } }));

    try {
      const credentials = fields.reduce<Record<string, string>>((acc, field) => {
        acc[field.key] = providerValues[field.key] ?? '';
        return acc;
      }, {});

      const verifyRes = await fetch('/api/integrations/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ provider, credentials }),
      });

      const verifyPayload = await verifyRes.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!verifyRes.ok || !verifyPayload?.success) {
        throw new Error(verifyPayload?.error ?? 'Invalid token');
      }

      const saveRes = await fetch('/api/integrations/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ provider, credentials }),
      });

      const savePayload = await saveRes.json().catch(() => null) as { success?: boolean; error?: string } | null;
      if (!saveRes.ok || !savePayload?.success) {
        throw new Error(savePayload?.error ?? 'Could not save integration');
      }

      setProviderState((prev) => ({ ...prev, [provider]: { state: 'connected', message: 'Connected successfully' } }));
      onConnected(provider);
    } catch (e) {
      setProviderState((prev) => ({
        ...prev,
        [provider]: { state: 'failed', message: e instanceof Error ? e.message : 'Connection failed' },
      }));
    }
  }

  function handleHelperAction(provider: string, action: 'test_connection') {
    void connectProvider(provider);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Connect integrations</DialogTitle>
          <DialogDescription>
            I can keep building while you connect anything that still needs access.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground">
          Builder mode is active. I will continue preparing the workflow while these connections finish.
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4 max-h-[65vh] overflow-hidden">
          <div className="rounded-lg border border-border p-2 space-y-1 overflow-auto">
            {supportedProviders.map((provider) => {
              const config = PROVIDERS[provider] ?? fallbackProviderUiConfig(provider);
              const status = providerState[provider]?.state ?? 'not_connected';
              return (
                <button
                  key={provider}
                  onClick={() => setActiveProvider(provider)}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-md text-sm transition-colors border',
                    provider === currentProvider
                      ? 'bg-primary/15 text-primary border-primary/30'
                      : 'hover:bg-muted/50 text-muted-foreground hover:text-foreground border-transparent'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2">
                      {config?.logo ?? <PlugZap className="w-4 h-4" />}
                      {config?.name ?? provider}
                    </span>
                    <span className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded border',
                      status === 'connected'
                        ? 'border-emerald-500/30 text-emerald-400'
                        : status === 'validating'
                          ? 'border-blue-500/30 text-blue-400'
                          : status === 'failed'
                            ? 'border-red-500/30 text-red-400'
                            : 'border-border text-muted-foreground'
                    )}>
                      {STATUS_LABEL[status]}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="rounded-lg border border-border p-4 space-y-4 overflow-auto">
            {currentConfig ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold flex items-center gap-2">
                      {currentConfig.logo}
                      {currentConfig.name}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">{currentConfig.helpText}</p>
                  </div>
                  {currentConfig.docsUrl && (
                    <a
                      href={currentConfig.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary inline-flex items-center gap-1"
                    >
                      Setup help <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>

                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Quick setup</p>
                  {currentConfig.quickSetup.map((tip) => (
                    <p key={tip} className="text-xs text-muted-foreground">• {tip}</p>
                  ))}
                </div>

                {currentFields.length > 0 ? (
                  <div className="space-y-3">
                    {currentFields.map((field) => (
                      <div key={field.key}>
                        <label className="block text-xs font-medium mb-1">{field.label}</label>
                        <input
                          value={values[currentProvider]?.[field.key] ?? ''}
                          type={field.type ?? 'text'}
                          onChange={(e) =>
                            setValues((prev) => ({
                              ...prev,
                              [currentProvider]: {
                                ...(prev[currentProvider] ?? {}),
                                [field.key]: e.target.value,
                              },
                            }))
                          }
                          placeholder={field.placeholder}
                          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    No credential requirements defined.
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() => connectProvider(currentProvider)}
                    disabled={providerState[currentProvider]?.state === 'validating'}
                  >
                    {providerState[currentProvider]?.state === 'validating' ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin mr-1" />
                        Validating
                      </>
                    ) : (
                      'Connect'
                    )}
                  </Button>

                  {currentConfig.helperActions?.map((helper) =>
                    helper.href ? (
                      <a
                        key={helper.label}
                        href={helper.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-muted/50 inline-flex items-center gap-1"
                      >
                        {helper.label}
                      </a>
                    ) : (
                      <button
                        key={helper.label}
                        onClick={() => helper.action && handleHelperAction(currentProvider, helper.action)}
                        className="text-xs px-2.5 py-1.5 rounded-md border border-border hover:bg-muted/50"
                      >
                        {helper.label}
                      </button>
                    )
                  )}
                </div>

                {providerState[currentProvider]?.message ? (
                  <div className={cn(
                    'text-xs rounded-md border px-3 py-2 flex items-center gap-1.5',
                    providerState[currentProvider]?.state === 'connected'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : providerState[currentProvider]?.state === 'failed'
                        ? 'border-red-500/30 bg-red-500/10 text-red-300'
                        : providerState[currentProvider]?.state === 'validating'
                          ? 'border-blue-500/30 bg-blue-500/10 text-blue-300'
                          : 'border-border text-muted-foreground'
                  )}>
                    {providerState[currentProvider]?.state === 'connected' ? <CheckCircle2 className="w-3.5 h-3.5" /> : null}
                    {providerState[currentProvider]?.state === 'failed' ? <CircleAlert className="w-3.5 h-3.5" /> : null}
                    {providerState[currentProvider]?.state === 'validating' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    <span>{providerState[currentProvider]?.message}</span>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="text-sm text-muted-foreground">No integrations required right now.</div>
            )}

            <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              The AI continues preparing your workflow in the background while optional connections are pending.
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
