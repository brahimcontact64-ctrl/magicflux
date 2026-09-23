import 'server-only';
import { createServiceClient } from '@/lib/supabase-server';

/**
 * Phase 9.9.20 -- creates ONE disposable @magicflux.local account with
 * NO subscription row and NO manually-assigned entitlement of any kind --
 * the exact "brand-new account" shape the Global Free Beta Entitlements
 * fix must cover. Never touches the real Sigma Plus workflow or any real
 * credential/integration.
 */

const EMAIL = `e2e-beta-9920-${Date.now()}@magicflux.local`;
const PASSWORD = `E2eBeta9920!${Math.random().toString(36).slice(2)}`;

async function main() {
  const db = createServiceClient();

  const { data: created, error } = await db.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !created.user) {
    console.log('ABORT: could not create test user:', error?.message);
    return;
  }

  console.log(JSON.stringify({ userId: created.user.id, email: EMAIL, password: PASSWORD }));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
