import {
  getRequiredCredentials,
  getOptionalCredentials,
  getProviderDisplayName,
  providerHasCredentials,
  type CredentialRequirement,
} from './provider-registry';
import {
  normalizeProvider,
  parseRequestedProvidersFromPrompt,
} from '@/lib/agent/provider-allowlist';
import {
  verifyAllProvidersForUser,
  getVerificationStatus,
  type VerificationStatus,
  type ProviderCredentialSummary,
} from './storage';

export type { CredentialRequirement };

export type CredentialResolutionResult = {
  provider: string;
  displayName: string;
  missing: CredentialRequirement[];
  optional: CredentialRequirement[];
  ready: boolean;
  confidence: number;
};

function deduplicateProviders(providers: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of providers) {
    const n = normalizeProvider(p);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * Returns the credential requirements for each provider without knowing
 * which providers are already connected.  All required fields appear in
 * `missing` and `ready` is always false.  Use this inside engine.ts where
 * there is no DB access.
 */
export function resolveCredentialRequirements(providers: string[]): CredentialResolutionResult[] {
  return deduplicateProviders(providers)
    .filter((p) => providerHasCredentials(p))
    .map((provider) => ({
      provider,
      displayName: getProviderDisplayName(provider),
      missing: getRequiredCredentials(provider),
      optional: getOptionalCredentials(provider),
      ready: false,
      confidence: 100,
    }));
}

/**
 * Resolves credential requirements against a list of already-connected
 * providers.  A connected provider has `ready=true` and no `missing` fields.
 */
export function resolveMissingCredentials(
  providers: string[],
  connected: string[]
): CredentialResolutionResult[] {
  const connectedSet = new Set(connected.map((p) => normalizeProvider(p)).filter(Boolean));

  return deduplicateProviders(providers)
    .filter((p) => providerHasCredentials(p))
    .map((provider) => {
      const isConnected = connectedSet.has(provider);
      return {
        provider,
        displayName: getProviderDisplayName(provider),
        missing: isConnected ? [] : getRequiredCredentials(provider),
        optional: getOptionalCredentials(provider),
        ready: isConnected,
        confidence: 100,
      };
    });
}

/**
 * Returns whether all required-credential providers are connected and
 * which provider names are blocking deployment.
 */
export function checkDeploymentCredentials(
  providers: string[],
  connected: string[]
): { canDeploy: boolean; missingProviders: string[] } {
  const connectedSet = new Set(connected.map((p) => normalizeProvider(p)).filter(Boolean));

  const missingProviders = deduplicateProviders(providers).filter(
    (p) => providerHasCredentials(p) && getRequiredCredentials(p).length > 0 && !connectedSet.has(p)
  );

  return {
    canDeploy: missingProviders.length === 0,
    missingProviders,
  };
}

// ── Integration Intelligence ──────────────────────────────────────────────────

export type IntegrationStatus = 'ready' | 'missing' | 'invalid' | 'oauth_required';

export type IntegrationRequirement = {
  provider: string;
  displayName: string;
  required: boolean;
  connected: boolean;
  missing: string[];
  status: IntegrationStatus;
};

export type AutomationRequirementsResult = {
  integrations: IntegrationRequirement[];
  allReady: boolean;
  blockers: string[];
};

type SummaryInput = {
  ready: boolean;
  missing: ReadonlyArray<{ source: string }>;
};

/**
 * Derives the UI status for a single provider given its credential summary and
 * last known verification outcome.
 *
 * Rules:
 *   not connected + all missing fields are OAuth → oauth_required
 *   not connected + at least one non-OAuth field  → missing
 *   connected + verification is invalid/expired   → invalid
 *   connected + everything else                   → ready
 */
export function computeIntegrationStatus(
  summary: SummaryInput,
  verificationStatus?: VerificationStatus
): IntegrationStatus {
  if (!summary.ready) {
    const allOAuth =
      summary.missing.length > 0 &&
      summary.missing.every((f) => f.source === 'oauth');
    return allOAuth ? 'oauth_required' : 'missing';
  }
  if (verificationStatus === 'invalid' || verificationStatus === 'expired') {
    return 'invalid';
  }
  return 'ready';
}

/**
 * Pure function: maps a list of provider names + pre-fetched DB summaries into
 * IntegrationRequirement records.  Call this after fetching from
 * verifyAllProvidersForUser() and collecting getVerificationStatus() results.
 *
 * Providers absent from the registry (providerHasCredentials = false) are
 * filtered out.  Providers present in `providers` but absent from `summaries`
 * are treated as not-connected.
 */
export function computeIntegrationRequirements(
  providers: string[],
  summaries: ProviderCredentialSummary[],
  verificationMap: Map<string, VerificationStatus> = new Map()
): IntegrationRequirement[] {
  const summaryMap = new Map(summaries.map((s) => [s.provider, s]));

  return deduplicateProviders(providers)
    .filter((p) => providerHasCredentials(p))
    .map((provider) => {
      const summary = summaryMap.get(provider);
      const connected = summary?.ready ?? false;
      const missingKeys = summary
        ? summary.missing.map((f) => f.key)
        : getRequiredCredentials(provider).map((f) => f.key);

      let status: IntegrationStatus;
      if (summary) {
        status = computeIntegrationStatus(summary, verificationMap.get(provider));
      } else {
        const required = getRequiredCredentials(provider);
        const allOAuth = required.length > 0 && required.every((f) => f.source === 'oauth');
        status = allOAuth ? 'oauth_required' : 'missing';
      }

      return {
        provider,
        displayName: getProviderDisplayName(provider),
        required: true,
        connected,
        missing: missingKeys,
        status,
      };
    });
}

/**
 * Parses a natural-language prompt, resolves which canonical providers it
 * mentions, then checks their credential state for `userId`.
 *
 * Returns:
 *   integrations — one entry per detected provider
 *   allReady     — true when every integration is status=ready
 *   blockers     — provider names whose status is not ready
 */
export async function analyzeAutomationRequirements(
  prompt: string,
  userId: string
): Promise<AutomationRequirementsResult> {
  const providers = parseRequestedProvidersFromPrompt(prompt);

  if (providers.length === 0) {
    return { integrations: [], allReady: true, blockers: [] };
  }

  const [summaries, verificationPairs] = await Promise.all([
    verifyAllProvidersForUser(userId, providers),
    Promise.all(
      providers.map(async (p) => {
        const vs = await getVerificationStatus(userId, p).catch(() => ({
          provider: p,
          verifiedAt: null as string | null,
          status: 'unknown' as VerificationStatus,
        }));
        return [p, vs.status] as [string, VerificationStatus];
      })
    ),
  ]);

  const verificationMap = new Map<string, VerificationStatus>(verificationPairs);
  const integrations = computeIntegrationRequirements(providers, summaries, verificationMap);
  const allReady = integrations.every((i) => i.status === 'ready');
  const blockers = integrations.filter((i) => i.status !== 'ready').map((i) => i.provider);

  return { integrations, allReady, blockers };
}

// ── buildCredentialSummary ─────────────────────────────────────────────────

/**
 * Generates a human-readable credential summary for a list of results.
 *
 * Examples:
 *   telegram only → "Telegram needs: Bot Token, Chat ID"
 *   gmail + slack → "Gmail needs: Google OAuth | Slack needs: Bot Token"
 *   all ready → "All integrations connected"
 */
export function buildCredentialSummary(results: CredentialResolutionResult[]): string {
  const notReady = results.filter((r) => !r.ready && r.missing.length > 0);
  if (notReady.length === 0) return 'All integrations connected';

  return notReady
    .map((r) => {
      const labels = r.missing.map((f) => f.label).join(', ');
      return `${r.displayName} needs: ${labels}`;
    })
    .join(' | ');
}
