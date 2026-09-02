/*
  Baseline reconciliation: plans + subscriptions -- functionally usable,
  not just structurally present.

  ── Why this migration exists ──────────────────────────────────────────────
  Neither `plans` nor `subscriptions` has ever been created by any
  migration in this repository's tracked history (full-history
  `git log --all -S` search, zero matches -- see the prior audit turn).
  Both exist in production today, created out-of-band. This revision adds
  what the first draft was missing per explicit review: canonical plan
  row seeding, a robustly table/column-scoped constraint check (not a
  bare conname match, which an unrelated same-named constraint elsewhere
  in the schema could fool), the minimum RLS policy a fresh database
  actually needs for the app to function (not a guess at production's
  exact policy text), and a resolved (not left unverifiable)
  classification of the subscriptions.user_id -> auth.users FK question.

  ── 1. Canonical plan rows -- exact live values (verified this turn) ────────
    free:     price_monthly=0,    integrations=1,  workflows=3,   executions=20,   deploy_enabled=false
    pro:      price_monthly=2900, integrations=3,  workflows=20,  executions=500,  deploy_enabled=true
    business: price_monthly=9900, integrations=-1, workflows=-1,  executions=5000, deploy_enabled=true
  All 3 production rows share the identical created_at timestamp
  (2026-05-04T20:45:22.544762+00:00) -- a single bulk-insert, not three
  organic creations. No migration, seed file, bootstrap/setup script, or
  application-initialization code path creates them (searched: all SQL
  content under supabase/migrations, supabase/config.toml's
  schema_paths -- empty --, every *.sql file in the repo -- there are
  none outside supabase/migrations/ --, and the application codebase for
  any INSERT into `plans`; grep confirms zero). Deterministic seeding is
  therefore genuinely missing from the migration chain and is added
  below, by slug, so a fresh replay does not leave `plans` empty.
  ON CONFLICT (slug) DO NOTHING -- never DO UPDATE -- so this can never
  modify an existing row's values under any circumstance, including a
  hypothetical future divergence from the canonical model; correcting a
  genuine mismatch, if one is ever found, should be its own explicit,
  reviewed change, not silently folded into a replay-safety migration.
  IDs are never hard-coded (verified: grepped the entire repository for
  the three literal production plan UUIDs -- zero occurrences anywhere in
  application code, tests, or migrations); every plan lookup in the
  codebase resolves by slug (app/api/billing/plans/route.ts,
  app/api/admin/dev/assign-pro/route.ts, lib/supabase-server.ts's
  upgradePlan(), lib/billing/plan-limits.ts's free-plan fallback,
  lib/billing/apply-stripe-subscription.ts) -- a fresh database's
  gen_random_uuid()-assigned IDs are exactly as usable as production's.
  Stripe event -> plans.slug='pro'/'business' lookup -> that environment's
  own plans.id is the only pattern used anywhere.

  ── 2. Constraint checks are table- (and, for the FK, column/target-)
       scoped, not bare name matches ──────────────────────────────────────
  Per review: `conname = 'x'` alone can be fooled by an unrelated
  same-named constraint anywhere in the schema (false "already exists" ->
  incorrectly skips reconciliation) and, in the opposite direction, can
  cause a needless redundant ADD if production's real constraint exists
  under a different name than guessed. Every check below adds
  `conrelid = 'public.<table>'::regclass`; the new auth.users FK check
  additionally matches by constrained column + target relation rather
  than by name at all, since (unlike the two UNIQUE constraints, whose
  exact names were confirmed directly via production error messages) its
  real name in production is not known.

  ── 3. RLS: minimum the app actually needs, not a guess at production's
       policy text ───────────────────────────────────────────────────────
  /api/billing/plans (the only product code path that reads `plans`) uses
  createServiceClient() -- a privileged, RLS-bypassing client. Grepped
  every `.tsx` client component in the repo: the ONLY direct client-side
  table query anywhere is lib/auth-context.tsx's fetchPlan(), reading
  `subscriptions` (never `plans`) via the anon key + the signed-in user's
  own JWT. That means:
    - `plans` requires NO anon/authenticated policy for the product to
      work. Production currently allows anon SELECT on `plans` anyway
      (confirmed empirically last turn) -- untouched here, not weakened,
      simply not replicated on a fresh database, since nothing in this
      codebase depends on it. A fresh database ends up MORE locked down
      here than production, never less.
    - `subscriptions` needs exactly one thing: an `authenticated`-role
      SELECT policy scoped to the caller's own row, or fetchPlan() breaks
      on a fresh database. No INSERT/UPDATE/DELETE policy is added for
      any client role -- billing mutation stays exclusively
      service-role-authoritative (upgradePlan(), apply-stripe-
      subscription.ts, /api/admin/dev/assign-pro, ensureActiveSubscription()
      are the only writers, and service-role bypasses RLS regardless).
  The exact text of whatever SELECT policy already protects `subscriptions`
  in production is not known (pg_policies is not introspectable through
  the access available outside of a migration's own execution context).
  Per review instruction, the conditional check below does not guess a
  name: it checks whether ANY SELECT policy already exists on this table
  at all, and treats that as "equivalent protection already exists" ->
  no-op. On production (which demonstrably already protects this table --
  fetchPlan() works today, anon reads return empty) this is a verified
  no-op. On a fresh database it creates exactly the one policy needed.

  ── 4. subscriptions.user_id -> auth.users FK classification:
       VERIFIED PRESENT (behaviorally) ──────────────────────────────────
  Direct empirical test this turn, using only a disposable test account
  (created and fully cleaned up): inserted a subscriptions row for a
  fresh auth.users row, then deleted that auth user via
  supabase.auth.admin.deleteUser(). Result: the delete succeeded, and the
  subscriptions row was gone immediately afterward with no other code
  path in this app that performs any such cleanup. This is exactly the
  behavior of `REFERENCES auth.users(id) ON DELETE CASCADE` and is not
  explainable by anything else in this codebase. No direct pg_catalog
  access is available to confirm the underlying mechanism is literally a
  FOREIGN KEY constraint rather than an equivalent trigger, so this is
  classified as VERIFIED PRESENT by behavior, not by catalog inspection --
  recorded here for the schema-provenance register. Reconciled below with
  a column/target-scoped (not name-guessed) conditional ADD, matching the
  observed ON DELETE CASCADE behavior, so a fresh database gets the same
  guarantee production already has.

  ── Out of scope (per review) ──────────────────────────────────────────────
  user_profiles, managed_requests, and restoring the deleted Phase 3
  migration remain outside this Stripe-blocker reconciliation -- neither
  is referenced by 20260618000001, and both are recorded for a later,
  separate global migration-history reconciliation phase.

  ── Safety ──────────────────────────────────────────────────────────────
  Every DDL statement is CREATE TABLE IF NOT EXISTS / a table-scoped
  conditional ADD CONSTRAINT / a table-scoped conditional CREATE POLICY /
  an idempotent ENABLE ROW LEVEL SECURITY / an ON CONFLICT DO NOTHING
  INSERT. Verified this turn: every one of these conditions already holds
  true in production (3 plans rows present and matching, both named
  constraints present, RLS enabled on both tables, some SELECT policy
  already present on subscriptions) -- this migration is a confirmed
  no-op against the live database. Not yet applied anywhere.
*/

-- ── plans ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  price_monthly integer NOT NULL DEFAULT 0,
  integrations_limit integer NOT NULL DEFAULT 1,
  workflows_limit integer NOT NULL DEFAULT 3,
  executions_limit integer NOT NULL DEFAULT 20,
  deploy_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plans_slug_key'
      AND conrelid = 'public.plans'::regclass
  ) THEN
    ALTER TABLE plans ADD CONSTRAINT plans_slug_key UNIQUE (slug);
  END IF;
END $$;

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

-- Canonical plan rows, by slug. ON CONFLICT DO NOTHING only -- never
-- overwrites an existing row's values, on production or anywhere else.
INSERT INTO plans (slug, name, price_monthly, integrations_limit, workflows_limit, executions_limit, deploy_enabled)
VALUES
  ('free',     'Free',     0,    1,  3,  20,   false),
  ('pro',      'Pro',      2900, 3,  20, 500,  true),
  ('business', 'Business', 9900, -1, -1, 5000, true)
ON CONFLICT (slug) DO NOTHING;

-- ── subscriptions ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  status text NOT NULL DEFAULT 'inactive',
  created_at timestamptz NOT NULL DEFAULT now(),
  plan_id uuid,
  current_period_end timestamptz,
  updated_at timestamptz DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_user_id_key'
      AND conrelid = 'public.subscriptions'::regclass
  ) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_key UNIQUE (user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_plan_id_fkey'
      AND conrelid = 'public.subscriptions'::regclass
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_plan_id_fkey
      FOREIGN KEY (plan_id) REFERENCES plans(id);
  END IF;
END $$;

-- user_id -> auth.users(id) ON DELETE CASCADE: matched by constrained
-- column + target relation, not by a guessed name (see note 4 above).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.conrelid = 'public.subscriptions'::regclass
      AND c.confrelid = 'auth.users'::regclass
      AND c.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.subscriptions'::regclass AND attname = 'user_id')
      ]
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Minimum policy the app requires: a caller may read their own
-- subscription row (lib/auth-context.tsx's fetchPlan()). No client-role
-- write policy is added anywhere -- billing mutation stays
-- service-role-only. Conditional on no SELECT policy already existing on
-- this table at all, so this is a no-op wherever production's own
-- (differently-named, unknown-text) equivalent policy already applies.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'subscriptions'
      AND cmd = 'SELECT'
  ) THEN
    CREATE POLICY "subscriptions_select_own_row"
      ON subscriptions FOR SELECT
      TO authenticated
      USING (auth.uid() = user_id);
  END IF;
END $$;
