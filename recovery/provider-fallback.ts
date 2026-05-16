import type { EngineNode } from '@/lib/workflow-runtime/types';

const PROVIDER_FALLBACKS: Record<string, string[]> = {
  openai: ['anthropic', 'groq', 'mistral'],
  anthropic: ['openai', 'groq', 'mistral'],
  telegram: ['slack', 'email'],
  slack: ['telegram', 'email'],
};

function replaceProviderInType(type: string, from: string, to: string): string {
  return type.replace(new RegExp(from, 'ig'), to);
}

export function suggestProviderFallback(provider: string): string | null {
  const normalized = provider.toLowerCase();
  const candidates = PROVIDER_FALLBACKS[normalized] ?? [];
  return candidates[0] ?? null;
}

export function applyProviderFallback(nodes: EngineNode[], fromProvider: string, toProvider?: string): {
  nextNodes: EngineNode[];
  changedNodeIds: string[];
  resolvedProvider: string | null;
} {
  const fallback = toProvider ?? suggestProviderFallback(fromProvider);
  if (!fallback) {
    return { nextNodes: nodes, changedNodeIds: [], resolvedProvider: null };
  }

  const changedNodeIds: string[] = [];
  const nextNodes = nodes.map((node) => {
    const type = String(node.type ?? '').toLowerCase();
    if (!type.includes(fromProvider.toLowerCase())) {
      return node;
    }

    const updated: EngineNode = {
      ...node,
      type: replaceProviderInType(String(node.type ?? ''), fromProvider, fallback),
      parameters: {
        ...(node.parameters ?? {}),
        provider: fallback,
        fallback_from: fromProvider,
      },
    };

    changedNodeIds.push(String(node.id ?? node.name ?? 'unknown'));
    return updated;
  });

  return {
    nextNodes,
    changedNodeIds,
    resolvedProvider: fallback,
  };
}
