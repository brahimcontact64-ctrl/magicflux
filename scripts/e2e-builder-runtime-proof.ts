/**
 * E2E Builder Runtime Proof (auth-isolated)
 *
 * Flow:
 * 1. Create disposable E2E session via dev endpoint
 * 2. Inject auth session into browser context
 * 3. Open /builder and run runtime proof
 * 4. Cleanup disposable test user in finally block
 */

import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import type { BuilderRuntimeState } from '@/lib/builder/runtime-state';
import { validateRuntimeState } from '@/lib/builder/runtime-state';
import {
  compareBuilderSnapshots,
  createBuilderSnapshot,
  createProofArtifact,
  validateBuilderSurface,
  type BuilderSnapshot,
  type SurfaceValidation,
} from '@/lib/testing/builder-proof';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const REPORT_PATH = path.join(process.cwd(), 'builder-runtime-proof.json');
const PROMPT =
  'Build an AI restaurant assistant that reads WhatsApp voice notes, creates orders, alerts the kitchen, and sends weekly reports.';
const RUNTIME_PERSIST_KEY = 'magicflux.builder.runtime_state';
const TOTAL_RELOAD_CYCLES = 10;

type E2ESessionResponse = {
  access_token: string;
  refresh_token: string;
  test_user: {
    id: string;
    email: string;
    cleanup_after: string;
  };
};

type ConsoleEvent = { type: string; message: string };
type RenderMonitor = {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
};

type BaseUrlPreflight = {
  baseUrl: string;
  builderStatus: number;
  loaderOnly: boolean;
  assets: Array<{ path: string; status: number }>;
};

const REQUIRED_ASSET_PATHS = [
  '/_next/static/css/app/layout.css',
  '/_next/static/chunks/main-app.js',
] as const;

function isLoaderOnlyBuilderBody(body: string): boolean {
  const normalized = body.toLowerCase();
  const hasPrimaryBuilderUi =
    normalized.includes('what do you want to automate today?')
    || normalized.includes('magicflux')
    || normalized.includes('ready to build something?');
  const hasLoaderSignal =
    normalized.includes('loading')
    || normalized.includes('animate-spin')
    || normalized.includes('loader');

  return !hasPrimaryBuilderUi && hasLoaderSignal;
}

async function validateBaseUrlPreflight(): Promise<BaseUrlPreflight> {
  const trimmedBaseUrl = BASE_URL.trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(trimmedBaseUrl)) {
    throw new Error(`BASE_URL must start with http:// or https://, received: ${BASE_URL}`);
  }

  const builderResponse = await fetch(`${trimmedBaseUrl}/builder`, { method: 'GET' });
  const builderBody = await builderResponse.text().catch(() => '');
  const loaderOnly = isLoaderOnlyBuilderBody(builderBody);

  const assetStatuses: BaseUrlPreflight['assets'] = [];
  for (const assetPath of REQUIRED_ASSET_PATHS) {
    const response = await fetch(`${trimmedBaseUrl}${assetPath}`, { method: 'GET' });
    assetStatuses.push({ path: assetPath, status: response.status });
  }

  if (builderResponse.status !== 200) {
    throw new Error(`BASE_URL preflight failed: GET /builder returned ${builderResponse.status} for ${trimmedBaseUrl}`);
  }

  if (loaderOnly) {
    throw new Error(`BASE_URL preflight failed: /builder appears loader-only at ${trimmedBaseUrl}`);
  }

  const missingAsset = assetStatuses.find((asset) => asset.status === 404);
  if (missingAsset) {
    throw new Error(
      `BASE_URL preflight failed: required asset returned 404 (${missingAsset.path}) at ${trimmedBaseUrl}`
    );
  }

  return {
    baseUrl: trimmedBaseUrl,
    builderStatus: builderResponse.status,
    loaderOnly,
    assets: assetStatuses,
  };
}

function getSupabaseAuthStorageKey(): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required');

  const host = new URL(supabaseUrl).hostname;
  const projectRef = host.split('.')[0];
  if (!projectRef) throw new Error('Could not derive Supabase project ref from NEXT_PUBLIC_SUPABASE_URL');

  return `sb-${projectRef}-auth-token`;
}

async function createE2ESession(): Promise<E2ESessionResponse> {
  const response = await fetch(`${BASE_URL}/api/dev/e2e-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  const payload = (await response.json().catch(() => ({}))) as
    | E2ESessionResponse
    | { error?: string };

  if (!response.ok) {
    throw new Error(`Failed to create E2E session: ${(payload as { error?: string }).error ?? response.statusText}`);
  }

  const session = payload as E2ESessionResponse;
  if (!session.access_token || !session.refresh_token || !session.test_user?.id) {
    throw new Error('Invalid E2E session payload');
  }

  return session;
}

async function cleanupE2ESession(userId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/dev/e2e-session`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Cleanup failed with status ${response.status}`);
  }
}

async function injectAuthSession(context: any, session: E2ESessionResponse): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;

  const authPayload = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    user: {
      id: session.test_user.id,
      email: session.test_user.email,
      app_metadata: { role: 'admin', e2e_disposable: true },
      user_metadata: { role: 'admin', e2e_disposable: true },
      aud: 'authenticated',
    },
  };

  await context.addCookies([
    {
      name: 'mf_access_token',
      value: encodeURIComponent(session.access_token),
      url: BASE_URL,
      httpOnly: false,
      sameSite: 'Lax',
    },
  ]);

  await context.addInitScript(
    ({ key, value }: { key: string; value: unknown }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    },
    { key: storageKey, value: authPayload }
  );
}

function attachPageMonitors(page: any, events: ConsoleEvent[], renderMonitor: RenderMonitor): void {
  page.on('pageerror', (error: Error) => {
    const message = String(error);
    events.push({ type: 'pageerror', message });
    renderMonitor.pageErrors.push(message);
  });

  page.on('console', (msg: any) => {
    const text = msg.text();
    const isHydration = /hydration|did not match|server html|text content does not match/i.test(text);
    if (msg.type() === 'error' || isHydration) {
      events.push({ type: `console:${msg.type()}`, message: text });
      renderMonitor.consoleErrors.push(text);
    }
  });

  page.on('requestfailed', (request: any) => {
    const failure = request.failure();
    const message = `${request.method()} ${request.url()} :: ${failure?.errorText ?? 'requestfailed'}`;
    events.push({ type: 'requestfailed', message });
    renderMonitor.failedRequests.push(message);
  });
}

async function readBuilderRuntimeState(page: any): Promise<BuilderRuntimeState> {
  const raw = await page.evaluate((storageKey: string) => {
    return window.localStorage.getItem(storageKey);
  }, RUNTIME_PERSIST_KEY);

  if (!raw) {
    throw new Error('Runtime state is missing from localStorage');
  }

  const parsed = JSON.parse(raw) as unknown;
  const validated = validateRuntimeState(parsed);
  if (!validated.success) {
    throw new Error(`Runtime state validation failed: ${validated.error}`);
  }

  return validated.data;
}

async function waitForBuilderReady(page: any, timeoutMs = 90_000): Promise<void> {
  try {
    await page.waitForSelector('textarea[placeholder="What do you want to automate today?"]', {
      timeout: timeoutMs,
    });
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const bodyText = (document.body?.innerText ?? '').slice(0, 2000);
      const htmlExcerpt = (document.body?.innerHTML ?? '').slice(0, 3000);
      const textareaPlaceholders = Array.from(document.querySelectorAll('textarea'))
        .map((el) => el.getAttribute('placeholder') ?? '')
        .filter(Boolean);
      const inputPlaceholders = Array.from(document.querySelectorAll('input'))
        .map((el) => el.getAttribute('placeholder') ?? '')
        .filter(Boolean);
      const buttonLabels = Array.from(document.querySelectorAll('button'))
        .map((el) => (el.textContent ?? '').trim())
        .filter(Boolean);
      const authLocalStorageKeys = Object.keys(window.localStorage).filter((key) =>
        /supabase|sb-.*-auth-token|auth/i.test(key)
      );
      const nextDataExists = Boolean((window as any).__NEXT_DATA__);
      const readyState = document.readyState;
      const nextRootExists = Boolean(document.querySelector('#__next'));
      const focusBoundaryExists = Boolean(document.querySelector('[data-nextjs-scroll-focus-boundary]'));
      const counts = {
        div: document.querySelectorAll('div').length,
        section: document.querySelectorAll('section').length,
        main: document.querySelectorAll('main').length,
        script: document.querySelectorAll('script').length,
      };

      return {
        url: window.location.href,
        title: document.title,
        readyState,
        nextDataExists,
        bodyText,
        htmlExcerpt,
        textareaPlaceholders,
        inputPlaceholders,
        buttonLabels,
        authLocalStorageKeys,
        nextRootExists,
        focusBoundaryExists,
        counts,
      };
    });

    const cookieNames = Array.from(new Set((await page.context().cookies()).map((cookie: { name: string }) => cookie.name)));
    const monitor = (page.__renderMonitor ?? {
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
    }) as RenderMonitor;
    const firstRenderFailureSignal =
      monitor.pageErrors[0]
      ?? monitor.failedRequests[0]
      ?? monitor.consoleErrors[0]
      ?? 'No console/page/request failure captured before selector timeout';
    const path = (() => {
      try {
        return new URL(diagnostics.url).pathname;
      } catch {
        return '';
      }
    })();
    const routeKind =
      path.startsWith('/login')
        ? 'login'
        : path.startsWith('/builder')
          ? 'builder'
          : path.startsWith('/dashboard')
            ? 'dashboard'
            : /error|not found|exception/i.test(`${diagnostics.title} ${diagnostics.bodyText}`)
              ? 'error'
              : 'unknown';

    console.error('E2E_BUILDER_READY_DIAGNOSTICS', JSON.stringify({
      currentUrl: diagnostics.url,
      title: diagnostics.title,
      readyState: diagnostics.readyState,
      nextDataExists: diagnostics.nextDataExists,
      bodyExcerpt: diagnostics.bodyText,
      htmlExcerpt: diagnostics.htmlExcerpt,
      textareaPlaceholders: diagnostics.textareaPlaceholders,
      inputPlaceholders: diagnostics.inputPlaceholders,
      buttonLabels: diagnostics.buttonLabels,
      routeKind,
      authLocalStorageKeys: diagnostics.authLocalStorageKeys,
      cookieNames,
      rootElementExists: diagnostics.nextRootExists,
      scrollFocusBoundaryExists: diagnostics.focusBoundaryExists,
      counts: diagnostics.counts,
      consoleErrors: monitor.consoleErrors,
      pageErrors: monitor.pageErrors,
      failedRequests: monitor.failedRequests,
      firstRenderFailureSignal,
    }));

    throw error;
  }
}

async function generateWorkflowAndSnapshot(page: any): Promise<BuilderSnapshot> {
  const newChatButton = page.getByRole('button', { name: /new chat/i });
  if (await newChatButton.count()) {
    await newChatButton.first().click();
  }

  const input = page.getByPlaceholder('What do you want to automate today?');
  await input.fill(PROMPT);
  await input.press('Enter');

  const start = Date.now();
  while (Date.now() - start < 180_000) {
    try {
      const state = await readBuilderRuntimeState(page);
      const snapshot = createBuilderSnapshot(state);
      if (snapshot.graphHash && snapshot.conversationHash && snapshot.providerHash) {
        return snapshot;
      }
    } catch {
      // Keep polling until timeout.
    }
    await page.waitForTimeout(750);
  }

  throw new Error('Timed out waiting for initial runtime snapshot after workflow generation');
}

function countObjectLeakage(items: unknown[]): number {
  let leakage = 0;
  for (const item of items) {
    if (JSON.stringify(item).includes('[object Object]')) leakage += 1;
  }
  return leakage;
}

async function run(): Promise<void> {
  const preflight = await validateBaseUrlPreflight();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  const events: ConsoleEvent[] = [];
  const renderMonitor: RenderMonitor = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };
  let e2eSession: E2ESessionResponse | null = null;
  let exitCode = 0;
  let proofPayload: ReturnType<typeof createProofArtifact> | null = null;

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: preflight.baseUrl,
    preflight,
    scenario: 'create-session -> inject-auth -> /builder -> generate -> reload x10 -> new tab -> reopen',
    auth: {
      source: 'api/dev/e2e-session',
      injected: false,
      testUserId: '',
      testUserEmail: '',
      cleanupAttempted: false,
      cleanupSucceeded: false,
    },
    baseline: null as BuilderSnapshot | null,
    reloads: [] as Array<{ cycle: number; comparison: ReturnType<typeof compareBuilderSnapshots> | null }>,
    newTab: null as ReturnType<typeof compareBuilderSnapshots> | null,
    reopen: null as ReturnType<typeof compareBuilderSnapshots> | null,
    surfaceValidations: [] as SurfaceValidation[],
    errors: {
      runtimeCrashes: 0,
      hydrationMismatches: 0,
      objectLeakage: 0,
      messages: [] as string[],
    },
    summary: {
      pass: false,
      reason: '',
    },
  };

  try {
    e2eSession = await createE2ESession();
    report.auth.testUserId = e2eSession.test_user.id;
    report.auth.testUserEmail = e2eSession.test_user.email;

    await injectAuthSession(context, e2eSession);
    report.auth.injected = true;

    let page = await context.newPage();
    page.__renderMonitor = renderMonitor;
    attachPageMonitors(page, events, renderMonitor);

    await page.goto(`${BASE_URL}/builder`, { waitUntil: 'domcontentloaded' });
    await waitForBuilderReady(page);

    const baseline = await generateWorkflowAndSnapshot(page);
    report.baseline = baseline;
    report.surfaceValidations.push(await validateBuilderSurface(page));

    const cycleSnapshots: BuilderSnapshot[] = [];

    for (let cycle = 1; cycle <= TOTAL_RELOAD_CYCLES; cycle += 1) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForBuilderReady(page);
      const state = await readBuilderRuntimeState(page);
      const snapshot = createBuilderSnapshot(state);
      cycleSnapshots.push(snapshot);
      report.reloads.push({
        cycle,
        comparison: compareBuilderSnapshots(baseline, snapshot),
      });
      report.surfaceValidations.push(await validateBuilderSurface(page));
    }

    const newTabPage = await context.newPage();
    newTabPage.__renderMonitor = renderMonitor;
    attachPageMonitors(newTabPage, events, renderMonitor);
    await newTabPage.goto(`${BASE_URL}/builder`, { waitUntil: 'domcontentloaded' });
    await waitForBuilderReady(newTabPage);
    const newTabSnapshot = createBuilderSnapshot(await readBuilderRuntimeState(newTabPage));
    report.newTab = compareBuilderSnapshots(baseline, newTabSnapshot);
    report.surfaceValidations.push(await validateBuilderSurface(newTabPage));

    await page.close();

    const reopenedPage = await context.newPage();
    reopenedPage.__renderMonitor = renderMonitor;
    attachPageMonitors(reopenedPage, events, renderMonitor);
    await reopenedPage.goto(`${BASE_URL}/builder`, { waitUntil: 'domcontentloaded' });
    await waitForBuilderReady(reopenedPage);
    const reopenSnapshot = createBuilderSnapshot(await readBuilderRuntimeState(reopenedPage));
    report.reopen = compareBuilderSnapshots(baseline, reopenSnapshot);
    report.surfaceValidations.push(await validateBuilderSurface(reopenedPage));

    const hydrationEvents = events.filter((event) =>
      /hydration|did not match|server html|text content does not match/i.test(event.message)
    );
    const runtimeCrashEvents = events.filter((event) => event.type === 'pageerror');

    report.errors.runtimeCrashes = runtimeCrashEvents.length;
    report.errors.hydrationMismatches = hydrationEvents.length;
    report.errors.messages = events.slice(0, 50).map((event) => event.message);
    report.errors.objectLeakage = countObjectLeakage([
      baseline,
      ...cycleSnapshots,
      newTabSnapshot,
      reopenSnapshot,
      ...report.errors.messages,
    ]);

    const proof = createProofArtifact(
      baseline,
      [...cycleSnapshots, newTabSnapshot, reopenSnapshot],
      report.surfaceValidations,
      {
        crashes: runtimeCrashEvents.map((event) => event.message),
        hydrationMismatches: hydrationEvents.map((event) => event.message),
        objectLeakage:
          report.errors.objectLeakage > 0
            ? [`Detected ${report.errors.objectLeakage} object leakage signatures.`]
            : [],
      }
    );
    proofPayload = proof;

    const zeroDrift = report.reloads.every((entry) => entry.comparison && !entry.comparison.drift)
      && report.newTab !== null
      && !report.newTab.drift
      && report.reopen !== null
      && !report.reopen.drift;

    const zeroCrashes = report.errors.runtimeCrashes === 0;
    const zeroHydrationMismatches = report.errors.hydrationMismatches === 0;
    const zeroObjectLeakage = report.errors.objectLeakage === 0;
    const surfacesHealthy = report.surfaceValidations.every((surface) => surface.allSurfacesPresent);

    report.summary.pass =
      proof.status === 'PASS'
      && zeroDrift
      && zeroCrashes
      && zeroHydrationMismatches
      && zeroObjectLeakage
      && surfacesHealthy;

    report.summary.reason = report.summary.pass
      ? 'PASS: deterministic runtime proof completed with zero drift and zero auth UI coupling'
      : `FAIL: ${[
          !zeroDrift ? 'drift detected' : '',
          !zeroCrashes ? 'runtime crashes detected' : '',
          !zeroHydrationMismatches ? 'hydration mismatches detected' : '',
          !zeroObjectLeakage ? '[object Object] leakage detected' : '',
          !surfacesHealthy ? 'surface validation failed' : '',
        ]
          .filter(Boolean)
          .join(', ')}`;

    fs.writeFileSync(
      REPORT_PATH,
      JSON.stringify({ ...report, proof }, null, 2),
      'utf8'
    );

    if (!report.summary.pass) {
      exitCode = 1;
    }
  } catch (error) {
    report.summary.pass = false;
    report.summary.reason = error instanceof Error ? error.message : String(error);
    report.errors.messages.push(report.summary.reason);
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
    console.error(error);
    exitCode = 1;
  } finally {
    if (e2eSession?.test_user.id) {
      report.auth.cleanupAttempted = true;
      try {
        await cleanupE2ESession(e2eSession.test_user.id);
        report.auth.cleanupSucceeded = true;
      } catch (error) {
        report.auth.cleanupSucceeded = false;
        report.errors.messages.push(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    fs.writeFileSync(
      REPORT_PATH,
      JSON.stringify(proofPayload ? { ...report, proof: proofPayload } : report, null, 2),
      'utf8'
    );

    await browser.close();
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

void run();
