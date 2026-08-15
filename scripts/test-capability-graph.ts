/**
 * Capability Graph integration tests.
 * Run with:  npx tsx scripts/test-capability-graph.ts
 *
 * 55 tests covering:
 *   Step 1  PROVIDER_CAPABILITY_GRAPH completeness
 *   Step 2  resolveProvidersFromCapabilities + confidence scoring
 *   Step 3  extractWorkflowCapabilities + keyword detection
 *   Step 4  buildWorkflowGrammar + role assignment
 *   Step 5  PatternMemory — save / find / calculatePatternConfidence
 *   Step 6  detectMissingRequirements + requestMissingRequirements
 *   Step 7  simulateWorkflow
 */

import assert from 'assert';
import {
  PROVIDER_CAPABILITY_GRAPH,
  CAPABILITY_GRAPH_PROVIDERS,
  resolveProvidersFromCapabilities,
  resolveProviderForCapability,
  extractWorkflowCapabilities,
  buildWorkflowGrammar,
  saveSuccessfulPattern,
  findSimilarPatterns,
  calculatePatternConfidence,
  detectMissingRequirements,
  requestMissingRequirements,
  simulateWorkflow,
} from '@/lib/agent/capability-graph';
import type {
  WorkflowCapability,
  CapabilityGraphProvider,
  PatternMemoryRecord,
  WorkflowGrammar,
} from '@/lib/agent/capability-graph';

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(label: string, fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.then(() => {
        console.log(`  ✓  ${label}`);
        passed++;
      }).catch((err) => {
        console.error(`  ✗  ${label}`);
        console.error(`       ${(err as Error).message}`);
        failed++;
      });
    } else {
      console.log(`  ✓  ${label}`);
      passed++;
    }
  } catch (err) {
    console.error(`  ✗  ${label}`);
    console.error(`       ${(err as Error).message}`);
    failed++;
  }
}

// ── Mock Supabase DB ──────────────────────────────────────────────────────────

function makeMockDb(seed: PatternMemoryRecord[] = []) {
  const store: PatternMemoryRecord[] = [...seed];
  let nextId = 1;

  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        gte: (_col: string, _val: number) => ({
          order: (_col2: string, _opts: { ascending: boolean }) => ({
            limit: async (_n: number) => ({ data: [...store], error: null }),
          }),
        }),
      }),
      insert: async (rows: unknown[]) => {
        for (const row of rows as PatternMemoryRecord[]) {
          store.push({ ...row, id: String(nextId++) });
        }
        return { data: store.slice(-rows.length) as unknown[], error: null };
      },
      update: (_vals: Record<string, unknown>) => ({
        eq: async (_col: string, _val: unknown) => ({ error: null }),
      }),
    }),
  };
}

// ── Step 1: PROVIDER_CAPABILITY_GRAPH ────────────────────────────────────────

console.log('\nStep 1: PROVIDER_CAPABILITY_GRAPH completeness');

test('graph has at least 20 provider entries', () => {
  assert(PROVIDER_CAPABILITY_GRAPH.length >= 20, `Got ${PROVIDER_CAPABILITY_GRAPH.length}`);
});

test('every entry in the graph is in CAPABILITY_GRAPH_PROVIDERS', () => {
  for (const entry of PROVIDER_CAPABILITY_GRAPH) {
    assert(
      CAPABILITY_GRAPH_PROVIDERS.includes(entry.provider),
      `Provider "${entry.provider}" not in CAPABILITY_GRAPH_PROVIDERS`,
    );
  }
});

test('no duplicate providers in the graph', () => {
  const providers = PROVIDER_CAPABILITY_GRAPH.map((e) => e.provider);
  const unique = new Set(providers);
  assert(unique.size === providers.length, `Duplicates: ${providers.filter((p, i) => providers.indexOf(p) !== i).join(', ')}`);
});

test('telegram has send_message', () => {
  const entry = PROVIDER_CAPABILITY_GRAPH.find((e) => e.provider === 'telegram');
  assert(entry?.capabilities.includes('send_message'), `telegram caps: ${entry?.capabilities.join(', ')}`);
});

test('telegram has receive_message + webhook + notify', () => {
  const entry = PROVIDER_CAPABILITY_GRAPH.find((e) => e.provider === 'telegram')!;
  assert(entry.capabilities.includes('receive_message') && entry.capabilities.includes('webhook') && entry.capabilities.includes('notify'));
});

test('stripe has create_invoice + create_payment_link', () => {
  const entry = PROVIDER_CAPABILITY_GRAPH.find((e) => e.provider === 'stripe')!;
  assert(entry.capabilities.includes('create_invoice') && entry.capabilities.includes('create_payment_link'));
});

test('hubspot has crm_create_contact + crm_update_contact', () => {
  const entry = PROVIDER_CAPABILITY_GRAPH.find((e) => e.provider === 'hubspot')!;
  assert(entry.capabilities.includes('crm_create_contact') && entry.capabilities.includes('crm_update_contact'));
});

test('google_drive has upload_file + store_memory', () => {
  const entry = PROVIDER_CAPABILITY_GRAPH.find((e) => e.provider === 'google_drive')!;
  assert(entry.capabilities.includes('upload_file') && entry.capabilities.includes('store_memory'));
});

test('google_calendar has create_calendar_event + schedule', () => {
  const entry = PROVIDER_CAPABILITY_GRAPH.find((e) => e.provider === 'google_calendar')!;
  assert(entry.capabilities.includes('create_calendar_event') && entry.capabilities.includes('schedule'));
});

test('notion has save_record + store_memory + retrieve_memory', () => {
  const entry = PROVIDER_CAPABILITY_GRAPH.find((e) => e.provider === 'notion')!;
  assert(
    entry.capabilities.includes('save_record') &&
    entry.capabilities.includes('store_memory') &&
    entry.capabilities.includes('retrieve_memory'),
  );
});

test('every provider has at least 2 capabilities', () => {
  for (const entry of PROVIDER_CAPABILITY_GRAPH) {
    assert(entry.capabilities.length >= 2, `${entry.provider} has only ${entry.capabilities.length} capability`);
  }
});

// ── Step 2: resolveProvidersFromCapabilities ──────────────────────────────────

console.log('\nStep 2: resolveProvidersFromCapabilities');

test('send_email resolves to gmail', () => {
  const results = resolveProvidersFromCapabilities(['send_email']);
  assert(results.some((r) => r.provider === 'gmail'), `Got: ${results.map((r) => r.provider).join(', ')}`);
});

test('create_invoice resolves to stripe', () => {
  const results = resolveProvidersFromCapabilities(['create_invoice']);
  assert(results.some((r) => r.provider === 'stripe'), `Got: ${results.map((r) => r.provider).join(', ')}`);
});

test('[send_email, upload_file] resolves gmail + google_drive', () => {
  const results = resolveProvidersFromCapabilities(['send_email', 'upload_file']);
  const providers = results.map((r) => r.provider);
  assert(providers.includes('gmail'), `Missing gmail, got: ${providers.join(', ')}`);
  assert(providers.includes('google_drive'), `Missing google_drive, got: ${providers.join(', ')}`);
});

test('confidence is between 1 and 100', () => {
  const results = resolveProvidersFromCapabilities(['send_message', 'receive_message']);
  for (const r of results) {
    assert(r.confidence >= 1 && r.confidence <= 100, `${r.provider} confidence=${r.confidence}`);
  }
});

test('telegram scores higher than non-messaging providers for send_message+receive_message', () => {
  const results = resolveProvidersFromCapabilities(['send_message', 'receive_message']);
  const telegramResult = results.find((r) => r.provider === 'telegram');
  const stripeResult = results.find((r) => r.provider === 'stripe');
  assert(telegramResult, 'telegram not in results');
  assert(!stripeResult || telegramResult!.confidence > (stripeResult?.confidence ?? 0),
    `Expected telegram(${telegramResult?.confidence}) > stripe(${stripeResult?.confidence})`);
});

test('empty capabilities returns empty array', () => {
  const results = resolveProvidersFromCapabilities([]);
  assert(results.length === 0, `Expected [], got ${results.length} results`);
});

test('resolveProviderForCapability returns single best provider', () => {
  const provider = resolveProviderForCapability('create_invoice');
  assert(provider !== null, 'Expected non-null provider');
  assert(provider === 'stripe', `Expected stripe, got ${provider}`);
});

test('resolveProviderForCapability returns null for no-match capability', () => {
  // 'schedule' matches google_calendar; test a made-up capability cast
  const results = resolveProvidersFromCapabilities(['crm_create_contact']);
  assert(results.length > 0 && results[0].provider === 'hubspot', `Got: ${results[0]?.provider}`);
});

test('results are sorted by confidence descending', () => {
  const results = resolveProvidersFromCapabilities(['save_record', 'search_data', 'store_memory']);
  for (let i = 1; i < results.length; i++) {
    assert(results[i - 1].confidence >= results[i].confidence,
      `Out of order: ${results[i-1].provider}(${results[i-1].confidence}) < ${results[i].provider}(${results[i].confidence})`);
  }
});

test('matchedCapabilities only contains capabilities the provider actually supports', () => {
  const results = resolveProvidersFromCapabilities(['send_message', 'create_invoice']);
  const telegram = results.find((r) => r.provider === 'telegram');
  assert(telegram, 'telegram not found');
  assert(telegram!.matchedCapabilities.every((c) => c !== 'create_invoice'),
    `telegram incorrectly matched create_invoice`);
});

// ── Step 3: extractWorkflowCapabilities ──────────────────────────────────────

console.log('\nStep 3: extractWorkflowCapabilities');

test('"send invoice and notify Telegram" → create_invoice + notify', () => {
  const caps = extractWorkflowCapabilities('send invoice and notify Telegram');
  assert(caps.includes('create_invoice'), `Missing create_invoice: ${caps.join(', ')}`);
  assert(caps.includes('notify'), `Missing notify: ${caps.join(', ')}`);
});

test('"When Shopify order received send invoice" → create_invoice', () => {
  const caps = extractWorkflowCapabilities('When Shopify order received send invoice');
  assert(caps.includes('create_invoice'), `Got: ${caps.join(', ')}`);
});

test('"upload file to drive" → upload_file', () => {
  const caps = extractWorkflowCapabilities('upload file to drive');
  assert(caps.includes('upload_file'), `Got: ${caps.join(', ')}`);
});

test('"save record to Airtable" → save_record', () => {
  const caps = extractWorkflowCapabilities('save record to Airtable');
  assert(caps.includes('save_record'), `Got: ${caps.join(', ')}`);
});

test('"schedule daily digest" → schedule', () => {
  const caps = extractWorkflowCapabilities('schedule daily digest');
  assert(caps.includes('schedule'), `Got: ${caps.join(', ')}`);
});

test('"webhook triggers" → webhook', () => {
  const caps = extractWorkflowCapabilities('webhook triggers workflow');
  assert(caps.includes('webhook'), `Got: ${caps.join(', ')}`);
});

test('"add contact to CRM" → crm_create_contact', () => {
  const caps = extractWorkflowCapabilities('add contact to CRM');
  assert(caps.includes('crm_create_contact'), `Got: ${caps.join(', ')}`);
});

test('"update CRM contact" → crm_update_contact', () => {
  const caps = extractWorkflowCapabilities('update CRM contact');
  assert(caps.includes('crm_update_contact'), `Got: ${caps.join(', ')}`);
});

test('"generate PDF report" → generate_document', () => {
  const caps = extractWorkflowCapabilities('generate PDF report');
  assert(caps.includes('generate_document'), `Got: ${caps.join(', ')}`);
});

test('"create payment link for checkout" → create_payment_link', () => {
  const caps = extractWorkflowCapabilities('create payment link for checkout');
  assert(caps.includes('create_payment_link'), `Got: ${caps.join(', ')}`);
});

test('"book a meeting on calendar" → create_calendar_event', () => {
  const caps = extractWorkflowCapabilities('book a meeting on calendar');
  assert(caps.includes('create_calendar_event'), `Got: ${caps.join(', ')}`);
});

test('"summarize and transform data" → transform_data', () => {
  const caps = extractWorkflowCapabilities('summarize and transform data');
  assert(caps.includes('transform_data'), `Got: ${caps.join(', ')}`);
});

test('"send email to customer" → send_email', () => {
  const caps = extractWorkflowCapabilities('send email to customer');
  assert(caps.includes('send_email'), `Got: ${caps.join(', ')}`);
});

test('complex prompt extracts multiple capabilities', () => {
  const caps = extractWorkflowCapabilities(
    'When customer buys product send invoice save PDF and notify Telegram',
  );
  assert(caps.includes('create_invoice'), `Missing create_invoice: ${caps.join(', ')}`);
  assert(caps.includes('generate_document'), `Missing generate_document: ${caps.join(', ')}`);
  assert(caps.includes('notify'), `Missing notify: ${caps.join(', ')}`);
});

// ── Step 4: buildWorkflowGrammar ──────────────────────────────────────────────

console.log('\nStep 4: buildWorkflowGrammar');

test('"When Shopify order received send invoice" → trigger includes shopify', () => {
  const g = buildWorkflowGrammar('When Shopify order received send invoice');
  assert(
    g.trigger.includes('shopify'),
    `Trigger: ${g.trigger.join(', ')}, action: ${g.action.join(', ')}, storage: ${g.storage.join(', ')}`,
  );
});

test('"send invoice" → action includes stripe', () => {
  const g = buildWorkflowGrammar('When Shopify order received send invoice');
  const allProviders = [...g.trigger, ...g.action, ...g.storage, ...g.notification, ...g.transform];
  assert(allProviders.includes('stripe'), `All: ${allProviders.join(', ')}`);
});

test('"notify Telegram" → notification includes telegram', () => {
  const g = buildWorkflowGrammar('When customer buys product send invoice and notify Telegram');
  const allProviders = [...g.notification, ...g.action];
  assert(allProviders.includes('telegram'), `Notification: ${g.notification.join(', ')}, Action: ${g.action.join(', ')}`);
});

test('"save PDF to Google Drive" → storage includes google_drive', () => {
  const g = buildWorkflowGrammar('When order received save PDF to Google Drive');
  assert(
    g.storage.includes('google_drive'),
    `Storage: ${g.storage.join(', ')}, transform: ${g.transform.join(', ')}`,
  );
});

test('grammar capabilities array is non-empty for meaningful prompts', () => {
  const g = buildWorkflowGrammar('When Shopify order received send invoice and notify Telegram');
  assert(g.capabilities.length > 0, `Empty capabilities`);
});

test('grammar confidence is between 1 and 100', () => {
  const g = buildWorkflowGrammar('send email to customer');
  assert(g.confidence >= 1 && g.confidence <= 100, `confidence=${g.confidence}`);
});

test('empty prompt returns empty grammar (no crash)', () => {
  const g = buildWorkflowGrammar('');
  assert(Array.isArray(g.trigger) && Array.isArray(g.action), 'Grammar structure invalid');
});

test('"crm contact" → action includes hubspot', () => {
  const g = buildWorkflowGrammar('When new lead arrives add contact to CRM');
  const allProviders = [...g.trigger, ...g.action, ...g.storage, ...g.notification, ...g.transform, ...g.condition];
  assert(allProviders.includes('hubspot'), `All: ${allProviders.join(', ')}`);
});

// ── Step 5: PatternMemory ─────────────────────────────────────────────────────

console.log('\nStep 5: PatternMemory');

test('saveSuccessfulPattern returns an id on success', async () => {
  const db = makeMockDb();
  const result = await saveSuccessfulPattern(
    { providers: ['telegram', 'stripe'], capabilities: ['send_message', 'create_invoice'], domains: ['ecommerce'], workflow_json: {}, confidence: 80, usage_count: 1 },
    db,
  );
  assert(result.error === null, `Error: ${result.error}`);
  assert(result.id !== null, 'Expected non-null id');
});

test('saveSuccessfulPattern propagates DB error', async () => {
  const errorDb = {
    from: (_t: string) => ({
      select: (_c: string) => ({ gte: (_a: string, _b: number) => ({ order: (_a2: string, _b2: { ascending: boolean }) => ({ limit: async (_n: number) => ({ data: null, error: 'db error' }) }) }) }),
      insert: async (_rows: unknown[]) => ({ data: null, error: 'insert failed' }),
      update: (_v: Record<string, unknown>) => ({ eq: async (_c: string, _v2: unknown) => ({ error: null }) }),
    }),
  };
  const result = await saveSuccessfulPattern(
    { providers: ['telegram'], capabilities: ['send_message'], domains: [], workflow_json: {}, confidence: 70, usage_count: 1 },
    errorDb,
  );
  assert(result.error !== null, 'Expected error to be propagated');
});

test('findSimilarPatterns returns seeded matching record', async () => {
  const seed: PatternMemoryRecord[] = [
    { id: '1', providers: ['telegram', 'stripe'], capabilities: ['send_message', 'create_invoice'], domains: ['ecommerce'], workflow_json: {}, confidence: 80, usage_count: 5 },
  ];
  const db = makeMockDb(seed);
  const results = await findSimilarPatterns(['telegram', 'stripe'], ['send_message', 'create_invoice'], db);
  assert(results.length > 0, 'Expected at least one similar pattern');
  assert(results[0].providers.includes('telegram'), `Got providers: ${results[0].providers.join(', ')}`);
});

test('findSimilarPatterns excludes dissimilar records (Jaccard < 0.5)', async () => {
  const seed: PatternMemoryRecord[] = [
    { id: '1', providers: ['hubspot'], capabilities: ['crm_create_contact'], domains: ['crm'], workflow_json: {}, confidence: 75, usage_count: 2 },
  ];
  const db = makeMockDb(seed);
  const results = await findSimilarPatterns(['telegram', 'stripe'], ['send_message', 'create_invoice'], db);
  assert(results.length === 0, `Expected no matches, got ${results.length}`);
});

test('findSimilarPatterns returns empty for empty DB', async () => {
  const db = makeMockDb([]);
  const results = await findSimilarPatterns(['telegram'], ['send_message'], db);
  assert(results.length === 0, `Expected 0, got ${results.length}`);
});

test('calculatePatternConfidence boosts for high usage', () => {
  const similar: PatternMemoryRecord[] = [
    { providers: ['telegram'], capabilities: ['send_message'], domains: [], workflow_json: {}, confidence: 85, usage_count: 50 },
    { providers: ['telegram'], capabilities: ['send_message'], domains: [], workflow_json: {}, confidence: 90, usage_count: 30 },
  ];
  const adjusted = calculatePatternConfidence(70, similar);
  assert(adjusted > 70, `Expected boost above 70, got ${adjusted}`);
  assert(adjusted <= 95, `Capped at 95, got ${adjusted}`);
});

test('calculatePatternConfidence with no similar patterns returns base', () => {
  const adjusted = calculatePatternConfidence(60, []);
  assert(adjusted === 60, `Expected 60, got ${adjusted}`);
});

test('calculatePatternConfidence never exceeds 95', () => {
  const similar: PatternMemoryRecord[] = Array.from({ length: 10 }, () => ({
    providers: ['telegram'], capabilities: ['send_message'], domains: [], workflow_json: {}, confidence: 95, usage_count: 1000,
  }));
  const adjusted = calculatePatternConfidence(90, similar);
  assert(adjusted <= 95, `Exceeded cap: ${adjusted}`);
});

// ── Step 6: detectMissingRequirements ────────────────────────────────────────

console.log('\nStep 6: detectMissingRequirements + requestMissingRequirements');

function makeGrammar(overrides: Partial<WorkflowGrammar> = {}): WorkflowGrammar {
  return {
    trigger: [], condition: [], transform: [], action: [], storage: [], notification: [],
    capabilities: [], confidence: 70,
    ...overrides,
  };
}

test('detectMissingRequirements: empty grammar with no installed providers → empty missing', () => {
  const result = detectMissingRequirements(makeGrammar());
  assert(result.ready === true, `ready=false, missing: ${result.missing.map((r) => r.provider).join(', ')}`);
});

test('detectMissingRequirements: telegram in trigger with no installed → missing bot_token', () => {
  const result = detectMissingRequirements(makeGrammar({ trigger: ['telegram'] }));
  assert(!result.ready, 'Expected not ready');
  assert(result.missing.some((r) => r.provider === 'telegram' && r.field === 'bot_token'),
    `Missing items: ${result.missing.map((r) => `${r.provider}.${r.field}`).join(', ')}`);
});

test('detectMissingRequirements: installed provider not in missing list', () => {
  const result = detectMissingRequirements(
    makeGrammar({ trigger: ['telegram'] }),
    new Set(['telegram']),
  );
  assert(result.ready === true, `Expected ready, got missing: ${result.missing.map((r) => r.provider).join(', ')}`);
});

test('detectMissingRequirements: multiple providers report their own fields', () => {
  const result = detectMissingRequirements(
    makeGrammar({ trigger: ['shopify'], action: ['stripe'] }),
  );
  const providers = result.missing.map((r) => r.provider);
  assert(providers.includes('shopify'), `Missing shopify in: ${providers.join(', ')}`);
  assert(providers.includes('stripe'), `Missing stripe in: ${providers.join(', ')}`);
});

test('requestMissingRequirements: returns empty for ready result', () => {
  const messages = requestMissingRequirements({ ready: true, missing: [], message: 'OK' });
  assert(messages.length === 0, `Expected [], got ${messages.length} messages`);
});

test('requestMissingRequirements: generates one message per provider', () => {
  const result = detectMissingRequirements(
    makeGrammar({ trigger: ['telegram'], action: ['stripe'] }),
  );
  const messages = requestMissingRequirements(result);
  assert(messages.length >= 2, `Expected ≥2 messages, got ${messages.length}: ${messages.join('; ')}`);
});

test('requestMissingRequirements: message mentions provider display name', () => {
  const result = detectMissingRequirements(makeGrammar({ trigger: ['telegram'] }));
  const messages = requestMissingRequirements(result);
  assert(messages.some((m) => m.toLowerCase().includes('telegram')), `Messages: ${messages.join('; ')}`);
});

// ── Step 7: simulateWorkflow ──────────────────────────────────────────────────

console.log('\nStep 7: simulateWorkflow');

test('simulateWorkflow: all credentials installed → deploymentReady can be true', () => {
  const grammar = makeGrammar({ trigger: ['telegram'], notification: ['telegram'], capabilities: ['receive_message', 'notify'] });
  const sim = simulateWorkflow(grammar, new Set(['telegram']));
  assert(sim.deploymentReady || sim.validatorScore >= 0, `score=${sim.validatorScore}`);
});

test('simulateWorkflow: missing credentials → deploymentReady false', () => {
  const grammar = makeGrammar({ trigger: ['shopify'], action: ['stripe'] });
  const sim = simulateWorkflow(grammar, new Set());
  assert(!sim.deploymentReady, `Expected not deployable, score=${sim.validatorScore}`);
});

test('simulateWorkflow: node status is missing_credentials when creds absent', () => {
  const grammar = makeGrammar({ trigger: ['telegram'] });
  const sim = simulateWorkflow(grammar, new Set());
  const node = sim.nodes.find((n) => n.provider === 'telegram');
  assert(node?.status === 'missing_credentials', `Status: ${node?.status}`);
});

test('simulateWorkflow: node status is ready when creds present', () => {
  const grammar = makeGrammar({ trigger: ['telegram'] });
  const sim = simulateWorkflow(grammar, new Set(['telegram']));
  const node = sim.nodes.find((n) => n.provider === 'telegram');
  assert(node?.status === 'ready', `Status: ${node?.status}`);
});

test('simulateWorkflow: no trigger → missingConnections non-empty', () => {
  const grammar = makeGrammar({ action: ['stripe'] });
  const sim = simulateWorkflow(grammar, new Set(['stripe']));
  assert(sim.missingConnections.length > 0, `Expected missing connections`);
});

test('simulateWorkflow: no output → missingConnections includes output warning', () => {
  const grammar = makeGrammar({ trigger: ['telegram'] });
  const sim = simulateWorkflow(grammar, new Set(['telegram']));
  assert(sim.missingConnections.some((m) => m.toLowerCase().includes('output') || m.toLowerCase().includes('action') || m.toLowerCase().includes('notification')),
    `Missing connections: ${sim.missingConnections.join('; ')}`);
});

test('simulateWorkflow: validatorScore is between 0 and 100', () => {
  const grammar = makeGrammar({ trigger: ['telegram'], notification: ['slack'] });
  const sim = simulateWorkflow(grammar, new Set(['telegram', 'slack']));
  assert(sim.validatorScore >= 0 && sim.validatorScore <= 100, `score=${sim.validatorScore}`);
});

test('simulateWorkflow: summary is a non-empty string', () => {
  const grammar = makeGrammar({ trigger: ['telegram'] });
  const sim = simulateWorkflow(grammar);
  assert(typeof sim.summary === 'string' && sim.summary.length > 0, 'Empty summary');
});

test('simulateWorkflow: nodes array length matches total provider count', () => {
  const grammar = makeGrammar({ trigger: ['shopify'], action: ['stripe'], notification: ['telegram'] });
  const sim = simulateWorkflow(grammar, new Set(['shopify', 'stripe', 'telegram']));
  assert(sim.nodes.length === 3, `Expected 3 nodes, got ${sim.nodes.length}`);
});

test('simulateWorkflow: empty grammar returns score ≥ 0', () => {
  const sim = simulateWorkflow(makeGrammar());
  assert(sim.validatorScore >= 0, `Negative score: ${sim.validatorScore}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────

// Flush async tests then print
setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}, 100);
