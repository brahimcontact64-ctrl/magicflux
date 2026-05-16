import type {
  Capability,
  ProviderAdapter,
  ProviderReasoningResult,
} from './types';

function pickCapability(capabilities: Capability[]): Capability {
  if (capabilities.includes('chat_completion')) return 'chat_completion';
  if (capabilities.includes('llm_generation')) return 'llm_generation';
  if (capabilities.includes('embeddings')) return 'embeddings';
  return capabilities[0] ?? 'llm_generation';
}

function inferEndpoint(reasoning: ProviderReasoningResult, capability: Capability): string {
  const endpointHints = reasoning.endpointHints ?? [];

  if (capability === 'chat_completion') {
    const chatHint = endpointHints.find((hint) => hint.toLowerCase().includes('chat'));
    if (chatHint) return chatHint;
    const completionHint = endpointHints.find((hint) => hint.toLowerCase().includes('completion'));
    if (completionHint) return completionHint;
  }

  if (capability === 'embeddings') {
    const embeddingHint = endpointHints.find((hint) => hint.toLowerCase().includes('embedding'));
    if (embeddingHint) return embeddingHint;
  }

  return endpointHints[0] ?? '/v1/chat/completions';
}

function inferPayloadTemplate(capability: Capability): Record<string, unknown> {
  if (capability === 'chat_completion' || capability === 'llm_generation') {
    return {
      model: '{{model}}',
      messages: [{ role: 'user', content: '{{prompt}}' }],
      temperature: 0.2,
    };
  }

  if (capability === 'embeddings') {
    return {
      model: '{{model}}',
      input: '{{input}}',
    };
  }

  return {
    input: '{{input}}',
  };
}

export function generateProviderAdapter(reasoning: ProviderReasoningResult): ProviderAdapter {
  const capability = pickCapability(reasoning.likelyCapabilities);
  const endpoint = inferEndpoint(reasoning, capability);

  return {
    provider: reasoning.likelyProvider,
    capability,
    endpoint,
    method: 'POST',
    auth: reasoning.authStrategy,
    payloadTemplate: inferPayloadTemplate(capability),
    payloadTransformer: {
      mode: 'merge_input',
    },
    responseTransformer: {
      mode: 'identity',
    },
    retryPolicy: {
      attempts: 3,
      baseDelayMs: 600,
      maxDelayMs: 8000,
    },
    validation: {
      endpoint,
      method: 'POST',
      expectedStatuses: [200, 201],
    },
  };
}
