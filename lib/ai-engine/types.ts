import { AutomationTemplate, Industry } from '../templates';

export interface ParsedIntent {
  rawPrompt: string;
  action: 'build' | 'customize' | 'add' | 'remove' | 'switch' | 'query';
  industry: Industry | null;
  keywords: string[];
  integrationsRequested: string[];
  triggersRequested: string[];
  modificationType: ModificationType | null;
  isModification: boolean;
  targetTemplateId?: string;
  confidence: number;
}

export type ModificationType =
  | 'add_slack'
  | 'add_sms'
  | 'add_email'
  | 'add_approval'
  | 'add_delay'
  | 'add_sheets'
  | 'add_webhook'
  | 'switch_channel'
  | 'add_error_handling'
  | 'generic';

export interface PackageScore {
  complexity: number;
  setupTime: number;
  businessImpact: number;
  automationScore: number;
  label: 'Starter' | 'Professional' | 'Enterprise';
  timeToROI: string;
}

export interface DependencyItem {
  id: string;
  name: string;
  type: 'account' | 'api_key' | 'tool' | 'smtp' | 'configuration';
  required: boolean;
  description: string;
  setupUrl?: string;
  icon: string;
}

export interface VariableSchema {
  key: string;
  type: 'string' | 'email' | 'url' | 'api_key' | 'number' | 'cron' | 'password';
  required: boolean;
  description: string;
  example: string;
  group: string;
}

export interface CredentialRequirement {
  service: string;
  type: string;
  description: string;
  docsUrl?: string;
}

export interface GenerationContext {
  previousResult?: EnrichedGenerationResult;
  customizations: string[];
  sessionId: string;
}

export interface EnrichedGenerationResult {
  template: AutomationTemplate;
  intent: ParsedIntent;
  confidence: number;
  responseMessage: string;
  generatedAt: string;
  packageScore: PackageScore;
  credentialsNeeded: CredentialRequirement[];
  dependencyChecklist: DependencyItem[];
  variablesSchema: VariableSchema[];
  appliedCustomizations: string[];
  customizationSuggestions: string[];
  workflowNodes: WorkflowNode[];
  workflowEdges: WorkflowEdge[];
}

export interface WorkflowNode {
  id: string;
  label: string;
  type: string;
  nodeType: N8nNodeCategory;
  position: [number, number];
}

export type N8nNodeCategory =
  | 'trigger'
  | 'transform'
  | 'email'
  | 'database'
  | 'crm'
  | 'ecommerce'
  | 'messaging'
  | 'calendar'
  | 'condition'
  | 'delay'
  | 'utility';

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface EngineConfig {
  mode: 'mock' | 'openai';
  openAIApiKey?: string;
  model?: string;
}
