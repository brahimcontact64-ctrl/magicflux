/**
 * Production Readiness Audit
 *
 * Static analysis of configuration files and source code to verify the
 * project is ready for Vercel + Supabase production deployment.
 * No live network calls are made.
 *
 * Run: npx tsx scripts/test-production-readiness.ts
 */

process.env.INTEGRATIONS_ENCRYPTION_KEY = '0'.repeat(64);
process.env.NEXT_PUBLIC_APP_URL = 'https://test.magicflux.app';

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name}\n      ${msg}`);
    failed++;
    failures.push(`${name}: ${msg}`);
  }
}

function section(title: string) {
  console.log(`\n── ${title} ─`);
}

const ROOT = resolve(process.cwd());

function src(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf-8');
}

function fileExists(relPath: string): boolean {
  return existsSync(resolve(ROOT, relPath));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {

  // ── 1. Supabase migrations ────────────────────────────────────────────────

  section('1. Supabase migrations — required files present');

  const REQUIRED_MIGRATIONS: Array<[string, string]> = [
    ['20260520000001_integration_credentials.sql', 'integration_credentials table + RLS'],
    ['20260520000002_credential_verifications.sql', 'credential_verifications table'],
    ['20260520000003_save_credentials_with_verification_fn.sql', 'save_credentials_with_verification RPC'],
    ['20260520000004_get_stale_credential_users_fn.sql', 'get_stale_credential_users RPC'],
    ['20260522000001_migrate_google_oauth_credential_keys.sql', 'Google credential key isolation'],
    ['20260522000002_ownership_rls_hardening.sql', 'Ownership RLS hardening'],
    ['20260522000003_workflow_deployments_rls.sql', 'workflow_deployments RLS'],
    ['20260523000001_runtime_multitenant_hardening.sql', 'Runtime multitenant UPSERT indexes'],
  ];

  for (const [filename, purpose] of REQUIRED_MIGRATIONS) {
    test(`migration exists: ${filename} (${purpose})`, () => {
      if (!fileExists(`supabase/migrations/${filename}`)) {
        throw new Error(`Required migration not found: supabase/migrations/${filename}`);
      }
    });
  }

  test('total migration count is at least 20', () => {
    const files = readdirSync(resolve(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));
    if (files.length < 20) {
      throw new Error(`Expected ≥20 migration files, found ${files.length}`);
    }
  });

  test('runtime_multitenant_hardening is the last migration (highest timestamp)', () => {
    const files = readdirSync(resolve(ROOT, 'supabase/migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const last = files[files.length - 1];
    if (!last.includes('runtime_multitenant_hardening')) {
      throw new Error(`Last migration should be runtime_multitenant_hardening, found: ${last}`);
    }
  });

  test('integration_credentials migration defines UNIQUE(user_id, provider, credential_key)', () => {
    const c = src('supabase/migrations/20260520000001_integration_credentials.sql');
    if (!c.includes('UNIQUE (user_id, provider, credential_key)') &&
        !c.includes('UNIQUE(user_id, provider, credential_key)')) {
      throw new Error('integration_credentials must define UNIQUE(user_id, provider, credential_key)');
    }
  });

  test('integration_credentials migration enables RLS', () => {
    const c = src('supabase/migrations/20260520000001_integration_credentials.sql');
    if (!c.includes('ENABLE ROW LEVEL SECURITY')) {
      throw new Error('integration_credentials must ENABLE ROW LEVEL SECURITY');
    }
  });

  test('save_credentials_with_verification RPC revokes PUBLIC access, grants service_role only', () => {
    const c = src('supabase/migrations/20260520000003_save_credentials_with_verification_fn.sql');
    if (!c.includes('REVOKE EXECUTE') || !c.includes('service_role')) {
      throw new Error('save_credentials_with_verification must REVOKE PUBLIC and GRANT service_role only');
    }
  });

  test('get_stale_credential_users RPC revokes PUBLIC access, grants service_role only', () => {
    const c = src('supabase/migrations/20260520000004_get_stale_credential_users_fn.sql');
    if (!c.includes('REVOKE EXECUTE') || !c.includes('service_role')) {
      throw new Error('get_stale_credential_users must REVOKE PUBLIC and GRANT service_role only');
    }
  });

  test('runtime_multitenant_hardening migration creates all three tenant-scoped indexes', () => {
    const c = src('supabase/migrations/20260523000001_runtime_multitenant_hardening.sql');
    const count = (c.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g) ?? []).length;
    if (count < 3) {
      throw new Error(`Expected ≥3 CREATE UNIQUE INDEX IF NOT EXISTS in multitenant migration, found ${count}`);
    }
  });

  test('ownership_rls_hardening migration drops USING(true) policies', () => {
    const c = src('supabase/migrations/20260522000002_ownership_rls_hardening.sql');
    if (!c.includes('DROP POLICY') || !c.includes('runtime_workers')) {
      throw new Error('ownership_rls_hardening must drop USING(true) policies on runtime_workers');
    }
  });

  // ── 2. Vercel cron configuration ──────────────────────────────────────────

  section('2. Vercel cron — /api/cron/reverify-credentials');

  test('vercel.json exists', () => {
    if (!fileExists('vercel.json')) throw new Error('vercel.json not found');
  });

  test('vercel.json contains the reverify-credentials cron path', () => {
    const v = src('vercel.json');
    if (!v.includes('/api/cron/reverify-credentials')) {
      throw new Error('vercel.json missing cron path /api/cron/reverify-credentials');
    }
  });

  test('vercel.json cron has a non-empty schedule', () => {
    const v = JSON.parse(src('vercel.json')) as { crons?: Array<{ path: string; schedule: string }> };
    const cron = (v.crons ?? []).find((c) => c.path === '/api/cron/reverify-credentials');
    if (!cron) throw new Error('reverify-credentials cron entry not found in vercel.json');
    if (!cron.schedule) throw new Error('reverify-credentials cron entry has no schedule');
  });

  test('cron route returns 500 when CRON_SECRET env var is not configured', () => {
    const c = src('app/api/cron/reverify-credentials/route.ts');
    if (!c.includes('CRON_SECRET')) throw new Error('CRON_SECRET not referenced in cron route');
    if (!c.includes('status: 500')) {
      throw new Error('Cron route must return 500 when CRON_SECRET is not configured');
    }
  });

  test('cron route returns 401 for an invalid CRON_SECRET', () => {
    const c = src('app/api/cron/reverify-credentials/route.ts');
    if (!c.includes('status: 401')) {
      throw new Error('Cron route must return 401 for invalid CRON_SECRET');
    }
    if (!c.includes('Unauthorized')) {
      throw new Error("Cron route 401 response must say 'Unauthorized'");
    }
  });

  test('cron route reads secret from Authorization header (not query param)', () => {
    const c = src('app/api/cron/reverify-credentials/route.ts');
    if (!c.includes("req.headers.get('authorization')")) {
      throw new Error('Cron route must read CRON_SECRET from Authorization header, not query params');
    }
  });

  // ── 3. Required environment variable references in source ─────────────────

  section('3. Environment variable references — all required vars wired in source');

  test('oauth/start uses NEXT_PUBLIC_APP_URL (not SITE_URL) for the redirect URI', () => {
    const c = src('app/api/oauth/start/route.ts');
    if (!c.includes('NEXT_PUBLIC_APP_URL')) {
      throw new Error('oauth/start must reference NEXT_PUBLIC_APP_URL — if only SITE_URL is set, OAuth will fail');
    }
  });

  test('oauth/callback uses NEXT_PUBLIC_APP_URL for the token-exchange redirect_uri', () => {
    const c = src('app/api/oauth/callback/route.ts');
    if (!c.includes('NEXT_PUBLIC_APP_URL')) {
      throw new Error('oauth/callback must reference NEXT_PUBLIC_APP_URL for redirect_uri sent to token endpoint');
    }
  });

  test('oauth/start returns 503 when NEXT_PUBLIC_APP_URL is not configured', () => {
    const c = src('app/api/oauth/start/route.ts');
    if (!c.includes('503')) {
      throw new Error('oauth/start must return 503 when NEXT_PUBLIC_APP_URL is missing — prevents silent misconfiguration');
    }
  });

  test('INTEGRATIONS_ENCRYPTION_KEY is referenced in oauth-state.ts (HMAC signing)', () => {
    const c = src('lib/credentials/oauth-state.ts');
    if (!c.includes('INTEGRATIONS_ENCRYPTION_KEY')) {
      throw new Error('oauth-state.ts must reference INTEGRATIONS_ENCRYPTION_KEY for HMAC state signing');
    }
  });

  test('INTEGRATIONS_ENCRYPTION_KEY is referenced in storage.ts (AES-256-GCM encryption)', () => {
    const c = src('lib/credentials/storage.ts');
    if (!c.includes('INTEGRATIONS_ENCRYPTION_KEY')) {
      throw new Error('storage.ts must reference INTEGRATIONS_ENCRYPTION_KEY for credential encryption');
    }
  });

  test('CRON_SECRET is referenced in cron/reverify-credentials/route.ts', () => {
    const c = src('app/api/cron/reverify-credentials/route.ts');
    if (!c.includes('CRON_SECRET')) {
      throw new Error('Cron route must reference CRON_SECRET env var');
    }
  });

  test('GOOGLE_CLIENT_ID is registered as clientIdEnv in oauth-providers.ts', () => {
    const c = src('lib/credentials/oauth-providers.ts');
    if (!c.includes('GOOGLE_CLIENT_ID')) {
      throw new Error('oauth-providers.ts must reference GOOGLE_CLIENT_ID as clientIdEnv for Google providers');
    }
  });

  test('GOOGLE_CLIENT_SECRET is registered as clientSecretEnv in oauth-providers.ts', () => {
    const c = src('lib/credentials/oauth-providers.ts');
    if (!c.includes('GOOGLE_CLIENT_SECRET')) {
      throw new Error('oauth-providers.ts must reference GOOGLE_CLIENT_SECRET as clientSecretEnv for Google providers');
    }
  });

  test('CANVA_CLIENT_ID is registered as clientIdEnv in oauth-providers.ts', () => {
    const c = src('lib/credentials/oauth-providers.ts');
    if (!c.includes('CANVA_CLIENT_ID')) {
      throw new Error('oauth-providers.ts must reference CANVA_CLIENT_ID as clientIdEnv for Canva');
    }
  });

  test('CANVA_CLIENT_SECRET is registered as clientSecretEnv in oauth-providers.ts', () => {
    const c = src('lib/credentials/oauth-providers.ts');
    if (!c.includes('CANVA_CLIENT_SECRET')) {
      throw new Error('oauth-providers.ts must reference CANVA_CLIENT_SECRET as clientSecretEnv for Canva');
    }
  });

  // ── 4. OAuth security ──────────────────────────────────────────────────────

  section('4. OAuth security — POST flow, CSRF protection, token handling');

  test('oauth/start route is POST only (no GET handler — no JWT in URL)', () => {
    const c = src('app/api/oauth/start/route.ts');
    if (!c.includes('export async function POST(')) {
      throw new Error('oauth/start must export a POST handler to prevent JWT exposure in URL');
    }
    if (c.includes('export async function GET(')) {
      throw new Error('oauth/start must not export a GET handler — would expose JWT in browser history');
    }
  });

  test('oauth/start authenticates via getUserFromRequest (JWT), not body.userId', () => {
    const c = src('app/api/oauth/start/route.ts');
    if (!c.includes('getUserFromRequest')) {
      throw new Error('oauth/start must use getUserFromRequest to obtain userId from the JWT, not from request body');
    }
    if (c.includes('body.userId') || c.includes('body.user_id')) {
      throw new Error('oauth/start must not accept userId from the request body — use JWT only');
    }
  });

  test('oauth/callback extracts userId from HMAC-verified state (not from query params)', () => {
    const c = src('app/api/oauth/callback/route.ts');
    if (!c.includes('verifyOAuthState')) {
      throw new Error('oauth/callback must verify the CSRF state token via verifyOAuthState');
    }
    if (!c.includes('stateResult.payload')) {
      throw new Error('oauth/callback must extract userId from the verified state payload, not from query params');
    }
    if (c.includes("searchParams.get('userId')") || c.includes("searchParams.get('user_id')")) {
      throw new Error('oauth/callback must never read userId from URL query params');
    }
  });

  test('oauth/callback validates userId from state with assertTrustedUserId (defense-in-depth)', () => {
    const c = src('app/api/oauth/callback/route.ts');
    if (!c.includes('assertTrustedUserId')) {
      throw new Error('oauth/callback must call assertTrustedUserId on the userId from state (defense-in-depth)');
    }
  });

  test('oauth/callback checks stateResult.valid before trusting the state payload', () => {
    const c = src('app/api/oauth/callback/route.ts');
    const verifyIdx = c.indexOf('verifyOAuthState(');
    if (verifyIdx === -1) throw new Error('verifyOAuthState not found in oauth/callback');
    const afterVerify = c.slice(verifyIdx);
    if (!afterVerify.includes('.valid')) {
      throw new Error('oauth/callback must check stateResult.valid before using the state payload');
    }
  });

  test('oauth-state.ts uses HMAC-SHA256 for state signing', () => {
    const c = src('lib/credentials/oauth-state.ts');
    if (!c.includes('createHmac')) {
      throw new Error('oauth-state.ts must use crypto.createHmac for CSRF state signing');
    }
    if (!c.includes('sha256')) {
      throw new Error('oauth-state.ts HMAC must use sha256 algorithm');
    }
  });

  test('oauth-state.ts uses timingSafeEqual (prevents timing-based signature bypass)', () => {
    const c = src('lib/credentials/oauth-state.ts');
    if (!c.includes('timingSafeEqual')) {
      throw new Error('oauth-state.ts must use crypto.timingSafeEqual to prevent timing attacks');
    }
  });

  test('oauth-state.ts rejects tokens older than STATE_MAX_AGE_SECONDS (replay protection)', () => {
    const c = src('lib/credentials/oauth-state.ts');
    if (!c.includes('STATE_MAX_AGE_SECONDS')) {
      throw new Error('oauth-state.ts must define STATE_MAX_AGE_SECONDS for replay protection');
    }
    if (!c.includes('age >= STATE_MAX_AGE_SECONDS')) {
      throw new Error('oauth-state.ts must treat age === STATE_MAX_AGE_SECONDS as expired (>= not >)');
    }
  });

  test('oauth/callback saves credentials atomically via saveCredentialsWithVerification', () => {
    const c = src('app/api/oauth/callback/route.ts');
    if (!c.includes('saveCredentialsWithVerification')) {
      throw new Error('oauth/callback must use saveCredentialsWithVerification for atomic credential + verification write');
    }
  });

  // ── 5. n8n production hardening ────────────────────────────────────────────

  section('5. n8n deployment — authentication and HTTPS enforcement');

  test('n8n orchestrate route has enforceHttps() function', () => {
    const c = src('app/api/n8n/orchestrate/route.ts');
    if (!c.includes('function enforceHttps(')) {
      throw new Error('n8n orchestrate route must have an enforceHttps() function to block HTTP in production');
    }
  });

  test('n8n orchestrate calls enforceHttps and returns on error', () => {
    const c = src('app/api/n8n/orchestrate/route.ts');
    const callIdx = c.indexOf('enforceHttps(');
    if (callIdx === -1) throw new Error('enforceHttps() not called in n8n orchestrate route');
    const afterCall = c.slice(callIdx, callIdx + 200);
    if (!afterCall.includes('httpsErr') && !afterCall.includes('enforceHttps')) {
      throw new Error('n8n orchestrate must act on the result of enforceHttps()');
    }
  });

  test('n8n workflow names are prefixed with user-scoped slug (tenant isolation)', () => {
    const c = src('app/api/n8n/orchestrate/route.ts');
    if (!c.includes('MagicFlux_') || !c.includes('.slice(0, 8)')) {
      throw new Error('n8n workflow names must be prefixed with a userId slice for tenant isolation');
    }
  });

  test('n8n orchestrate authenticates via getUserFromRequest (not client-supplied userId)', () => {
    const c = src('app/api/n8n/orchestrate/route.ts');
    if (!c.includes('getUserFromRequest')) {
      throw new Error('n8n orchestrate must authenticate with getUserFromRequest — never trust client-supplied userId');
    }
  });

  test('n8n orchestrate enforces Pro plan gate before deployment', () => {
    const c = src('app/api/n8n/orchestrate/route.ts');
    if (!c.includes('getUserPlan') || !c.includes("plan !== 'pro'")) {
      throw new Error("n8n orchestrate must enforce a Pro plan gate via getUserPlan");
    }
  });

  // ── 6. Production checklist document ─────────────────────────────────────

  section('6. Production checklist document — content verification');

  const checklistPath = 'docs/PRODUCTION_DEPLOYMENT_CHECKLIST.md';

  test('docs/PRODUCTION_DEPLOYMENT_CHECKLIST.md exists', () => {
    if (!fileExists(checklistPath)) {
      throw new Error('docs/PRODUCTION_DEPLOYMENT_CHECKLIST.md not found — create it before deploying');
    }
  });

  test('checklist documents NEXT_PUBLIC_APP_URL as a required env var', () => {
    const c = src(checklistPath);
    if (!c.includes('NEXT_PUBLIC_APP_URL')) {
      throw new Error('Checklist must document NEXT_PUBLIC_APP_URL as required (distinct from NEXT_PUBLIC_SITE_URL)');
    }
  });

  test('checklist documents INTEGRATIONS_ENCRYPTION_KEY requirement', () => {
    const c = src(checklistPath);
    if (!c.includes('INTEGRATIONS_ENCRYPTION_KEY')) {
      throw new Error('Checklist must document INTEGRATIONS_ENCRYPTION_KEY as required');
    }
  });

  test('checklist documents CRON_SECRET requirement', () => {
    const c = src(checklistPath);
    if (!c.includes('CRON_SECRET')) {
      throw new Error('Checklist must document CRON_SECRET as required for Vercel cron auth');
    }
  });

  test('checklist includes Google Cloud Console OAuth setup instructions', () => {
    const c = src(checklistPath);
    if (!c.includes('Google Cloud Console') || !c.includes('GOOGLE_CLIENT_ID')) {
      throw new Error('Checklist must include Google Cloud Console OAuth setup with GOOGLE_CLIENT_ID');
    }
  });

  test('checklist includes Canva Developer Portal OAuth setup instructions', () => {
    const c = src(checklistPath);
    if (!c.includes('Canva') || !c.includes('CANVA_CLIENT_ID')) {
      throw new Error('Checklist must include Canva OAuth setup with CANVA_CLIENT_ID');
    }
  });

  test('checklist warns against NEXT_PUBLIC_ENABLE_DEV_PRO_BUTTON in production', () => {
    const c = src(checklistPath);
    if (!c.includes('NEXT_PUBLIC_ENABLE_DEV_PRO_BUTTON')) {
      throw new Error('Checklist must warn: NEXT_PUBLIC_ENABLE_DEV_PRO_BUTTON must not be set in production');
    }
  });

  test('checklist includes rollback instructions', () => {
    const c = src(checklistPath);
    if (!c.toLowerCase().includes('rollback')) {
      throw new Error('Checklist must include rollback instructions (database + application)');
    }
  });

  test('checklist lists the first and last migrations (order verification)', () => {
    const c = src(checklistPath);
    if (!c.includes('20260520000001_integration_credentials')) {
      throw new Error('Checklist must list 20260520000001_integration_credentials in the migration table');
    }
    if (!c.includes('20260523000001_runtime_multitenant_hardening')) {
      throw new Error('Checklist must list 20260523000001_runtime_multitenant_hardening as the final migration');
    }
  });

  test('checklist warns about PAYPAL_SANDBOX in production', () => {
    const c = src(checklistPath);
    if (!c.includes('PAYPAL_SANDBOX')) {
      throw new Error('Checklist must warn that PAYPAL_SANDBOX must not be true in production');
    }
  });

  // ── Report ─────────────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(60)}`);
  console.log('Production Readiness Audit');
  console.log('─'.repeat(60));
  console.log(`Total:  ${passed + failed}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  • ${f}`));
    process.exit(1);
  } else {
    console.log('\nAll checks passed.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
