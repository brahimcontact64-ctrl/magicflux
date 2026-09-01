/**
 * "What tools do you use" onboarding step — Phase 9.2.
 *
 * The label/icon/display list below is just UI text (never drifts into a
 * capability claim on its own). The one fact that CAN drift — is this
 * provider actually usable today — is computed from the two authoritative
 * registries (PROVIDER_NODE_ALLOWLIST in lib/integrations.ts,
 * checkNodeCapability() in lib/workflow-runtime/node-capabilities.ts,
 * Phase 9.1.6), never hand-typed here. Both are pure/client-safe.
 */

import { PROVIDER_NODE_ALLOWLIST, type IntegrationProvider } from './integrations';
import { checkNodeCapability } from './workflow-runtime/node-capabilities';

export type OnboardingToolOption = {
  key: string;
  label: string;
  /** True only if at least one of this provider's real node types passes the
   * live capability check today. */
  available: boolean;
};

/** Returns true if ANY node type registered for this provider is genuinely
 * capable today (not blocked, has a real handler). A provider can list
 * several node types (e.g. a trigger + an action variant); one working
 * type is enough to call the provider "available now". */
function isProviderAvailable(provider: IntegrationProvider): boolean {
  const types = PROVIDER_NODE_ALLOWLIST.get(provider);
  if (!types || types.size === 0) return false;
  for (const type of types) {
    if (checkNodeCapability({ type }).capable) return true;
  }
  return false;
}

// Display metadata only. Every `available` value below is computed, not
// asserted — see isProviderAvailable(). Providers with zero registry
// presence at all (Google Sheets, HubSpot, Twilio) are listed explicitly
// so onboarding can honestly say "coming soon" rather than omit them and
// let a user wonder why their tool isn't mentioned.
const CANDIDATES: Array<{ key: string; label: string; provider: IntegrationProvider | null }> = [
  { key: 'slack', label: 'Slack', provider: 'slack' },
  { key: 'gmail', label: 'Gmail / Email', provider: 'gmail' },
  { key: 'shopify', label: 'Shopify', provider: 'shopify' },
  { key: 'airtable', label: 'Airtable', provider: 'airtable' },
  { key: 'http', label: 'A website or API', provider: 'custom' },
  { key: 'google_sheets', label: 'Google Sheets', provider: null },
  { key: 'hubspot', label: 'HubSpot', provider: null },
  { key: 'twilio', label: 'SMS / Twilio', provider: null },
  { key: 'google_drive', label: 'Google Drive', provider: 'google_drive' },
];

export function getOnboardingToolOptions(): OnboardingToolOption[] {
  return CANDIDATES.map(({ key, label, provider }) => ({
    key,
    label,
    available: provider ? isProviderAvailable(provider) : false,
  }));
}
