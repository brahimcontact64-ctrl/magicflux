import { listProviderMemory } from './provider-memory-store';
import type { Capability, ProviderMetadata } from './types';

function scoreProvider(params: {
  provider: ProviderMetadata;
  preferredCapabilities: Capability[];
}): number {
  const capabilityScore = params.preferredCapabilities.filter((cap) => params.provider.capabilities.includes(cap)).length * 25;
  const confidenceScore = Math.round(params.provider.confidence);
  return capabilityScore + confidenceScore;
}

export async function selectProviderFallback(params: {
  userId: string;
  capability: Capability;
  failedProviders: string[];
}): Promise<ProviderMetadata | null> {
  const memory = await listProviderMemory({ userId: params.userId });
  const failed = new Set(params.failedProviders.map((item) => item.toLowerCase()));

  const candidates = memory
    .filter((provider) => provider.capabilities.includes(params.capability))
    .filter((provider) => !failed.has(provider.provider.toLowerCase()));

  if (candidates.length === 0) return null;

  candidates.sort((left, right) => {
    const leftScore = scoreProvider({ provider: left, preferredCapabilities: [params.capability] });
    const rightScore = scoreProvider({ provider: right, preferredCapabilities: [params.capability] });
    return rightScore - leftScore;
  });

  return candidates[0] ?? null;
}
