export type CapabilityInference = {
  key: string;
  reason: string;
  confidence: number;
};

export type PatternMatch = {
  id: string;
  name: string;
  category: string;
  description: string;
  requiredCapabilities: string[];
  requiredTools: string[];
  optionalTools: string[];
  risk: 'low' | 'medium' | 'high';
  estimatedCost: number;
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
  schedulePatterns: string[];
  examples: string[];
  score: number;
};

export type SkillPackActivation = {
  id: string;
  name: string;
  description: string;
  tools: string[];
  capabilities: string[];
  patterns: string[];
  matchScore: number;
};

export type ProviderResolution = {
  provider: string;
  capabilities: string[];
  confidence: number;
};

export type BlockBlueprint = {
  id: string;
  category:
    | 'trigger'
    | 'ai'
    | 'memory'
    | 'database'
    | 'scraping'
    | 'messaging'
    | 'voice'
    | 'vision'
    | 'crm'
    | 'approval'
    | 'payment'
    | 'monitoring';
  name: string;
  capabilities: string[];
};

export type WorkflowCompositionBlueprint = {
  blocks: BlockBlueprint[];
  expectedInputs: string[];
  expectedOutputs: string[];
  executionFrequency: string;
  risks: string[];
  estimatedCostUsd: number;
  complexity: 'simple' | 'moderate' | 'complex';
  latencyEstimateMs: number;
};

export type AutomationBrainResult = {
  inferredIntent: string;
  capabilities: CapabilityInference[];
  activatedSkillPacks: SkillPackActivation[];
  matchedPatterns: PatternMatch[];
  providerResolutions: ProviderResolution[];
  composition: WorkflowCompositionBlueprint;
};
