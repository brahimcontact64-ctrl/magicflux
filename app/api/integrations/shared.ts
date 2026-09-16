import { NextRequest, NextResponse } from 'next/server';

import {
  createServiceClient,
  getBearerToken,
  getUserFromAccessToken,
} from '@/lib/supabase-server';
import { decryptJson, encryptJson, CredentialDecryptionError } from '@/lib/security/encryption';
import { classifyError } from '@/lib/security/safe-error';
import { verifyIntegrationCredentials, runIntegrationTestAction } from '@/lib/integration-verifier';
import { normalizeCredentials, validateRequiredCredentials, maskIntegrationInfo } from '@/lib/integration-credentials';
import { getIntegrationUsage, getPlanLimits } from '@/lib/billing/plan-limits';
import { getAllConnectedProviders, getVerificationStatus, deleteProviderCredentials } from '@/lib/credentials/storage';
import { reasonProvider } from '@/lib/dynamic-providers/provider-reasoning-engine';
import { generateProviderAdapter } from '@/lib/dynamic-providers/provider-adapter-generator';
import { validateProviderAdapter } from '@/lib/dynamic-providers/generic-validation-engine';
import { executeWithProviderAdapter } from '@/lib/dynamic-providers/generic-provider-runtime';
import { listProviderMemory } from '@/lib/dynamic-providers/provider-memory-store';
import type { DynamicIntegrationCardModel, ProviderCategory } from '@/lib/dynamic-providers/types';

type LegacyProvider = 'shopify' | 'slack' | 'airtable' | 'email';
type IntegrationStatus = 'connected' | 'invalid' | 'not_connected';

function isLegacyProvider(value: string): value is LegacyProvider {
  return value === 'shopify' || value === 'slack' || value === 'airtable' || value === 'email';
}

/**
 * Phase 9.9.7B -- providers whose connection UX on this page (and in the
 * Builder's connect modal) must always be the real Google OAuth redirect
 * (/api/oauth/start -> Google consent -> /api/oauth/callback), never the
 * generic manual-credential form. Deliberately scoped to 'gmail' only for
 * this phase, matching the one OAuth connection actually surfaced in this
 * UI today -- the mechanism below (canonical catalog card + authoritative
 * status override + rejecting the manual path) generalizes to any other
 * lib/credentials/oauth-providers.ts entry the moment it gets its own UI
 * surface, without further changes here.
 *
 * Root cause this guards against: legacy provider-agnostic code in this
 * file (verifyDynamicIntegration/reasonProvider) treats any provider not in
 * isLegacyProvider() as a generic API-driven integration and, on first
 * encounter, memoizes an AI-inferred credential shape (typically a bare
 * API_KEY field) into provider_intelligence for that provider key. Gmail's
 * real credential is a Google OAuth grant stored in integration_credentials,
 * not an API key in user_integrations/provider_intelligence -- so a stale
 * memoized 'gmail' entry must never be allowed to define this provider's
 * catalog fields or connection/status logic again.
 */
function isCanonicalOAuthUiProvider(provider: string): boolean {
  return provider === 'gmail';
}

function canonicalOAuthCatalogCard(provider: string): DynamicIntegrationCardModel {
  return {
    provider,
    category: 'messaging',
    capabilities: ['notifications', 'messaging'],
    // No credential fields, ever -- the client renders "Continue with
    // Google" instead of a form whenever authStrategy.type === 'oauth2'.
    requiredCredentials: [],
    docsUrl: 'https://support.google.com/accounts/answer/3466521',
    logo: null,
    authStrategy: { type: 'oauth2' },
    validationStrategy: 'sample_execution',
    endpointHints: [],
  };
}

function normalizeProvider(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9._-]/g, '');
}

function normalizeGenericCredentials(raw: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) normalized[key.toLowerCase()] = trimmed;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      normalized[key.toLowerCase()] = String(value);
    }
  }
  return normalized;
}

function maskGenericIntegrationInfo(creds: Record<string, string>): string {
  const priorityKeys = ['api_key', 'token', 'key', 'username', 'email', 'base_url'];
  for (const key of priorityKeys) {
    const value = creds[key];
    if (!value) continue;
    if (value.length <= 8) return `${key}: ***`;
    return `${key}: ${value.slice(0, 3)}***${value.slice(-3)}`;
  }
  const first = Object.entries(creds)[0];
  if (!first) return '-';
  return `${first[0]} configured`;
}

function staticCatalogCards(): DynamicIntegrationCardModel[] {
  return [
    {
      provider: 'shopify',
      category: 'automation',
      capabilities: ['payments', 'analytics'],
      requiredCredentials: [
        { key: 'SHOP_DOMAIN', label: 'SHOP_DOMAIN', secret: false, placeholder: 'my-store.myshopify.com' },
        { key: 'ADMIN_ACCESS_TOKEN', label: 'ADMIN_ACCESS_TOKEN', secret: true, placeholder: 'shpat_xxx...' },
      ],
      docsUrl: 'https://shopify.dev/docs/api/admin-rest',
      authStrategy: { type: 'custom_header', headerName: 'X-Shopify-Access-Token' },
      validationStrategy: 'ping_endpoint',
      endpointHints: ['/admin/api/2025-01/shop.json'],
    },
    {
      provider: 'slack',
      category: 'messaging',
      capabilities: ['notifications', 'messaging'],
      requiredCredentials: [
        { key: 'WEBHOOK_URL', label: 'WEBHOOK_URL', secret: true, placeholder: 'https://hooks.slack.com/services/...' },
      ],
      docsUrl: 'https://api.slack.com/messaging/webhooks',
      authStrategy: { type: 'query_key' },
      validationStrategy: 'sample_execution',
      endpointHints: ['/services/...'],
    },
    {
      provider: 'airtable',
      category: 'database',
      capabilities: ['database'],
      requiredCredentials: [
        { key: 'AIRTABLE_TOKEN', label: 'AIRTABLE_TOKEN', secret: true, placeholder: 'patXXXXXXXX...' },
        { key: 'BASE_ID', label: 'BASE_ID', secret: false, placeholder: 'appXXXXXXXX...' },
        { key: 'TABLE_NAME', label: 'TABLE_NAME', secret: false, placeholder: 'Leads' },
      ],
      docsUrl: 'https://airtable.com/developers/web/api/introduction',
      authStrategy: { type: 'bearer_token', headerName: 'Authorization', tokenPrefix: 'Bearer ' },
      validationStrategy: 'list_resources',
      endpointHints: ['/v0/{baseId}/{tableName}'],
    },
    {
      provider: 'email',
      category: 'messaging',
      capabilities: ['notifications', 'messaging'],
      requiredCredentials: [
        { key: 'SMTP_HOST', label: 'SMTP_HOST', secret: false, placeholder: 'smtp.gmail.com' },
        { key: 'SMTP_PORT', label: 'SMTP_PORT', secret: false, placeholder: '587' },
        { key: 'SMTP_USER', label: 'SMTP_USER', secret: false, placeholder: 'you@example.com' },
        { key: 'SMTP_PASS', label: 'SMTP_PASS', secret: true, placeholder: '••••••••••••' },
        { key: 'FROM_EMAIL', label: 'FROM_EMAIL', secret: false, placeholder: 'you@example.com' },
      ],
      docsUrl: 'https://nodemailer.com/smtp/',
      authStrategy: { type: 'basic_auth', usernameField: 'smtp_user', passwordField: 'smtp_pass' },
      validationStrategy: 'sample_execution',
      endpointHints: [],
    },
  ];
}

function categoryFromProvider(provider: string): ProviderCategory {
  if (provider.includes('openai') || provider.includes('anthropic') || provider.includes('llm')) return 'llm';
  if (provider.includes('slack') || provider.includes('telegram') || provider.includes('discord')) return 'messaging';
  if (provider.includes('airtable') || provider.includes('supabase') || provider.includes('postgres')) return 'database';
  if (provider.includes('stripe') || provider.includes('paypal')) return 'payments';
  return 'other';
}

function resolveDynamicBaseUrl(provider: string, credentials: Record<string, string>): string {
  const fromCreds = credentials.base_url ?? credentials.api_base ?? credentials.endpoint ?? credentials.url;
  if (fromCreds && /^https?:\/\//i.test(fromCreds)) {
    return fromCreds;
  }
  return `https://api.${provider}.com`;
}

async function verifyDynamicIntegration(params: {
  userId: string;
  provider: string;
  credentials: Record<string, string>;
}): Promise<{ ok: boolean; error?: string }> {
  const reasoning = await reasonProvider({
    providerHint: params.provider,
    contextText: Object.keys(params.credentials).join(' '),
    userId: params.userId,
  });

  for (const required of reasoning.likelyCredentials) {
    const hasCredential = Boolean(params.credentials[required.toLowerCase()] ?? params.credentials[required]);
    if (!hasCredential) {
      return { ok: false, error: `Missing required credential: ${required}` };
    }
  }

  const adapter = generateProviderAdapter(reasoning);
  const baseUrl = resolveDynamicBaseUrl(params.provider, params.credentials);
  const report = await validateProviderAdapter({
    adapter,
    baseUrl,
    credentials: params.credentials,
  });

  if (!report.ok) {
    return { ok: false, error: report.error ?? 'Dynamic validation failed' };
  }

  return { ok: true };
}

async function requireUser(req: NextRequest): Promise<{ id: string } | null> {
  const token = getBearerToken(req);
  if (!token) return null;
  const user = await getUserFromAccessToken(token);
  if (!user) return null;
  return { id: user.id };
}

export async function listIntegrations(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = createServiceClient();
  const { data, error } = await db
    .from('user_integrations')
    .select('provider, credentials, status, last_verified_at, created_at')
    .eq('user_id', auth.id)
    .order('created_at', { ascending: false });

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  const byProvider = new Map<string, {
    provider: string;
    status: IntegrationStatus;
    last_verified_at: string | null;
    masked_info: string;
    created_at: string | null;
  }>();

  (data ?? []).forEach((row) => {
    const provider = normalizeProvider(String(row.provider ?? ''));
    if (!provider) return;

    // Phase 9.9.5C -- a decrypt failure on ONE integration must not break
    // this whole list for every OTHER connected provider. Reclassified as
    // 'invalid' (same status a credential failing re-verification already
    // gets) with a safe, non-secret placeholder -- never the ciphertext.
    let status = (row.status ?? 'not_connected') as IntegrationStatus;
    let masked: string;
    try {
      const decrypted = decryptJson((row.credentials ?? {}) as Record<string, unknown>);
      const normalized = normalizeGenericCredentials(decrypted);
      masked = isLegacyProvider(provider)
        ? maskIntegrationInfo(provider, normalized)
        : maskGenericIntegrationInfo(normalized);
    } catch (err) {
      if (!(err instanceof CredentialDecryptionError)) throw err;
      status = 'invalid' as IntegrationStatus;
      masked = 'Unable to decrypt this credential — please reconnect.';
    }

    byProvider.set(provider, {
      provider,
      status,
      last_verified_at: (row.last_verified_at as string | null | undefined) ?? null,
      masked_info: masked,
      created_at: (row.created_at as string | null | undefined) ?? null,
    });
  });

  const staticProviders: LegacyProvider[] = ['shopify', 'slack', 'airtable', 'email'];
  for (const provider of staticProviders) {
    if (!byProvider.has(provider)) {
      byProvider.set(provider, {
        provider,
        status: 'not_connected',
        last_verified_at: null,
        masked_info: '-',
        created_at: null,
      });
    }
  }

  // Phase 9.9.7B -- Gmail's status on this page must reflect ONLY a real
  // Google OAuth grant in integration_credentials, never a legacy
  // user_integrations row -- including one under the 'email' identifier.
  // lib/integrations.ts's PROVIDER_STORAGE_ALIAS_GROUPS deliberately treats
  // 'gmail' and 'email' as interchangeable for WORKFLOW EXECUTION (either
  // satisfies an email-sending node's credential requirement), which is why
  // verifyProviderConnection('gmail') intentionally falls back to a
  // connected legacy 'email' row. That equivalence is correct for runtime
  // resolution but wrong here: requirement is that Gmail (OAuth) and Email
  // (SMTP) remain two visibly separate, independently-statused cards, so
  // connecting SMTP alone must never make the Gmail card show "Connected".
  // getAllConnectedProviders() queries integration_credentials directly,
  // with no legacy-table fallback, so it is the correct authoritative
  // signal for this specific display purpose.
  const oauthConnectedProviders = await getAllConnectedProviders(auth.id).catch(() => [] as string[]);
  const gmailOAuthConnected = oauthConnectedProviders.includes('gmail');
  const gmailVerification = gmailOAuthConnected ? await getVerificationStatus(auth.id, 'gmail').catch(() => null) : null;
  byProvider.set('gmail', {
    provider: 'gmail',
    status: gmailOAuthConnected ? 'connected' : 'not_connected',
    last_verified_at: gmailOAuthConnected ? gmailVerification?.verifiedAt ?? null : null,
    masked_info: gmailOAuthConnected ? 'Connected via Google OAuth' : '-',
    created_at: null,
  });

  const pinnedProviders: string[] = [...staticProviders, 'gmail'];
  const integrations = Array.from(byProvider.values()).sort((left, right) => {
    if (left.provider === right.provider) return 0;
    if (pinnedProviders.includes(left.provider) && !pinnedProviders.includes(right.provider)) return -1;
    if (!pinnedProviders.includes(left.provider) && pinnedProviders.includes(right.provider)) return 1;
    return left.provider.localeCompare(right.provider);
  });

  return NextResponse.json({ success: true, integrations });
}

export async function saveIntegration(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    provider?: string;
    credentials?: Record<string, unknown>;
  };

  const provider = normalizeProvider(String(body.provider ?? ''));
  if (!provider) return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });

  // Phase 9.9.7B -- this generic manual-credential path must never be able
  // to create/overwrite a 'gmail' row, defense-in-depth behind the UI no
  // longer offering the form: a direct API call must fail closed the same
  // way, rather than silently accepting a pasted API key as if it were a
  // real Gmail connection.
  if (isCanonicalOAuthUiProvider(provider)) {
    return NextResponse.json(
      { error: 'GMAIL_REQUIRES_OAUTH', message: 'Gmail must be connected via Google sign-in. Use /api/oauth/start.' },
      { status: 400 }
    );
  }

  const normalized = isLegacyProvider(provider)
    ? normalizeCredentials(provider, body.credentials ?? {})
    : normalizeGenericCredentials(body.credentials ?? {});

  if (isLegacyProvider(provider)) {
    const validationError = validateRequiredCredentials(provider, normalized);
    if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
  }

  // Check if this is a NEW integration (not updating existing)
  const db = createServiceClient();
  const { data: existingIntegration } = await db
    .from('user_integrations')
    .select('id, status')
    .eq('user_id', auth.id)
    .eq('provider', provider)
    .maybeSingle();

  // Only check plan limits if this is a NEW integration
  if (!existingIntegration) {
    const plan = await getPlanLimits(auth.id);
    const currentUsage = await getIntegrationUsage(auth.id);

    if (plan.integrations_limit !== -1 && currentUsage >= plan.integrations_limit) {
      return NextResponse.json({
        error: 'PLAN_LIMIT_REACHED',
        message: `Your ${plan.name} plan allows only ${plan.integrations_limit} integration${plan.integrations_limit !== 1 ? 's' : ''}.`,
        redirect: '/pricing',
      }, { status: 429 });
    }
  }

  const verification = isLegacyProvider(provider)
    ? await verifyIntegrationCredentials(provider, normalized)
    : await verifyDynamicIntegration({
        userId: auth.id,
        provider,
        credentials: normalized,
      });
  const status: IntegrationStatus = verification.ok ? 'connected' : 'invalid';

  const { error } = await db
    .from('user_integrations')
    .upsert(
      {
        user_id: auth.id,
        provider,
        credentials: encryptJson(normalized),
        status,
        last_verified_at: verification.ok ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,provider' }
    );

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }

  return NextResponse.json({
    success: verification.ok,
    provider,
    status,
    last_verified_at: verification.ok ? new Date().toISOString() : null,
    masked_info: isLegacyProvider(provider)
      ? maskIntegrationInfo(provider, normalized)
      : maskGenericIntegrationInfo(normalized),
    error: verification.ok ? null : (verification.error ?? 'Credential verification failed'),
  });
}

export async function verifyIntegration(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    provider?: string;
    credentials?: Record<string, unknown>;
  };

  const provider = normalizeProvider(String(body.provider ?? ''));
  if (!provider) return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });

  if (isCanonicalOAuthUiProvider(provider)) {
    return NextResponse.json(
      { error: 'GMAIL_REQUIRES_OAUTH', message: 'Gmail must be connected via Google sign-in. Use /api/oauth/start.' },
      { status: 400 }
    );
  }

  const normalized = isLegacyProvider(provider)
    ? normalizeCredentials(provider, body.credentials ?? {})
    : normalizeGenericCredentials(body.credentials ?? {});

  if (isLegacyProvider(provider)) {
    const validationError = validateRequiredCredentials(provider, normalized);
    if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const verification = isLegacyProvider(provider)
    ? await verifyIntegrationCredentials(provider, normalized)
    : await verifyDynamicIntegration({
        userId: auth.id,
        provider,
        credentials: normalized,
      });
  return NextResponse.json({
    success: verification.ok,
    provider,
    status: verification.ok ? 'connected' : 'invalid',
    error: verification.ok ? null : (verification.error ?? 'Verification failed'),
  });
}

export async function runIntegrationAction(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    provider?: string;
    action?: string;
    destinationEmail?: string;
    input?: Record<string, unknown>;
  };

  const provider = normalizeProvider(String(body.provider ?? ''));
  if (!provider) return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });

  // Phase 9.9.7B -- Gmail's real credential lives in integration_credentials
  // (the OAuth store), not a decryptable row in this legacy table, so this
  // generic test-action path can never correctly run for it. Fail clearly
  // rather than reading/misinterpreting a stale legacy row.
  if (isCanonicalOAuthUiProvider(provider)) {
    return NextResponse.json(
      { error: 'GMAIL_REQUIRES_OAUTH', message: 'Gmail actions are not available through this endpoint.' },
      { status: 400 }
    );
  }

  const db = createServiceClient();
  const { data: row, error } = await db
    .from('user_integrations')
    .select('credentials, status')
    .eq('user_id', auth.id)
    .eq('provider', provider)
    .maybeSingle();

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  if (!row || row.status !== 'connected') {
    return NextResponse.json({ error: 'Integration must be connected first' }, { status: 422 });
  }

  // Phase 9.9.5C -- decryptJson() now fails closed on a corrupted/wrong-key
  // credential instead of silently handing back ciphertext for a Test
  // Action to send to the real provider. Surfaced as a clear, actionable
  // 422 rather than an uncaught 500 -- never the underlying crypto error.
  let credentials: Record<string, string>;
  try {
    credentials = decryptJson((row.credentials ?? {}) as Record<string, unknown>);
  } catch (err) {
    if (!(err instanceof CredentialDecryptionError)) throw err;
    return NextResponse.json({ error: 'This credential could not be decrypted. Please reconnect the integration.' }, { status: 422 });
  }
  const normalizedCreds = normalizeGenericCredentials(credentials);

  const result = isLegacyProvider(provider)
    ? await runIntegrationTestAction(provider, normalizedCreds, String(body.action ?? ''), {
        destinationEmail: body.destinationEmail,
      })
    : await (async () => {
        try {
          const reasoning = await reasonProvider({
            providerHint: provider,
            contextText: `${String(body.action ?? '')} ${Object.keys(normalizedCreds).join(' ')}`,
            userId: auth.id,
          });
          const adapter = generateProviderAdapter(reasoning);
          const baseUrl = resolveDynamicBaseUrl(provider, normalizedCreds);
          const runtimeResult = await executeWithProviderAdapter({
            adapter,
            baseUrl,
            credentials: normalizedCreds,
            input: {
              action: String(body.action ?? ''),
              destinationEmail: body.destinationEmail,
              ...(body.input ?? {}),
            },
          });
          return { ok: true, details: { status: runtimeResult.status, latencyMs: runtimeResult.latencyMs } };
        } catch (error) {
          // Phase 9.4.1 Step H: this calls a real, dynamically-generated
          // provider adapter with the user's real credentials -- a raw
          // provider error could echo back headers/tokens/request
          // details. Never forward it as-is.
          const safe = classifyError(error);
          return { ok: false, error: safe.message };
        }
      })();

  return NextResponse.json({
    success: result.ok,
    provider,
    action: body.action,
    details: result.details ?? null,
    error: result.ok ? null : (result.error ?? 'Action failed'),
  }, { status: result.ok ? 200 : 422 });
}

export async function disconnectIntegration(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const provider = normalizeProvider(req.nextUrl.searchParams.get('provider') ?? '');
  if (!provider) {
    return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
  }

  // Phase 9.9.7B -- Gmail's real credential lives in integration_credentials
  // (the OAuth store), not the legacy user_integrations table, so disconnect
  // must revoke it there. Without this, "Disconnect" on the Gmail card would
  // upsert a 'not_connected' row into a table Gmail was never actually
  // stored in -- a no-op that leaves the real OAuth grant connected.
  if (isCanonicalOAuthUiProvider(provider)) {
    try {
      await deleteProviderCredentials(auth.id, provider);
    } catch (err) {
      const safe = classifyError(err);
      return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
    }
    return NextResponse.json({ success: true, provider });
  }

  const db = createServiceClient();
  const { error } = await db
    .from('user_integrations')
    .upsert(
      {
        user_id: auth.id,
        provider,
        credentials: {},
        status: 'not_connected',
        last_verified_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,provider' }
    );

  if (error) {
    const safe = classifyError(error);
    return NextResponse.json({ error: safe.code, message: safe.message, retryable: safe.retryable }, { status: safe.httpStatus });
  }
  return NextResponse.json({ success: true, provider });
}

export async function getIntegrationCatalog(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const memory = await listProviderMemory({ userId: auth.id });
  const dynamicCards: DynamicIntegrationCardModel[] = memory.map((item) => ({
    provider: item.provider,
    category: item.providerType,
    capabilities: item.capabilities,
    requiredCredentials: item.requiredCredentials.map((key) => ({
      key,
      label: key.toUpperCase(),
      secret: /(token|key|secret|pass|password|cookie)/i.test(key),
      placeholder: /(url|endpoint|base)/i.test(key) ? 'https://api.example.com' : undefined,
    })),
    docsUrl: item.docsUrl,
    logo: item.logo,
    authStrategy: item.authStrategy,
    validationStrategy: item.validationStrategy,
    endpointHints: item.endpointHints,
  }));

  const merged = new Map<string, DynamicIntegrationCardModel>();
  for (const card of staticCatalogCards()) {
    merged.set(card.provider, card);
  }
  for (const card of dynamicCards) {
    merged.set(card.provider, card);
  }

  // Phase 9.9.7B -- override LAST, unconditionally, so a stale
  // provider_intelligence memory row for 'gmail' (an AI-inferred generic
  // API_KEY shape memoized on first encounter, before this fix existed) can
  // never win the merge and put manual credential fields back in front of
  // the user. Gmail's catalog entry is always this fixed, field-free OAuth
  // card, regardless of what memory or static tables contain for that key.
  merged.set('gmail', canonicalOAuthCatalogCard('gmail'));

  return NextResponse.json({
    success: true,
    providers: Array.from(merged.values()).sort((left, right) => left.provider.localeCompare(right.provider)),
  });
}

export async function reasonIntegrationProvider(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    providerHint?: string;
    contextText?: string;
    docsUrl?: string;
    openApiUrl?: string;
  };

  const providerHint = normalizeProvider(String(body.providerHint ?? ''));
  if (!providerHint) {
    return NextResponse.json({ error: 'providerHint is required' }, { status: 400 });
  }

  const reasoning = await reasonProvider({
    providerHint,
    contextText: body.contextText,
    docsUrl: body.docsUrl,
    openApiUrl: body.openApiUrl,
    userId: auth.id,
  });

  const card: DynamicIntegrationCardModel = {
    provider: providerHint,
    category: reasoning.providerType ?? categoryFromProvider(providerHint),
    capabilities: reasoning.likelyCapabilities,
    requiredCredentials: reasoning.likelyCredentials.map((key) => ({
      key,
      label: key.toUpperCase(),
      secret: /(token|key|secret|pass|password|cookie)/i.test(key),
      placeholder: key.includes('url') ? 'https://api.example.com' : undefined,
    })),
    docsUrl: reasoning.metadata?.docsUrl,
    logo: reasoning.metadata?.logo,
    authStrategy: reasoning.authStrategy,
    validationStrategy: reasoning.likelyValidationMethod,
    endpointHints: reasoning.endpointHints,
  };

  return NextResponse.json({
    success: true,
    reasoning,
    card,
  });
}
