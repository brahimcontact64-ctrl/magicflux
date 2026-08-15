/**
 * scripts/validate-production.ts
 *
 * Phase 20 — Production Deployment Audit
 *
 * Verifies every critical runtime dependency automatically:
 *   - Environment variables (presence, format, no dev leaks)
 *   - Supabase connectivity (anon + service role)
 *   - Redis connectivity
 *   - Critical API routes (auth, workers, incidents, executions, metrics)
 *   - SSE stream endpoint (connect + receive first event)
 *   - Middleware auth redirect behavior
 *   - Cron endpoint security
 *   - Migration completeness
 *   - Production-safety flags
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/validate-production.ts
 *   BASE_URL=https://myapp.vercel.app npx tsx --env-file=.env.local scripts/validate-production.ts
 */

import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const BASE_URL  = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const REPORT_PATH = 'production-validation-report.json';
const TIMEOUT_MS  = 15_000;

// ── helpers ──────────────────────────────────────────────────────────────────

type CheckResult = {
  name:     string;
  ok:       boolean;
  detail:   string;
  durationMs?: number;
};

const results: CheckResult[] = [];

function pass(name: string, detail: string, durationMs?: number) {
  results.push({ name, ok: true, detail, durationMs });
  console.log(`  ✓ ${name}${durationMs !== undefined ? ` (${durationMs}ms)` : ''}`);
}

function fail(name: string, detail: string, durationMs?: number) {
  results.push({ name, ok: false, detail, durationMs });
  console.error(`  ✗ ${name} — ${detail}${durationMs !== undefined ? ` (${durationMs}ms)` : ''}`);
}

function section(title: string) {
  console.log(`\n── ${title} ──`);
}

function env(name: string): string | undefined {
  return process.env[name];
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Section 1: Environment variables ─────────────────────────────────────────

function auditEnvVars() {
  section('Environment Variables');

  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ];

  for (const name of required) {
    const val = env(name);
    if (!val?.trim()) {
      fail(`env.${name}`, 'Missing or empty — application will not start');
    } else {
      pass(`env.${name}`, `present (${val.length} chars)`);
    }
  }

  // Validate Supabase URL format
  const sbUrl = env('NEXT_PUBLIC_SUPABASE_URL') ?? '';
  if (sbUrl && !sbUrl.startsWith('https://') && !sbUrl.startsWith('http://localhost')) {
    fail('env.supabase_url_format', `Should start with https:// — got: ${sbUrl.slice(0, 40)}`);
  } else if (sbUrl) {
    pass('env.supabase_url_format', 'Valid URL format');
  }

  // Check for dev flags that must not be set in production
  const devFlags = [
    'NEXT_PUBLIC_ENABLE_DEV_PRO_BUTTON',
    'ENABLE_DEV_PRO_BUTTON',
  ];
  for (const flag of devFlags) {
    const val = env(flag);
    if (val === 'true') {
      fail(`env.prod_safety.${flag}`, 'Dev flag is enabled — must be removed before production deploy');
    } else {
      pass(`env.prod_safety.${flag}`, val ? `${val} (not "true")` : 'not set');
    }
  }

  // SMTP — warn if not configured (alerts email delivery will silently fail)
  if (!env('SMTP_HOST')) {
    fail('env.smtp_warning', 'SMTP_HOST not set — alert email delivery will silently fail. Set SMTP_HOST or use Resend.');
  } else {
    pass('env.smtp', `SMTP_HOST=${env('SMTP_HOST')}`);
  }

  // REDIS_URL — required for background workers
  if (!env('REDIS_URL')) {
    fail('env.REDIS_URL', 'Missing — runtime workers cannot start without Redis');
  } else {
    pass('env.REDIS_URL', `present: ${(env('REDIS_URL') ?? '').replace(/:[^:@]+@/, ':***@')}`);
  }

  // CRON_SECRET — required for cron endpoint auth
  if (!env('CRON_SECRET')) {
    fail('env.CRON_SECRET', 'Missing — cron endpoints will reject Vercel scheduler calls');
  } else {
    pass('env.CRON_SECRET', 'present');
  }

  // Warn if NEXT_PUBLIC_SITE_URL is still localhost
  const siteUrl = env('NEXT_PUBLIC_SITE_URL') ?? '';
  if (siteUrl.includes('localhost')) {
    fail('env.site_url_production', `NEXT_PUBLIC_SITE_URL is "${siteUrl}" — must be real domain in production`);
  } else if (siteUrl) {
    pass('env.site_url_production', siteUrl);
  } else {
    fail('env.NEXT_PUBLIC_SITE_URL', 'Not set');
  }
}

// ── Section 2: Supabase connectivity ─────────────────────────────────────────

async function auditSupabase() {
  section('Supabase Connectivity');

  const sbUrl = env('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = env('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');

  if (!sbUrl || !anonKey || !serviceKey) {
    fail('supabase.env_prereq', 'Missing env vars — skipping connectivity checks');
    return;
  }

  // Anon client — health check
  const t0 = Date.now();
  try {
    const anon = createClient(sbUrl, anonKey, { auth: { persistSession: false } });
    const { error } = await anon.from('user_profiles').select('id').limit(1);
    if (error && error.code !== 'PGRST116') {
      fail('supabase.anon_connectivity', `Query error: ${error.message}`, Date.now() - t0);
    } else {
      pass('supabase.anon_connectivity', 'Anon client can reach database', Date.now() - t0);
    }
  } catch (e) {
    fail('supabase.anon_connectivity', `Network error: ${(e as Error).message}`, Date.now() - t0);
  }

  // Service role client
  const t1 = Date.now();
  try {
    const svc = createClient(sbUrl, serviceKey, { auth: { persistSession: false } });
    const { data, error } = await svc
      .from('runtime_workers')
      .select('worker_id')
      .limit(1);
    if (error) {
      fail('supabase.service_role_connectivity', `Query error: ${error.message}`, Date.now() - t1);
    } else {
      pass('supabase.service_role_connectivity', `service_role client ok (${data?.length ?? 0} rows)`, Date.now() - t1);
    }
  } catch (e) {
    fail('supabase.service_role_connectivity', `Network error: ${(e as Error).message}`, Date.now() - t1);
  }

  // Check all Phase 18 tables exist
  const tables = [
    'runtime_metrics',
    'runtime_sla_targets',
    'runtime_sla_violations',
    'runtime_cost_records',
    'runtime_roles',
    'runtime_permissions',
    'runtime_role_permissions',
    'runtime_role_assignments',
    'runtime_alert_rules',
    'runtime_alert_firings',
    'runtime_traces',
    'runtime_spans',
    'runtime_workers',
    'runtime_incidents',
    'runtime_execution_commands',
    'workflow_executions_v2',
    'runtime_execution_events',
    'runtime_execution_snapshots',
  ];

  const svc = createClient(sbUrl, serviceKey, { auth: { persistSession: false } });
  for (const table of tables) {
    const t = Date.now();
    const { error } = await svc.from(table).select('*', { count: 'exact', head: true });
    if (error && error.code === '42P01') {
      fail(`supabase.table.${table}`, 'Table does not exist — migration may not have run', Date.now() - t);
    } else if (error) {
      fail(`supabase.table.${table}`, `Query error: ${error.message}`, Date.now() - t);
    } else {
      pass(`supabase.table.${table}`, 'exists', Date.now() - t);
    }
  }

  // Check RBAC seed data
  const t2 = Date.now();
  const { data: roles } = await svc.from('runtime_roles').select('name').order('name');
  const roleNames = (roles ?? []).map((r: Record<string, unknown>) => String(r.name));
  const expectedRoles = ['admin', 'operator', 'viewer'];
  const missingRoles = expectedRoles.filter(r => !roleNames.includes(r));
  if (missingRoles.length > 0) {
    fail('supabase.rbac_seed', `Missing roles: ${missingRoles.join(', ')} — run migrations`, Date.now() - t2);
  } else {
    pass('supabase.rbac_seed', `All 3 roles seeded: ${roleNames.join(', ')}`, Date.now() - t2);
  }

  // Check SLA default targets
  const t3 = Date.now();
  const { data: slaTargets } = await svc
    .from('runtime_sla_targets')
    .select('target_type')
    .eq('is_active', true);
  const slaCount = slaTargets?.length ?? 0;
  if (slaCount < 4) {
    fail('supabase.sla_seed', `Only ${slaCount}/4 SLA targets seeded — run migrations`, Date.now() - t3);
  } else {
    pass('supabase.sla_seed', `${slaCount} SLA targets active`, Date.now() - t3);
  }

  // Check alert default rules (unique constraint from hardening migration)
  const t4 = Date.now();
  const { data: alertRules } = await svc
    .from('runtime_alert_rules')
    .select('name, is_active');
  const alertCount = alertRules?.length ?? 0;
  if (alertCount < 5) {
    fail('supabase.alert_seed', `Only ${alertCount}/5 default alert rules — run migrations`, Date.now() - t4);
  } else {
    pass('supabase.alert_seed', `${alertCount} alert rules (${alertRules?.filter((r: Record<string, unknown>) => r.is_active).length ?? 0} active)`, Date.now() - t4);
  }
}

// ── Section 3: Redis connectivity ────────────────────────────────────────────

async function auditRedis() {
  section('Redis Connectivity');

  const redisUrl = env('REDIS_URL');
  if (!redisUrl) {
    fail('redis.connectivity', 'REDIS_URL not set — skipping');
    return;
  }

  // We cannot import ioredis in a simple script without loading all deps.
  // Validate via a TCP connection probe instead.
  const t = Date.now();
  try {
    const url = new URL(redisUrl);
    const host = url.hostname;
    const port = parseInt(url.port || '6379', 10);

    await new Promise<void>((resolve, reject) => {
      const net = require('net') as typeof import('net');
      const socket = net.createConnection({ host, port, timeout: 5000 });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', (e: Error) => reject(e));
      socket.once('timeout', () => { socket.destroy(); reject(new Error('TCP timeout')); });
    });

    pass('redis.tcp_connectivity', `${host}:${port} reachable`, Date.now() - t);
  } catch (e) {
    fail('redis.tcp_connectivity', `Cannot reach Redis: ${(e as Error).message} — workers will not start`, Date.now() - t);
  }
}

// ── Section 4: API routes ────────────────────────────────────────────────────

async function auditApiRoutes() {
  section('API Routes');

  // Health check (unauthenticated)
  const healthRoutes = [
    '/api/health',
  ];

  for (const route of healthRoutes) {
    const t = Date.now();
    try {
      const res = await fetchWithTimeout(`${BASE_URL}${route}`);
      if (res.status < 500) {
        pass(`api.${route}`, `HTTP ${res.status}`, Date.now() - t);
      } else {
        fail(`api.${route}`, `HTTP ${res.status}`, Date.now() - t);
      }
    } catch (e) {
      fail(`api.${route}`, `Request failed: ${(e as Error).message}`, Date.now() - t);
    }
  }

  // Auth-protected routes — must return 401 without credentials
  const protectedRoutes = [
    '/api/runtime/control/stream',
    '/api/runtime/control/metrics?snapshot=true',
    '/api/runtime/control/workers',
    '/api/runtime/control/incidents',
    '/api/runtime/control/executions',
    '/api/runtime/control/alerts',
    '/api/runtime/control/sla',
    '/api/runtime/control/cost',
    '/api/runtime/control/rbac',
    '/api/runtime/control/traces',
    '/api/runtime/analytics',
    '/api/runtime/timeline',
  ];

  for (const route of protectedRoutes) {
    const t = Date.now();
    try {
      const res = await fetchWithTimeout(`${BASE_URL}${route}`);
      if (res.status === 401) {
        pass(`api.auth.${route}`, `Correctly returns 401`, Date.now() - t);
      } else if (res.status === 200) {
        fail(`api.auth.${route}`, `Returns 200 without auth — route is unprotected`, Date.now() - t);
      } else {
        pass(`api.auth.${route}`, `Returns ${res.status} (not 200 without auth)`, Date.now() - t);
      }
    } catch (e) {
      fail(`api.auth.${route}`, `Request failed: ${(e as Error).message}`, Date.now() - t);
    }
  }

  // Cron endpoint must require CRON_SECRET
  const t = Date.now();
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/cron/reverify-credentials`, {
      method: 'GET',
    });
    if (res.status === 401 || res.status === 403) {
      pass('api.cron.auth', `Cron endpoint correctly rejects unauthenticated requests (${res.status})`, Date.now() - t);
    } else if (res.status === 200) {
      fail('api.cron.auth', 'Cron endpoint runs without auth — must require CRON_SECRET', Date.now() - t);
    } else {
      pass('api.cron.auth', `Returns ${res.status} without auth`, Date.now() - t);
    }
  } catch (e) {
    fail('api.cron.auth', `Request failed: ${(e as Error).message}`, Date.now() - t);
  }

  // Self-heal endpoint must require CRON_SECRET
  const t2 = Date.now();
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/runtime/self-heal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.status === 401 || res.status === 403) {
      pass('api.self_heal.auth', `Self-heal correctly rejects unauthenticated requests (${res.status})`, Date.now() - t2);
    } else if (res.status === 200) {
      fail('api.self_heal.auth', 'Self-heal runs without auth — must require CRON_SECRET', Date.now() - t2);
    } else {
      pass('api.self_heal.auth', `Returns ${res.status} without auth`, Date.now() - t2);
    }
  } catch (e) {
    fail('api.self_heal.auth', `Request failed: ${(e as Error).message}`, Date.now() - t2);
  }
}

// ── Section 5: SSE stream ────────────────────────────────────────────────────

async function auditSseStream() {
  section('SSE Stream');

  // Without auth — must return 401
  const t1 = Date.now();
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/runtime/control/stream`);
    if (res.status === 401) {
      pass('sse.unauthenticated_rejects', `401 without auth`, Date.now() - t1);
    } else {
      fail('sse.unauthenticated_rejects', `Expected 401, got ${res.status}`, Date.now() - t1);
    }
  } catch (e) {
    fail('sse.unauthenticated_rejects', `Request failed: ${(e as Error).message}`, Date.now() - t1);
  }

  // Check Content-Type header is present on the route config
  // We validate by checking the app code, not live (would need real auth token)
  const { readFileSync, existsSync } = await import('node:fs');
  const streamRoute = 'app/api/runtime/control/stream/route.ts';
  if (existsSync(streamRoute)) {
    const src = readFileSync(streamRoute, 'utf8');
    if (src.includes("'text/event-stream'")) {
      pass('sse.content_type_header', 'Route sets text/event-stream Content-Type');
    } else {
      fail('sse.content_type_header', 'Route does not set text/event-stream header');
    }
    if (src.includes("'no-cache, no-transform'") || src.includes('no-cache')) {
      pass('sse.cache_control_header', 'Route sets Cache-Control: no-cache');
    } else {
      fail('sse.cache_control_header', 'Route missing Cache-Control: no-cache header');
    }
    if (src.includes('export const runtime') && src.includes('nodejs')) {
      pass('sse.nodejs_runtime', 'Stream route uses Node.js runtime (required for SSE)');
    } else {
      fail('sse.nodejs_runtime', 'Stream route must set export const runtime = "nodejs"');
    }
    if (src.includes('cancelled = true')) {
      pass('sse.cleanup_guard', 'Cleanup race condition guard (cancelled flag) present');
    } else {
      fail('sse.cleanup_guard', 'Missing cancelled flag — interval leak possible on early disconnect');
    }
    if (src.includes("req.signal.addEventListener('abort'")) {
      pass('sse.abort_handler', 'Request abort signal handler present');
    } else {
      fail('sse.abort_handler', 'Missing abort signal handler — connections may not clean up');
    }
  } else {
    fail('sse.route_exists', `${streamRoute} not found`);
  }
}

// ── Section 6: Middleware ────────────────────────────────────────────────────

async function auditMiddleware() {
  section('Middleware');

  // Admin route without auth — must redirect
  const t = Date.now();
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/admin`, { redirect: 'manual' });
    if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
      const loc = res.headers.get('location') ?? '';
      if (loc.includes('/login')) {
        pass('middleware.admin_redirect', `Admin route redirects to /login (${res.status})`, Date.now() - t);
      } else {
        fail('middleware.admin_redirect', `Admin route redirects to ${loc} (not /login)`, Date.now() - t);
      }
    } else if (res.status === 401) {
      pass('middleware.admin_redirect', `Admin route returns 401 without auth`, Date.now() - t);
    } else {
      fail('middleware.admin_redirect', `Admin route returns ${res.status} — should redirect to /login`, Date.now() - t);
    }
  } catch (e) {
    fail('middleware.admin_redirect', `Request failed: ${(e as Error).message}`, Date.now() - t);
  }

  // Check middleware.ts for correct structure
  const { readFileSync, existsSync } = await import('node:fs');
  if (existsSync('middleware.ts')) {
    const src = readFileSync('middleware.ts', 'utf8');
    if (src.includes('mf_access_token')) {
      pass('middleware.cookie_auth', 'Reads mf_access_token cookie');
    } else {
      fail('middleware.cookie_auth', 'Missing mf_access_token cookie check');
    }
    if (src.includes('/auth/v1/user')) {
      pass('middleware.token_validation', 'Validates token against Supabase auth');
    } else {
      fail('middleware.token_validation', 'Token not validated against Supabase');
    }
    // Check for missing timeout on middleware fetch calls
    if (!src.includes('AbortController') && !src.includes('signal')) {
      fail('middleware.fetch_timeout', 'Middleware fetch calls have no timeout — slow Supabase will hang requests');
    } else {
      pass('middleware.fetch_timeout', 'Fetch timeout present');
    }
  } else {
    fail('middleware.exists', 'middleware.ts not found');
  }
}

// ── Section 7: Production-safety checks ─────────────────────────────────────

async function auditProductionSafety() {
  section('Production Safety');

  const { readFileSync, existsSync } = await import('node:fs');

  // next.config.js — swcMinify disabled (intentional, but note it)
  if (existsSync('next.config.js')) {
    const src = readFileSync('next.config.js', 'utf8');
    if (src.includes('swcMinify: false')) {
      fail('config.swc_minify', 'swcMinify: false — bundle will be larger. Enable for production if possible.');
    } else {
      pass('config.swc_minify', 'swcMinify not disabled');
    }
    if (src.includes('ignoreDuringBuilds: true')) {
      fail('config.eslint_ignore', 'ESLint is ignored during builds — linting errors will not block deployment');
    } else {
      pass('config.eslint_builds', 'ESLint runs during builds');
    }
  }

  // vercel.json — cron schedule present
  if (existsSync('vercel.json')) {
    const src = readFileSync('vercel.json', 'utf8');
    if (src.includes('crons')) {
      pass('config.vercel_crons', 'Vercel cron jobs configured');
    } else {
      fail('config.vercel_crons', 'No cron jobs in vercel.json — reverify-credentials will not run');
    }
  } else {
    fail('config.vercel_json', 'vercel.json not found — deployment config missing');
  }

  // Check tsconfig
  if (existsSync('tsconfig.json')) {
    const src = readFileSync('tsconfig.json', 'utf8');
    const cfg = JSON.parse(src) as Record<string, unknown>;
    const co = (cfg.compilerOptions ?? {}) as Record<string, unknown>;
    if (co.strict) {
      pass('config.ts_strict', 'TypeScript strict mode enabled');
    } else {
      fail('config.ts_strict', 'TypeScript strict mode not enabled — type safety gaps possible');
    }
  }

  // Check .gitignore contains .env
  if (existsSync('.gitignore')) {
    const gi = readFileSync('.gitignore', 'utf8');
    if (gi.includes('.env.local') || gi.includes('.env')) {
      pass('security.env_gitignore', '.env files are gitignored');
    } else {
      fail('security.env_gitignore', '.env files not in .gitignore — credentials may be committed');
    }
  }

  // Check SUPABASE_SERVICE_ROLE_KEY is not exposed via NEXT_PUBLIC_
  const publicEnvKeys = Object.keys(process.env).filter(k => k.startsWith('NEXT_PUBLIC_'));
  const leakedKeys = publicEnvKeys.filter(k =>
    k.toLowerCase().includes('service') ||
    k.toLowerCase().includes('secret') ||
    k.toLowerCase().includes('private')
  );
  if (leakedKeys.length > 0) {
    fail('security.public_env_leak', `NEXT_PUBLIC_ env vars expose sensitive names: ${leakedKeys.join(', ')}`);
  } else {
    pass('security.public_env_leak', 'No sensitive keys exposed via NEXT_PUBLIC_');
  }

  // Alert engine delivery timeout check
  if (existsSync('lib/runtime/alert-engine.ts')) {
    const src = readFileSync('lib/runtime/alert-engine.ts', 'utf8');
    if (src.includes('AbortController') && src.includes('DELIVERY_TIMEOUT_MS')) {
      pass('alert_engine.delivery_timeout', 'Alert delivery has AbortController timeout');
    } else {
      fail('alert_engine.delivery_timeout', 'Alert delivery missing timeout — slow webhooks will block');
    }
    if (src.includes('cooldownMs')) {
      pass('alert_engine.cooldown', 'Alert evaluation has per-rule cooldown');
    } else {
      fail('alert_engine.cooldown', 'Alert evaluation missing cooldown — alert spam possible');
    }
  }

  // SLA upsert fix
  if (existsSync('supabase/migrations/20260531000006_runtime_phase18_hardening.sql')) {
    pass('migration.hardening', 'Phase 19 hardening migration exists (SLA + alert unique constraints)');
  } else {
    fail('migration.hardening', 'Phase 19 hardening migration missing — SLA upserts will fail at runtime');
  }
}

// ── Section 8: Migration audit ───────────────────────────────────────────────

async function auditMigrations() {
  section('Migrations');

  const { readdirSync, existsSync } = await import('node:fs');

  if (!existsSync('supabase/migrations')) {
    fail('migrations.dir', 'supabase/migrations directory not found');
    return;
  }

  const files = readdirSync('supabase/migrations')
    .filter(f => f.endsWith('.sql'))
    .sort();

  pass('migrations.count', `${files.length} migration files found`);

  // Check all Phase 18 migrations present
  const phase18 = [
    '20260531000001_runtime_phase18_metrics.sql',
    '20260531000002_runtime_phase18_sla.sql',
    '20260531000003_runtime_phase18_cost.sql',
    '20260531000004_runtime_phase18_rbac.sql',
    '20260531000005_runtime_phase18_alerts.sql',
    '20260531000006_runtime_phase18_hardening.sql',
  ];

  for (const f of phase18) {
    if (files.includes(f)) {
      pass(`migrations.phase18.${f}`, 'present');
    } else {
      fail(`migrations.phase18.${f}`, 'MISSING — critical Phase 18 schema not deployed');
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  MagicFlux Production Validation');
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Date:   ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════');

  auditEnvVars();
  await auditSupabase();
  await auditRedis();
  await auditApiRoutes();
  await auditSseStream();
  await auditMiddleware();
  await auditProductionSafety();
  await auditMigrations();

  const passed  = results.filter(r => r.ok).length;
  const failed  = results.filter(r => !r.ok).length;
  const total   = results.length;
  const score   = Math.round((passed / total) * 100);

  const criticalFailures = results
    .filter(r => !r.ok)
    .filter(r =>
      r.name.includes('env.NEXT_PUBLIC_SUPABASE') ||
      r.name.includes('env.SUPABASE_SERVICE_ROLE') ||
      r.name.includes('supabase.service_role_connectivity') ||
      r.name.includes('env.REDIS_URL') ||
      r.name.includes('migration.hardening') ||
      r.name.includes('env.prod_safety')
    );

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Results: ${passed}/${total} passed (${score}%)`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Critical failures: ${criticalFailures.length}`);

  if (criticalFailures.length > 0) {
    console.log('\n  CRITICAL (blocks deployment):');
    criticalFailures.forEach(r => console.error(`    ✗ ${r.name}: ${r.detail}`));
  }

  const decision = criticalFailures.length === 0 && score >= 80 ? 'GO' : 'NO-GO';
  console.log(`\n  Decision: ${decision}`);
  console.log('═══════════════════════════════════════════════════════');

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    summary: { total, passed, failed, score, decision },
    criticalFailures: criticalFailures.map(r => r.name),
    results,
  };

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${REPORT_PATH}`);

  if (decision === 'NO-GO') process.exitCode = 1;
}

main().catch(e => {
  console.error('Validation script crashed:', e);
  process.exit(1);
});
