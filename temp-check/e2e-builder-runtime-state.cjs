const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const BASE_URL = 'http://localhost:3000';
const ENV_PATH = path.join(__dirname, '..', '.env.local');
const REPORT_PATH = path.join(__dirname, '..', 'builder-runtime-state-e2e-report.json');
const PROMPT =
  'Build an AI restaurant assistant that reads WhatsApp voice notes, creates orders, alerts the kitchen, and sends weekly reports.';

function loadEnv(filePath) {
  const env = {};
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function createUser(email, password) {
  const env = loadEnv(ENV_PATH);
  const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: 'admin' },
    app_metadata: { role: 'admin' },
  });

  if (created.error || !created.data.user?.id) {
    throw new Error(`createUser failed: ${created.error?.message || 'unknown'}`);
  }

  const userId = created.data.user.id;
  await service.from('user_profiles').upsert(
    {
      id: userId,
      email,
      plan: 'pro',
      role: 'admin',
      upgraded_at: new Date().toISOString(),
      onboarding_complete: true,
    },
    { onConflict: 'id' }
  );

  await service.from('subscriptions').upsert(
    {
      user_id: userId,
      status: 'active',
      plan: 'pro',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
}

function attachPageMonitors(page, events) {
  page.on('pageerror', (err) => {
    events.push({ type: 'pageerror', message: String(err) });
  });
  page.on('console', (msg) => {
    const text = msg.text();
    const isHydration = /hydration|did not match|server HTML|text content does not match/i.test(text);
    if (msg.type() === 'error' || isHydration) {
      events.push({ type: `console:${msg.type()}`, message: text });
    }
  });
}

async function ensureAuthenticated(page, email, password) {
  await createUser(email, password);
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  const started = Date.now();
  while (Date.now() - started < 120000) {
    if ((await page.locator('textarea[placeholder="What do you want to automate today?"]').count()) > 0) {
      return;
    }
    const url = page.url();
    if (!/\/builder/.test(url)) {
      await page.goto(`${BASE_URL}/builder`, { waitUntil: 'domcontentloaded' });
    }
    if ((await page.locator('textarea[placeholder="What do you want to automate today?"]').count()) > 0) {
      return;
    }
    await page.waitForTimeout(500);
  }

  throw new Error('Authentication did not reach builder textarea in time.');
}

function extractLine(text, prefix) {
  const line = text.split('\n').find((entry) => entry.trim().startsWith(prefix));
  return line ? line.trim() : '';
}

function collectSnapshotFromText(text) {
  const has = (needle) => text.includes(needle);

  const surfaces = {
    graph: has('Creating workflow graph') || has('Automation graph is being assembled'),
    providerCards: has('Configure Deepgram') && has('Configure Email') && has('Configure WhatsApp'),
    automationIntelligence: has('Automation intelligence') && has('Pattern: Restaurant Voice Ordering System'),
    summary: has('Workflow summary') && has('Nodes:') && has('Triggers:'),
    deployState: has('Deploy action') && has('Approve + Deploy'),
    approvalState: has('Approve + Deploy'),
    conversation: has('Build an AI restaurant assistant that reads WhatsApp voice notes'),
  };

  const fingerprint = {
    pattern: extractLine(text, 'Pattern:'),
    skillPacks: extractLine(text, 'Skill packs:'),
    capabilities: extractLine(text, 'Capabilities:'),
    nodes: extractLine(text, 'Nodes:'),
    triggers: extractLine(text, 'Triggers:'),
    actions: extractLine(text, 'Actions:'),
    branches: extractLine(text, 'Branches:'),
    deployLabel: extractLine(text, 'Deploy action'),
    approveLabel: text.includes('Approve + Deploy'),
    providerLabels: ['Configure Deepgram', 'Configure Email', 'Configure WhatsApp'].filter((label) => text.includes(label)),
  };

  return { surfaces, fingerprint };
}

async function waitForSnapshot(page, timeoutMs = 120000) {
  const started = Date.now();
  let last = { surfaces: {}, fingerprint: {} };

  while (Date.now() - started < timeoutMs) {
    const text = await page.locator('body').innerText();
    last = collectSnapshotFromText(text);
    const allPresent = Object.values(last.surfaces).every(Boolean);
    if (allPresent) {
      return { ...last, textLength: text.length, ready: true };
    }
    await page.waitForTimeout(500);
  }

  const text = await page.locator('body').innerText();
  last = collectSnapshotFromText(text);
  return { ...last, textLength: text.length, ready: false };
}

function snapshotDrift(base, current) {
  const changed = [];
  for (const key of Object.keys(base.surfaces)) {
    if (base.surfaces[key] !== current.surfaces[key]) changed.push(`surfaces.${key}`);
  }
  for (const key of Object.keys(base.fingerprint)) {
    const left = JSON.stringify(base.fingerprint[key]);
    const right = JSON.stringify(current.fingerprint[key]);
    if (left !== right) changed.push(`fingerprint.${key}`);
  }
  return changed;
}

async function generateWorkflow(page) {
  const newChatBtn = page.getByRole('button', { name: /new chat/i });
  if (await newChatBtn.count()) {
    await newChatBtn.first().click();
    await page.waitForTimeout(200);
  }

  const input = page.getByPlaceholder('What do you want to automate today?');
  await input.fill(PROMPT);
  await input.press('Enter');

  return waitForSnapshot(page, 180000);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  const events = [];
  const now = Date.now();
  const email = `runtime-state-${now}@magicflux.local`;
  const password = 'MagicFlux!123456';

  const report = {
    generatedAt: new Date().toISOString(),
    scenario: 'Generate -> Reload x10 -> New Tab -> Close -> Reopen',
    checks: {},
    baseline: null,
    reloadCycles: [],
    newTab: null,
    reopen: null,
    errors: {
      runtimeCrashes: 0,
      hydrationMismatches: 0,
      messages: [],
    },
    summary: {
      pass: false,
      zeroDrift: false,
      zeroRestoreFailures: false,
      zeroRuntimeCrashes: false,
      zeroHydrationMismatches: false,
    },
  };

  try {
    let page = await context.newPage();
    attachPageMonitors(page, events);

    await ensureAuthenticated(page, email, password);

    const baseline = await generateWorkflow(page);
    report.baseline = baseline;

    for (let i = 1; i <= 10; i++) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const cycle = await waitForSnapshot(page, 90000);
      const drift = snapshotDrift(baseline, cycle);
      report.reloadCycles.push({ cycle: i, ready: cycle.ready, drift, surfaces: cycle.surfaces, fingerprint: cycle.fingerprint });
    }

    const pageNewTab = await context.newPage();
    attachPageMonitors(pageNewTab, events);
    await pageNewTab.goto(`${BASE_URL}/builder`, { waitUntil: 'domcontentloaded' });
    report.newTab = await waitForSnapshot(pageNewTab, 90000);

    await page.close();
    const pageReopen = await context.newPage();
    attachPageMonitors(pageReopen, events);
    await pageReopen.goto(`${BASE_URL}/builder`, { waitUntil: 'domcontentloaded' });
    report.reopen = await waitForSnapshot(pageReopen, 90000);

    const hydrationEvents = events.filter((event) => /hydration|did not match|server html|text content does not match/i.test(event.message));
    const runtimeCrashEvents = events.filter((event) => event.type === 'pageerror');

    report.errors.runtimeCrashes = runtimeCrashEvents.length;
    report.errors.hydrationMismatches = hydrationEvents.length;
    report.errors.messages = events.slice(0, 50);

    const baselineAllTrue = Object.values(baseline.surfaces).every(Boolean);
    const noCycleDrift = report.reloadCycles.every((cycle) => cycle.ready && cycle.drift.length === 0);
    const newTabNoDrift = report.newTab.ready && snapshotDrift(baseline, report.newTab).length === 0;
    const reopenNoDrift = report.reopen.ready && snapshotDrift(baseline, report.reopen).length === 0;

    report.checks = {
      baselineAllTrue,
      reloadCyclesNoDrift: noCycleDrift,
      newTabNoDrift,
      reopenNoDrift,
      runtimeCrashesZero: report.errors.runtimeCrashes === 0,
      hydrationMismatchesZero: report.errors.hydrationMismatches === 0,
    };

    report.summary.zeroDrift = noCycleDrift && newTabNoDrift && reopenNoDrift;
    report.summary.zeroRestoreFailures = baseline.ready && report.newTab.ready && report.reopen.ready;
    report.summary.zeroRuntimeCrashes = report.errors.runtimeCrashes === 0;
    report.summary.zeroHydrationMismatches = report.errors.hydrationMismatches === 0;
    report.summary.pass =
      baselineAllTrue &&
      report.summary.zeroDrift &&
      report.summary.zeroRestoreFailures &&
      report.summary.zeroRuntimeCrashes &&
      report.summary.zeroHydrationMismatches;

    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');

    if (!report.summary.pass) {
      console.error('Builder runtime-state E2E FAILED. See builder-runtime-state-e2e-report.json');
      process.exit(1);
    }

    console.log('Builder runtime-state E2E PASSED.');
  } catch (error) {
    const fallback = {
      generatedAt: new Date().toISOString(),
      summary: {
        pass: false,
      },
      error: error instanceof Error ? error.message : String(error),
    };
    fs.writeFileSync(REPORT_PATH, JSON.stringify(fallback, null, 2), 'utf8');
    console.error(error);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();