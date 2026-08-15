export type CapabilityInference = {
  key: string;
  reason: string;
  confidence: number;
};

export type ExecutionMode = 'event-driven' | 'scheduled' | 'manual' | 'unknown';

export type TriggerMode = 'message' | 'email' | 'webhook' | 'scheduler' | 'unknown';

export type ActionMode = 'reply' | 'summarize' | 'sync' | 'notify' | 'transform' | 'unknown';

export type IntentContext = {
  rawPrompt: string;
  requestedProviders: string[];
  executionMode: ExecutionMode;
  triggerMode: TriggerMode;
  actionMode: ActionMode;
};

export type ConstraintContext = {
  requiredProviders: string[];
  allowedProviders: string[];
  forbiddenProviders: string[];
  requiredCapabilities: string[];
  forbiddenCapabilities: string[];
  executionMode: ExecutionMode;
  triggerMode: TriggerMode;
  actionMode: ActionMode;
  /** True when the user expressed an explicit "X only" constraint. Under identity
   *  lock, provider candidate expansion is disabled — only explicitly required or
   *  directly mentioned providers may appear in resolutions. */
  identityLocked: boolean;
};

export type PatternKind = 'provider_specific' | 'domain_template' | 'abstract_template';

export type PatternLockReason =
  | 'provider_name_match'
  | 'user_constraint'
  | 'runtime_evidence'
  | 'admin_override'
  | 'graph_confirmation';

export type LockEvidenceItem = {
  signal: string;
  source: 'name' | 'description' | 'user_prompt' | 'runtime' | 'graph' | 'admin';
  method: string;
  confidence: number;
};

export type PatternClassification = {
  kind: PatternKind;
  providers: string[];
  domains: string[];
  confidence: number;
  origin: 'db' | 'graph' | 'domain' | 'enriched';
  identityLocked: boolean;
  lockReason: PatternLockReason | null;
  lockEvidence: LockEvidenceItem[];
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
  classification: PatternClassification;
};

export type SkillPackActivation = {
  id: string;
  name: string;
  description: string;
  tools: string[];
  capabilities: string[];
  patterns: string[];
  matchScore: number;
  classification: PatternClassification;
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

export type ProviderIntentGraph = {
  provider: string;
  confidence: number;
  sourceSignals: string[];
  triggerSignals: string[];
  actionSignals: string[];
};

export type CredentialIntelligenceEntry = {
  provider: string;
  /** Required credential key names that are not yet provided. */
  missing: string[];
  /** Optional credential key names. */
  optional: string[];
  /** True when all required credentials for this provider are connected. */
  ready: boolean;
  confidence: number;
};

export type AutomationBrainResult = {
  inferredIntent: string;
  capabilities: CapabilityInference[];
  activatedSkillPacks: SkillPackActivation[];
  matchedPatterns: PatternMatch[];
  providerResolutions: ProviderResolution[];
  composition: WorkflowCompositionBlueprint;
  /** The ConstraintContext extracted from the original prompt. Carried here so
   *  downstream functions can re-apply constraints without re-parsing. */
  constraintContext: ConstraintContext;
  /** Provider intent derived purely from prompt signals — no capability→provider inference. */
  providerIntentGraph: ProviderIntentGraph[];
  /** Per-provider credential requirements inferred from the automation plan. */
  credentialIntelligence: CredentialIntelligenceEntry[];
};
