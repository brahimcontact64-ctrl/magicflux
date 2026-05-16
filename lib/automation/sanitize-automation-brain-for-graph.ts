import type { WorkflowGraphSummary } from '@/lib/agent/workflow-graph';

type BrainCapability = { key: string; reason?: string; confidence?: number };
type SkillPack = { capabilities?: string[]; [key: string]: unknown };
type BrainPattern = { requiredCapabilities?: string[]; [key: string]: unknown };
type Composition = { executionFrequency?: string };

type AutomationBrainLike = {
  capabilities?: BrainCapability[];
  activatedSkillPacks?: SkillPack[];
  matchedPatterns?: BrainPattern[];
  composition?: Composition;
};

function hasScheduleTrigger(workflowGraph?: WorkflowGraphSummary | null): boolean {
  if (!workflowGraph) return false;
  return (workflowGraph.nodes ?? []).some((node) => {
    if (node.kind !== 'trigger') return false;
    const signal = `${node.type ?? ''} ${node.provider ?? ''} ${node.label ?? ''} ${node.name ?? ''}`.toLowerCase();
    return /cron|schedule|interval|scheduler/.test(signal);
  });
}

export function sanitizeAutomationBrainForGraph<T extends AutomationBrainLike>(
  brain: T,
  workflowGraph?: WorkflowGraphSummary | null
): T;
export function sanitizeAutomationBrainForGraph<T extends AutomationBrainLike>(
  brain: T | undefined,
  workflowGraph?: WorkflowGraphSummary | null
): T | undefined;
export function sanitizeAutomationBrainForGraph<T extends AutomationBrainLike>(
  brain: T | null,
  workflowGraph?: WorkflowGraphSummary | null
): T | null;
export function sanitizeAutomationBrainForGraph<T extends AutomationBrainLike>(
  brain: T | null | undefined,
  workflowGraph?: WorkflowGraphSummary | null
): T | null | undefined {
  if (!brain) return brain;
  if (hasScheduleTrigger(workflowGraph)) return brain;

  const cleanedCapabilities = (brain.capabilities ?? []).filter((capability) => capability.key !== 'scheduling');
  const cleanedSkillPacks = (brain.activatedSkillPacks ?? [])
    .map((pack) => ({
      ...pack,
      capabilities: (pack.capabilities ?? []).filter((capability) => capability !== 'scheduling'),
    }))
    .filter((pack) => (pack.capabilities ?? []).length > 0);
  const cleanedPatterns = (brain.matchedPatterns ?? []).map((pattern) => ({
    ...pattern,
    ...(Array.isArray(pattern.requiredCapabilities)
      ? { requiredCapabilities: pattern.requiredCapabilities.filter((capability) => capability !== 'scheduling') }
      : {}),
  }));

  const sanitized = {
    ...brain,
    capabilities: cleanedCapabilities,
    activatedSkillPacks: cleanedSkillPacks,
    matchedPatterns: cleanedPatterns,
    composition: {
      ...(brain.composition ?? {}),
      executionFrequency: 'Event-driven',
    },
  };

  return sanitized as T;
}
