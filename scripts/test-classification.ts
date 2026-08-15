/**
 * Classification consumption integration tests.
 * Run with:  npx tsx scripts/test-classification.ts
 *
 * Tests three scenarios without a live DB:
 *   1. Telegram prompt → telegram only, no WhatsApp, no Restaurant
 *   2. Shopify scheduled → domain_template survives (provider enrichment allowed)
 *   3. Generic summarizer → abstract_template survives
 */

import assert from 'assert';
import { extractHardConstraints, buildProviderIntentGraph } from '@/lib/automation/extract-hard-constraints';
import { sanitizeAutomationBrainForGraph } from '@/lib/automation/sanitize-automation-brain-for-graph';
import { constrainAutomationBrainToGraph, toAutomationBrainPromptContext } from '@/lib/automation/engine';
import type { AutomationBrainResult, PatternMatch, SkillPackActivation, PatternClassification } from '@/lib/automation/types';
import type { WorkflowGraphSummary } from '@/lib/agent/workflow-graph';

// ── test harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${label}`);
    console.error(`       ${(err as Error).message}`);
    failed++;
  }
}

// ── mock factories ──────────────────────────────────────────────────────────

function makeClassification(
  kind: PatternClassification['kind'],
  opts: Partial<PatternClassification> = {}
): PatternClassification {
  return {
    kind,
    providers: [],
    domains: [],
    confidence: 70,
    origin: 'db',
    identityLocked: kind === 'provider_specific',
    lockReason: kind === 'provider_specific' ? 'provider_name_match' : null,
    lockEvidence: kind === 'provider_specific'
      ? [{ signal: opts.providers?.[0] ?? 'unknown', source: 'name', method: 'word_boundary_match', confidence: 95 }]
      : [],
    ...opts,
  };
}

function makePattern(
  name: string,
  tools: string[],
  classification: PatternClassification
): PatternMatch {
  return {
    id: `test-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    category: 'test',
    description: `Test pattern: ${name}`,
    requiredCapabilities: [],
    requiredTools: tools,
    optionalTools: [],
    risk: 'low',
    estimatedCost: 0.01,
    estimatedComplexity: 'simple',
    schedulePatterns: ['Event-driven'],
    examples: [],
    score: 100,
    classification,
  };
}

function makePack(
  name: string,
  tools: string[],
  classification: PatternClassification
): SkillPackActivation {
  return {
    id: `test-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    description: `Test pack: ${name}`,
    tools,
    capabilities: ['send_message'],
    patterns: [],
    matchScore: 80,
    classification,
  };
}

function makeBrain(
  patterns: PatternMatch[],
  packs: SkillPackActivation[]
): AutomationBrainResult {
  return {
    inferredIntent: 'Test automation',
    capabilities: [],
    activatedSkillPacks: packs,
    matchedPatterns: patterns,
    providerResolutions: [],
    composition: {
      blocks: [],
      expectedInputs: [],
      expectedOutputs: [],
      executionFrequency: 'Event-driven',
      risks: [],
      estimatedCostUsd: 0,
      complexity: 'simple',
      latencyEstimateMs: 900,
    },
    constraintContext: {
      requiredProviders: [],
      allowedProviders: [],
      forbiddenProviders: [],
      requiredCapabilities: [],
      forbiddenCapabilities: [],
      executionMode: 'unknown',
      triggerMode: 'unknown',
      actionMode: 'unknown',
      identityLocked: false,
    },
    providerIntentGraph: [],
    credentialIntelligence: [],
  };
}

function makeGraph(providers: string[]): WorkflowGraphSummary {
  return {
    nodes: [
      ...providers.map((p, i) => ({
        id: `node-${i}`,
        type: `${p}.trigger`,
        name: `${p} Trigger`,
        label: `${p} Trigger`,
        displayName: `${p} Trigger`,
        kind: 'trigger' as const,
        provider: p,
        capability: 'receive_message',
        integration: p,
        requiresCredentials: false,
        credentialSchema: [],
        position: [i * 200, 0] as [number, number],
        estimatedCostUsd: 0,
        estimatedLatencyMs: 100,
      })),
    ],
    edges: [],
    executionOrder: providers.map((_, i) => `node-${i}`),
    integrations: providers,
    estimatedLatencyMs: 100,
    estimatedCostUsd: 0,
    retryNodes: [],
    branches: 0,
  };
}

// ── scenario 1: Telegram prompt ─────────────────────────────────────────────

console.log('\nScenario 1: Telegram prompt');

const telegramConstraints = extractHardConstraints(
  'When a new Telegram message arrives, reply with AI'
);

test('requiredProviders includes telegram', () => {
  assert(
    telegramConstraints.requiredProviders.includes('telegram'),
    `Got: ${JSON.stringify(telegramConstraints.requiredProviders)}`
  );
});

test('requiredProviders does not include whatsapp', () => {
  assert(
    !telegramConstraints.requiredProviders.includes('whatsapp'),
    `Got: ${JSON.stringify(telegramConstraints.requiredProviders)}`
  );
});

const telegramIntentGraph = buildProviderIntentGraph(
  'When a new Telegram message arrives, reply with AI'
);

test('providerIntentGraph includes telegram', () => {
  const providers = telegramIntentGraph.map((g) => g.provider);
  assert(providers.includes('telegram'), `Got: ${JSON.stringify(providers)}`);
});

test('providerIntentGraph does not include whatsapp', () => {
  const providers = telegramIntentGraph.map((g) => g.provider);
  assert(!providers.includes('whatsapp'), `Got: ${JSON.stringify(providers)}`);
});

// constrainAutomationBrainToGraph with telegram graph
const telegramBrain = makeBrain(
  [
    makePattern('Telegram Reply Agent', ['telegram'],
      makeClassification('provider_specific', { providers: ['telegram'] })),
    makePattern('WhatsApp Reply Agent', ['whatsapp'],
      makeClassification('provider_specific', { providers: ['whatsapp'] })),
    makePattern('Restaurant Order Handler', ['some_pos_tool'],
      makeClassification('domain_template', { domains: ['restaurant'] })),
    makePattern('Generic Summarizer', [],
      makeClassification('abstract_template')),
  ],
  [
    makePack('Telegram Messaging Pack', ['telegram'],
      makeClassification('provider_specific', { providers: ['telegram'] })),
    makePack('WhatsApp Pack', ['whatsapp'],
      makeClassification('provider_specific', { providers: ['whatsapp'] })),
    makePack('Restaurant Pack', ['some_pos_tool'],
      makeClassification('domain_template', { domains: ['restaurant'] })),
  ]
);

const telegramGraph = makeGraph(['telegram']);
const constrainedTelegram = constrainAutomationBrainToGraph(telegramBrain, telegramGraph);

test('Telegram graph: Telegram Reply Agent preserved', () => {
  assert(
    constrainedTelegram!.matchedPatterns.some((p) => p.name === 'Telegram Reply Agent'),
    `Patterns: ${constrainedTelegram!.matchedPatterns.map((p) => p.name).join(', ')}`
  );
});

test('Telegram graph: WhatsApp pattern dropped', () => {
  assert(
    !constrainedTelegram!.matchedPatterns.some((p) => p.name === 'WhatsApp Reply Agent'),
    `Patterns: ${constrainedTelegram!.matchedPatterns.map((p) => p.name).join(', ')}`
  );
});

test('Telegram graph: Generic Summarizer (abstract_template) preserved', () => {
  assert(
    constrainedTelegram!.matchedPatterns.some((p) => p.name === 'Generic Summarizer'),
    `Patterns: ${constrainedTelegram!.matchedPatterns.map((p) => p.name).join(', ')}`
  );
});

test('Telegram graph: Restaurant Pack dropped (tools not in graph)', () => {
  assert(
    !constrainedTelegram!.activatedSkillPacks.some((p) => p.name === 'Restaurant Pack'),
    `Packs: ${constrainedTelegram!.activatedSkillPacks.map((p) => p.name).join(', ')}`
  );
});

test('Telegram graph: WhatsApp Pack dropped', () => {
  assert(
    !constrainedTelegram!.activatedSkillPacks.some((p) => p.name === 'WhatsApp Pack'),
    `Packs: ${constrainedTelegram!.activatedSkillPacks.map((p) => p.name).join(', ')}`
  );
});

test('Telegram graph: Telegram Messaging Pack preserved', () => {
  assert(
    constrainedTelegram!.activatedSkillPacks.some((p) => p.name === 'Telegram Messaging Pack'),
    `Packs: ${constrainedTelegram!.activatedSkillPacks.map((p) => p.name).join(', ')}`
  );
});

// ── scenario 2: Shopify scheduled prompt ───────────────────────────────────

console.log('\nScenario 2: Shopify scheduled prompt — domain_template enrichment');

const shopifyBrain = makeBrain(
  [
    makePattern('Ecommerce Order Sync', [],  // tools not yet resolved
      makeClassification('domain_template', { domains: ['ecommerce'], providers: [] })),
    makePattern('Shopify Order Importer', ['shopify'],
      makeClassification('provider_specific', { providers: ['shopify'] })),
  ],
  [
    makePack('Ecommerce Domain Pack', [],   // tools not yet resolved
      makeClassification('domain_template', { domains: ['ecommerce'], providers: [] })),
  ]
);

const shopifyGraph = makeGraph(['shopify', 'scheduler']);
const constrainedShopify = constrainAutomationBrainToGraph(shopifyBrain, shopifyGraph);

test('Shopify graph: domain_template with empty tools survives (provider enrichment allowed)', () => {
  assert(
    constrainedShopify!.matchedPatterns.some((p) => p.name === 'Ecommerce Order Sync'),
    `Patterns: ${constrainedShopify!.matchedPatterns.map((p) => p.name).join(', ')}`
  );
});

test('Shopify graph: domain_template pack with empty tools survives', () => {
  assert(
    constrainedShopify!.activatedSkillPacks.some((p) => p.name === 'Ecommerce Domain Pack'),
    `Packs: ${constrainedShopify!.activatedSkillPacks.map((p) => p.name).join(', ')}`
  );
});

test('Shopify graph: provider_specific Shopify pattern preserved', () => {
  assert(
    constrainedShopify!.matchedPatterns.some((p) => p.name === 'Shopify Order Importer'),
    `Patterns: ${constrainedShopify!.matchedPatterns.map((p) => p.name).join(', ')}`
  );
});

// ── scenario 3: Generic summarizer ─────────────────────────────────────────

console.log('\nScenario 3: Generic summarizer — abstract_template survives');

const summarizerBrain = makeBrain(
  [
    makePattern('Summarize Content', [],
      makeClassification('abstract_template')),
    makePattern('WhatsApp Summarizer', ['whatsapp'],
      makeClassification('provider_specific', { providers: ['whatsapp'] })),
  ],
  [
    makePack('Generic AI Pack', [],
      makeClassification('abstract_template')),
  ]
);

const slackGraph = makeGraph(['slack']);
const constrainedSummarizer = constrainAutomationBrainToGraph(summarizerBrain, slackGraph);

test('Slack graph: abstract_template summarizer survives regardless of graph providers', () => {
  assert(
    constrainedSummarizer!.matchedPatterns.some((p) => p.name === 'Summarize Content'),
    `Patterns: ${constrainedSummarizer!.matchedPatterns.map((p) => p.name).join(', ')}`
  );
});

test('Slack graph: abstract_template pack survives', () => {
  assert(
    constrainedSummarizer!.activatedSkillPacks.some((p) => p.name === 'Generic AI Pack'),
    `Packs: ${constrainedSummarizer!.activatedSkillPacks.map((p) => p.name).join(', ')}`
  );
});

test('Slack graph: WhatsApp Summarizer dropped (provider_specific not in Slack allowlist)', () => {
  assert(
    !constrainedSummarizer!.matchedPatterns.some((p) => p.name === 'WhatsApp Summarizer'),
    `Patterns: ${constrainedSummarizer!.matchedPatterns.map((p) => p.name).join(', ')}`
  );
});

// ── scenario 4: sanitizeAutomationBrainForGraph preserves identityLocked ───

console.log('\nScenario 4: sanitizeAutomationBrainForGraph — identityLocked preservation');

const brainWithLockedPack = {
  capabilities: [],
  activatedSkillPacks: [
    {
      name: 'Telegram Locked Pack',
      capabilities: ['scheduling'],   // only scheduling — would normally be stripped
      classification: { identityLocked: true },
    },
    {
      name: 'Unlocked Empty Pack',
      capabilities: ['scheduling'],   // only scheduling, not locked
      classification: { identityLocked: false },
    },
  ],
  matchedPatterns: [],
  composition: { executionFrequency: 'Event-driven' },
};

const sanitized = sanitizeAutomationBrainForGraph(brainWithLockedPack);

test('identityLocked pack preserved after scheduling strip', () => {
  assert(
    sanitized.activatedSkillPacks.some((p) => p.name === 'Telegram Locked Pack'),
    `Packs: ${sanitized.activatedSkillPacks.map((p: { name: string }) => p.name).join(', ')}`
  );
});

test('unlocked empty pack dropped after scheduling strip', () => {
  assert(
    !sanitized.activatedSkillPacks.some((p) => p.name === 'Unlocked Empty Pack'),
    `Packs: ${sanitized.activatedSkillPacks.map((p: { name: string }) => p.name).join(', ')}`
  );
});

// ── scenario 5: toAutomationBrainPromptContext includes classification ──────

console.log('\nScenario 5: toAutomationBrainPromptContext — classification in LLM context');

const contextBrain = makeBrain(
  [
    makePattern('Telegram Reply Agent', ['telegram'],
      makeClassification('provider_specific', { providers: ['telegram'], domains: ['messaging'] })),
    makePattern('Summarize Content', [],
      makeClassification('abstract_template')),
  ],
  [
    makePack('Ecommerce Pack', ['shopify'],   // has tools → appears in context
      makeClassification('domain_template', { domains: ['ecommerce'] })),
  ]
);

const ctx = toAutomationBrainPromptContext(contextBrain);

test('LLM context includes kind for provider_specific pattern', () => {
  assert(ctx.includes('kind:provider_specific'), `Context snippet: ${ctx.slice(0, 400)}`);
});

test('LLM context includes locked:true for identityLocked pattern', () => {
  assert(ctx.includes('locked:true'), `Context snippet: ${ctx.slice(0, 400)}`);
});

test('LLM context includes providers for locked pattern', () => {
  assert(ctx.includes('providers:telegram'), `Context snippet: ${ctx.slice(0, 400)}`);
});

test('LLM context includes domains for domain_template pack', () => {
  assert(ctx.includes('domains:ecommerce'), `Context snippet: ${ctx.slice(0, 400)}`);
});

test('abstract_template pattern without tools is excluded from LLM context', () => {
  assert(!ctx.includes('Summarize Content'), `Context should omit tool-less unlocked patterns: ${ctx.slice(0, 400)}`);
});

// ── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
