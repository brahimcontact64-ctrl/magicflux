/**
 * scripts/validate-phase7-environment.ts
 *
 * Phase 7.5 — Environment readiness gate for the credentials & runtime system.
 *
 * Checks PRESENCE ONLY of every environment variable the Phase 7 credential
 * and runtime code paths read. Never prints a value — only PRESENT / MISSING
 * / OPTIONAL, so this is safe to run in CI logs or paste into a report.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/validate-phase7-environment.ts
 */

type Requirement = 'required' | 'optional';

type Check = {
  name: string;
  requirement: Requirement;
  purpose: string;
};

const CHECKS: Check[] = [
  // ── Core Supabase (everything — credentials, runtime, executions — depends on this) ──
  { name: 'NEXT_PUBLIC_SUPABASE_URL', requirement: 'required', purpose: 'Supabase project URL (client + server)' },
  { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', requirement: 'required', purpose: 'Supabase anon key (client-side auth)' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', requirement: 'required', purpose: 'Service-role key — every credential/runtime DB write uses this' },

  // ── Credential encryption ──
  { name: 'INTEGRATIONS_ENCRYPTION_KEY', requirement: 'required', purpose: 'AES-256-GCM key for all stored credentials (lib/security/encryption.ts) — without it, saving/reading any credential throws' },

  // ── Runtime infra ──
  { name: 'REDIS_URL', requirement: 'required', purpose: 'BullMQ queue backend for the runtime worker' },

  // ── n8n deploy path ──
  { name: 'N8N_API_URL', requirement: 'required', purpose: 'External n8n instance for workflow deployment' },
  { name: 'N8N_API_KEY', requirement: 'required', purpose: 'External n8n instance auth' },

  // ── Platform AI generation (separate from per-user OpenAI node credentials) ──
  { name: 'OPENAI_API_KEY', requirement: 'required', purpose: 'Platform-level workflow-generation model (lib/agent/loop.ts) — NOT the same as a user\'s per-workflow OpenAI node credential, which is stored per-user in integration_credentials' },

  // ── Google OAuth (Gmail send, Google Drive, Google Sheets) ──
  { name: 'GOOGLE_CLIENT_ID', requirement: 'optional', purpose: 'Google OAuth client ID — without it, Gmail/Drive/Sheets "Connect" always fails at the authorization step' },
  { name: 'GOOGLE_CLIENT_SECRET', requirement: 'optional', purpose: 'Google OAuth client secret — required alongside GOOGLE_CLIENT_ID for token exchange/refresh' },

  // ── Canva OAuth ──
  { name: 'CANVA_CLIENT_ID', requirement: 'optional', purpose: 'Canva OAuth client ID' },
  { name: 'CANVA_CLIENT_SECRET', requirement: 'optional', purpose: 'Canva OAuth client secret' },

  // ── Security-relevant secrets ──
  { name: 'CRON_SECRET', requirement: 'optional', purpose: 'Authenticates scheduled cron-triggered routes (stale-credential re-verification, etc.)' },
  { name: 'MAGICFLUX_WEBHOOK_SECRET', requirement: 'optional', purpose: 'Validates inbound webhook triggers' },

  // ── Non-Phase-7 platform email (unrelated to the Gmail node handler) ──
  { name: 'RESEND_API_KEY', requirement: 'optional', purpose: 'Platform transactional email (signup, etc.) — unrelated to the per-user Gmail node handler' },
];

type Result = { name: string; status: 'PRESENT' | 'MISSING' | 'OPTIONAL'; requirement: Requirement; purpose: string };

function run(): Result[] {
  return CHECKS.map((check) => {
    const value = process.env[check.name];
    const present = typeof value === 'string' && value.trim().length > 0;
    const status: Result['status'] = present
      ? 'PRESENT'
      : check.requirement === 'required'
        ? 'MISSING'
        : 'OPTIONAL';
    return { name: check.name, status, requirement: check.requirement, purpose: check.purpose };
  });
}

function main(): void {
  const results = run();

  console.log('Phase 7.5 Environment Readiness — presence only, no values printed\n');

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const label = r.status.padEnd(8);
    console.log(`  [${label}] ${r.name.padEnd(width)}  ${r.purpose}`);
  }

  const missingRequired = results.filter((r) => r.status === 'MISSING');
  const missingOptional = results.filter((r) => r.status === 'OPTIONAL');

  console.log('\n────────────────────────────────────────────────────────────────');
  console.log(`${results.length - missingRequired.length - missingOptional.length}/${results.length} present, ${missingRequired.length} missing (required), ${missingOptional.length} not configured (optional)`);

  if (missingRequired.length > 0) {
    console.log('\nBLOCKING — required variables missing:');
    for (const r of missingRequired) console.log(`  - ${r.name}: ${r.purpose}`);
    process.exitCode = 1;
  }

  if (missingOptional.length > 0) {
    console.log('\nFeature-scoped — these providers/features will be unavailable, not a hard blocker:');
    for (const r of missingOptional) console.log(`  - ${r.name}: ${r.purpose}`);
  }
}

main();
