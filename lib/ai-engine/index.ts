import { parseIntent } from './intent-parser';
import { selectTemplate } from './template-selector';
import {
  computePackageScore,
  extractWorkflowNodes,
  extractWorkflowEdges,
  composeCredentials,
  composeDependencies,
  composeVariablesSchema,
  composeSuggestions
} from './workflow-composer';
import { applyCustomization } from './customizer';
import { EnrichedGenerationResult, EngineConfig, GenerationContext } from './types';

const RESPONSE_TEMPLATES = [
  (name: string, count: number, time: string) =>
    `I've analyzed your request and matched it to the **${name}** template — a perfect fit for your use case. Generated a complete n8n-compatible package with ${count} nodes, ready to deploy in ~${time}.`,
  (name: string, count: number, time: string) =>
    `Your automation is ready. I've built the **${name}** workflow with ${count} nodes, including complete .env config, dependency checklist, and setup guide. Estimated setup time: ${time}.`,
  (name: string, count: number, time: string) =>
    `Matched to **${name}** — a ${count}-node workflow covering exactly what you described. The package includes credentials checklist, environment variables schema, and a step-by-step guide. Setup takes about ${time}.`,
  (name: string, count: number, time: string) =>
    `I've designed your **${name}** automation. This production-ready package has ${count} interconnected nodes and takes approximately ${time} to configure. Review the tabs below to explore the full workflow.`
];

export class AutomationEngine {
  private config: EngineConfig;

  constructor(config: EngineConfig = { mode: 'mock' }) {
    this.config = config;
  }

  async generate(
    prompt: string,
    context: Partial<GenerationContext> = {}
  ): Promise<EnrichedGenerationResult> {
    if (this.config.mode === 'openai' && this.config.openAIApiKey) {
      return this.generateWithOpenAI(prompt, context);
    }
    return this.generateMock(prompt, context);
  }

  async customize(
    prompt: string,
    current: EnrichedGenerationResult
  ): Promise<EnrichedGenerationResult> {
    const intent = parseIntent(prompt);
    intent.isModification = true;
    intent.targetTemplateId = current.template.id;

    const patch = applyCustomization(current, intent);
    const template = patch.template || current.template;

    return {
      ...current,
      ...patch,
      template,
      intent,
      generatedAt: new Date().toISOString(),
      workflowNodes: patch.workflowNodes || extractWorkflowNodes(template.workflow as Record<string, any>),
      workflowEdges: extractWorkflowEdges(template.workflow as Record<string, any>)
    };
  }

  private async generateMock(
    prompt: string,
    context: Partial<GenerationContext>
  ): Promise<EnrichedGenerationResult> {
    const intent = parseIntent(prompt);

    if (intent.isModification && context.previousResult) {
      return this.customize(prompt, context.previousResult);
    }

    const { template, matchScore } = selectTemplate(
      intent,
      context.previousResult?.template.id
    );

    const workflow = template.workflow as Record<string, any>;
    const workflowNodes = extractWorkflowNodes(workflow);
    const workflowEdges = extractWorkflowEdges(workflow);
    const packageScore = computePackageScore(template);
    const credentialsNeeded = composeCredentials(template);
    const dependencyChecklist = composeDependencies(template);
    const variablesSchema = composeVariablesSchema(template);
    const customizationSuggestions = composeSuggestions(template);

    const msgFn = RESPONSE_TEMPLATES[Math.floor(Math.random() * RESPONSE_TEMPLATES.length)];
    const responseMessage = msgFn(template.name, template.nodeCount, template.estimatedSetupTime);

    return {
      template,
      intent,
      confidence: matchScore,
      responseMessage,
      generatedAt: new Date().toISOString(),
      packageScore,
      credentialsNeeded,
      dependencyChecklist,
      variablesSchema,
      appliedCustomizations: [],
      customizationSuggestions,
      workflowNodes,
      workflowEdges
    };
  }

  private async generateWithOpenAI(
    _prompt: string,
    _context: Partial<GenerationContext>
  ): Promise<EnrichedGenerationResult> {
    // TODO: Implement OpenAI-powered generation
    // 1. Call GPT-4 with system prompt describing the template format
    // 2. Parse the response into a structured template
    // 3. Merge with enrichment data
    throw new Error('OpenAI mode not yet implemented. Set mode: "mock" to use the built-in engine.');
  }
}

export const automationEngine = new AutomationEngine({ mode: 'mock' });

export { parseIntent } from './intent-parser';
export { selectTemplate } from './template-selector';
export * from './types';
export * from './n8n-deployer';
