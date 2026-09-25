# Workflow #2 Phase D -- Local Staging Environment

Isolated local infrastructure for certifying the real Gmail reply loop
(Phases A-C's inbound-reply/follow-up-send infrastructure) WITHOUT touching
production. See `scripts/phase-d/` for the actual bootstrap/harness code.

## Why local, not a second cloud project

The account this repo is linked to has no dedicated MagicFlux staging
Supabase/Vercel/Railway environment (confirmed during the Phase D pre-flight
audit). The Supabase CLI's own local Docker stack (`supabase/config.toml`,
already present in this repo) gives a fully isolated Postgres+Auth+Storage
instance with zero new cloud signups and zero relation to the production
project (`obszpocughyndybjvshn`).

**Local port note**: `supabase/config.toml`'s ports were shifted from the
CLI's defaults (54321-54329) to 55321-55329, because this machine may have
another, unrelated local Supabase project already running on the default
ports. This is a local-only config change and has no effect on the linked
cloud project.

## One-time setup

1. Docker Desktop must be running.
2. `npx supabase start` -- starts the local stack. Prints local API
   URL/anon key/service-role key (the Supabase CLI's well-known, identical-
   for-every-local-install demo keys, not secrets tied to any real account)
   and Studio/Mailpit URLs. Never targets the linked cloud project --
   `supabase start` only ever operates on the local Docker stack.
3. Create `.env.staging.local` in the repo root (already covered by
   `.gitignore`'s `.env*` pattern -- never commit it) with:

   ```
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key supabase start printed>
   SUPABASE_SERVICE_ROLE_KEY=<service_role key supabase start printed>
   INTEGRATIONS_ENCRYPTION_KEY=<any freshly-generated 64-hex-char key -- e.g. `openssl rand -hex 32`; this is symmetric and local-only, never reuse production's>
   MAGICFLUX_ENABLE_FOLLOWUP_SEND_STAGING_CERTIFICATION=true
   NODE_ENV=development
   GOOGLE_CLIENT_ID=<see "Gmail OAuth" below>
   GOOGLE_CLIENT_SECRET=<see "Gmail OAuth" below>
   ```

4. Apply the repository migrations to the LOCAL database only:

   ```
   npx supabase db reset --local
   ```

   `db reset --local` replays every migration in `supabase/migrations/`
   against the local database from a clean slate -- the safest, most
   reproducible local migration mechanism this project's CLI already
   supports. **Never run a bare `supabase db push` or `migration up`
   without `--local`** -- those default to the linked cloud project.

5. Seed synthetic staging data: `npm run phase-d:seed` (reads
   `.env.staging.local`; refuses to run -- via
   `scripts/phase-d/production-guard.ts` -- against anything but a
   recognized local Supabase host).

## Gmail OAuth for a dedicated test mailbox

See the Phase D.1 report's own "Gmail OAuth Preflight" section for the full
investigation. Summary: this project's Google OAuth *client* only has
production's `NEXT_PUBLIC_SITE_URL` redirect URI authorized today. Before a
real send/reply test can run, a human must add a `localhost`-based redirect
URI in Google Cloud Console for this OAuth client (or create a second,
dedicated OAuth client for staging) -- see the report for the exact URI and
why this can't be automated from here.

## Safety

- `scripts/phase-d/production-guard.ts`'s `assertLocalSupabaseTarget()` is
  called first by every Phase D script -- it refuses to proceed against
  anything other than a recognized local host (127.0.0.1/localhost), and
  explicitly refuses the known production project ref by name as a second,
  redundant check.
- `MAGICFLUX_ENABLE_FOLLOWUP_SEND_STAGING_CERTIFICATION=true` is the only
  way `magicflux-nodes.followUpSend` becomes usable outside its normal
  BLOCKLIST -- and it is refused even with the flag set if `NODE_ENV` or
  `VERCEL_ENV` indicates production. See
  `lib/workflow-runtime/node-capabilities.ts`'s
  `isFollowUpSendStagingCertificationEnabled()`.
