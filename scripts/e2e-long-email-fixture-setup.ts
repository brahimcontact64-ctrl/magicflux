import 'server-only';
import { createServiceClient } from '@/lib/supabase-server';

/**
 * Phase 9.9.19B -- Part 6: a disposable account whose email is a genuinely
 * hostile, unbreakable-by-whitespace string, used only to prove the mobile
 * nav sheet's "Signed in as <email>" row wraps/breaks instead of
 * overflowing the viewport. Never a real user, never used for anything
 * beyond this one adversarial assertion.
 */
const LOCAL_PART = 'this-is-a-deliberately-extremely-long-adversarial-email-local-part-with-no-spaces-anywhere-9919b';
const EMAIL = `${LOCAL_PART}-${Date.now()}@magicflux.local`;
const PASSWORD = `E2eLongEmail9919B!${Math.random().toString(36).slice(2)}`;

async function main() {
  const db = createServiceClient();
  const { data, error } = await db.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (error || !data.user) {
    console.log('ABORT:', error?.message);
    return;
  }
  console.log(JSON.stringify({ userId: data.user.id, email: EMAIL, password: PASSWORD }));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
