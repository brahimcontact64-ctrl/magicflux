import {
  inferCapabilitiesFromText,
  inferLikelyCredentials,
  inferProviderCategory,
  inferValidationStrategy,
} from './capability-inference-engine';
import { discoverProvider } from './dynamic-provider-discovery';
import {
  getProviderMemoryByAlias,
  getProviderMemoryByKey,
  saveProviderMemory,
} from './provider-memory-store';
import type {
  ProviderMetadata,
  ProviderReasoningResult,
} from './types';

function normalizeProviderKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function metadataToReasoning(metadata: ProviderMetadata): ProviderReasoningResult {
  return {
    providerType: metadata.providerType,
    likelyProvider: metadata.displayName || metadata.provider,
    likelyCredentials: metadata.requiredCredentials,
    likelyCapabilities: metadata.capabilities,
    likelyValidationMethod: metadata.validationStrategy,
    authStrategy: metadata.authStrategy,
    endpointHints: metadata.endpointHints,
    confidence: metadata.confidence,
    metadata,
  };
}

export async function reasonProvider(params: {
  providerHint: string;
  contextText?: string;
  docsUrl?: string;
  openApiUrl?: string;
  userId?: string;
}): Promise<ProviderReasoningResult> {
  const providerKey = normalizeProviderKey(params.providerHint);
  const contextText = `${params.providerHint} ${params.contextText ?? ''}`.trim();

  if (params.userId) {
    const directMemory = await getProviderMemoryByKey({ userId: params.userId, providerKey });
    if (directMemory) {
      return metadataToReasoning(directMemory);
    }

    const aliasMemory = await getProviderMemoryByAlias({
      userId: params.userId,
      providerAlias: providerKey,
    });
    if (aliasMemory) {
      return metadataToReasoning(aliasMemory);
    }
  }

  const discovery = await discoverProvider({
    providerHint: params.providerHint,
    docsUrl: params.docsUrl,
    openApiUrl: params.openApiUrl,
  });

  const inferredCapabilities = Array.from(new Set([
    ...inferCapabilitiesFromText(contextText),
    ...discovery.discoveredCapabilities,
  ]));

  const providerType = inferProviderCategory(inferredCapabilities);
  const likelyCredentials = inferLikelyCredentials({
    capabilities: inferredCapabilities,
    authHints: discovery.discoveredAuthStrategies,
  });
  const likelyValidationMethod = inferValidationStrategy(inferredCapabilities);

  const metadata: ProviderMetadata = {
    provider: providerKey,
    displayName: discovery.resolvedProviderName || params.providerHint,
    providerType,
    capabilities: inferredCapabilities,
    requiredCredentials: likelyCredentials,
    docsUrl: discovery.docsUrl ?? null,
    logo: null,
    authStrategy: discovery.discoveredAuthStrategies[0] ?? {
      type: 'bearer_token',
      headerName: 'Authorization',
      tokenPrefix: 'Bearer ',
    },
    validationStrategy: likelyValidationMethod,
    endpointHints: discovery.endpointHints,
    aliases: [providerKey, params.providerHint.toLowerCase()],
    confidence: discovery.confidence,
    source: 'reasoning',
  };

  if (params.userId) {
    await saveProviderMemory({
      userId: params.userId,
      metadata,
      successfulPatterns: {
        discoveredFrom: discovery.rawSignals,
      },
    });
  }

  return metadataToReasoning(metadata);
}
