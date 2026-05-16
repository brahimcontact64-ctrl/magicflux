const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const BASE_URL = 'http://localhost:3000';
const REPORT_PATH = path.join(process.cwd(), 'browser-report.json');
const ENV_PATH = path.join(process.cwd(), '..', '.env.local');
const PROMPTS = [
  {
    slug: 'ecommerce',
    prompt: 'Build an AI chatbot for my ecommerce store that understands product images, answers WhatsApp messages, and creates orders automatically.',
    expectedPattern: 'AI Ecommerce Sales Assistant',
    expectedSkills: ['Ecommerce Core', 'Vision AI', 'WhatsApp Commerce'],
    expectedCapabilities: ['vision_analysis', 'product_recognition', 'order_management'],
    expectedProviders: ['WhatsApp'],
    forbidden: ['Whatsapptrigger', 'Emailsend', 'Openai'],
  },
  {
    slug: 'reddit-leads',
    prompt: 'Build a Reddit lead finder that searches Reddit every morning, summarizes leads with Claude, stores them in Airtable, and sends hot leads to Slack.',
    expectedPattern: 'Reddit Lead Hunter',
    expectedSkills: ['Lead Generation Core', 'Reddit Prospecting', 'Slack Notifications'],
    expectedCapabilities: ['search', 'lead_enrichment', 'ai_scoring'],
    expectedProviders: ['Claude', 'Airtable', 'Slack'],
    forbidden: ['Whatsapptrigger', 'Emailsend', 'Openai'],
  },
  {
    slug: 'restaurant',
    prompt: 'Build an AI restaurant assistant that reads WhatsApp voice notes, creates orders, alerts the kitchen, and sends weekly reports.',
    expectedPattern: 'Restaurant Voice Ordering System',
    expectedSkills: ['Restaurant Core', 'Voice AI', 'Reporting Ops'],
    expectedCapabilities: ['speech_to_text', 'audio_processing', 'reporting'],
    expectedProviders: ['WhatsApp', 'Deepgram', 'Email'],
    forbidden: ['Whatsapptrigger', 'Emailsend', 'Openai'],
  },
];

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

function includesAll(text, items) {
  return items.every((item) => text.includes(item));
}

function includesNone(text, items) {
  return items.every((item) => !text.includes(item));
}

async function latestAssistantBlock(page) {
  return await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('div')).filter((el) =>
      (el.textContent || '').includes('Automation intelligence')
    );

    if (cards.length === 0) {
      return { count: 0, text: '', pageText: document.body.innerText || '' };
    }

    const card = cards[cards.length - 1];
    const container = card.parentElement;
    return {
      count: cards.length,
      text: container ? container.innerText : (card.textContent || ''),
      pageText: document.body.innerText || '',
    };
  });
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
      onboarding_complete: true,
    },
    { onConflict: 'id' }
  );
}

async function ensureAuthenticated(page, email, password) {
  await createUser(email, password);
  console.log(`[AUTH] Created user: ${email}`);
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  console.log(`[AUTH] Navigated to /login`);
  await page.locator('input[type="email"]').fill(email);
  console.log(`[AUTH] Filled email`);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  console.log(`[AUTH] Filled password`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  console.log(`[AUTH] Clicked Sign in button`);
  await page.waitForURL(/.*\/builder/, { timeout: 60000 });
  console.log(`[AUTH] Navigated to /builder`);
  await page.waitForSelector('textarea[placeholder="What do you want to automate today?"]', { timeout: 30000 });
  console.log(`[AUTH] Found textarea`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  const page = await context.newPage();
  const email = `browser-${Date.now()}@magicflux.local`;
  const password = 'MagicFlux!123456';
  const results = [];

  try {
    await ensureAuthenticated(page, email, password);

    for (const scenario of PROMPTS) {
      console.log(`[TEST] Starting: ${scenario.slug}`);
      const before = await latestAssistantBlock(page);
      const input = page.getByPlaceholder('What do you want to automate today?');
      await input.fill(scenario.prompt);
      await input.press('Enter');
      console.log(`[TEST] Prompt sent`);

      await page.waitForFunction(
        ({ previousCount }) => {
          const cards = Array.from(document.querySelectorAll('div')).filter((el) =>
            (el.textContent || '').includes('Automation intelligence')
          );
          if (cards.length <= previousCount) return false;
          const card = cards[cards.length - 1];
          const text = card.parentElement ? card.parentElement.innerText : (card.textContent || '');
          return text.includes('Workflow summary') && text.includes('Approve + Deploy');
        },
        { previousCount: before.count },
        { timeout: 180000 }
      );
      console.log(`[TEST] Response received`);

      const current = await latestAssistantBlock(page);
      const checks = {
        pattern: current.text.includes(scenario.expectedPattern),
        skillPacks: includesAll(current.text, scenario.expectedSkills),
        capabilities: includesAll(current.text, scenario.expectedCapabilities),
        providers: includesAll(current.text, scenario.expectedProviders),
        providerNormalization: includesNone(current.text, scenario.forbidden),
        graphVisible: current.text.includes('Live Workflow Builder'),
        workflowSummaryVisible: current.text.includes('Workflow summary'),
        deployVisible: current.text.includes('Approve + Deploy'),
        noRawLeakage: !/workflow_json|provider_metadata|execution_id|queue_job_id/i.test(current.pageText),
      };
      console.log(`[TEST] Checks: ${JSON.stringify(Object.keys(checks).filter((k) => !checks[k]))}`);

      await page.screenshot({ path: path.join(process.cwd(), `${scenario.slug}.png`), fullPage: true });
      console.log(`[TEST] Screenshot taken: ${scenario.slug}.png`);

      await page.reload({ waitUntil: 'domcontentloaded' });
      console.log(`[TEST] Page reloaded`);
      await page.waitForFunction(() => (document.body.innerText || '').includes('Workflow summary'), { timeout: 60000 });
      console.log(`[TEST] Workflow summary found after reload`);

      const afterReload = await latestAssistantBlock(page);
      checks.graphPersistsAfterReload = afterReload.text.includes('Live Workflow Builder');
      checks.patternPersistsAfterReload = afterReload.text.includes(scenario.expectedPattern);

      results.push({
        slug: scenario.slug,
        prompt: scenario.prompt,
        checks,
        pass: Object.values(checks).every(Boolean),
        excerpt: current.text.slice(0, 1400),
        excerptAfterReload: afterReload.text.slice(0, 600),
      });
      console.log(`[TEST] Completed: ${scenario.slug}, pass=${Object.values(checks).every(Boolean)}`);
    }

    fs.writeFileSync(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
    console.log(JSON.stringify({ report: REPORT_PATH, summary: { total: results.length, passed: results.filter((r) => r.pass).length } }, null, 2));
  } catch (error) {
    console.error(`[ERROR] ${error.message || error}`);
    fs.writeFileSync(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), error: String(error && error.stack ? error.stack : error) }, null, 2));
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
