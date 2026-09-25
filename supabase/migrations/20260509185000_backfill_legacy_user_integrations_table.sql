/*
  # Backfill: legacy user_integrations table shape (discovered during
  # Workflow #2 Phase D.1 local-staging bootstrap)

  WHY THIS EXISTS AND WHY IT IS DATED HERE (retroactively, before Phase 16):

  Attempting `supabase db reset --local` (a from-scratch replay of every
  migration in this repository, against a fresh local database) fails at
  20260510102000_phase16_dynamic_provider_constraint_fix.sql with:

    ERROR: relation "public.user_integrations" does not exist (SQLSTATE 42P01)

  That migration's final statement, `ALTER TABLE public.user_integrations
  ADD CONSTRAINT ...`, runs unconditionally (unlike its own DROP CONSTRAINT
  above it, which is correctly guarded by an `IF EXISTS` check). No earlier
  migration in this repository ever creates `user_integrations` -- it was
  evidently created out-of-band directly against production (e.g. via the
  Supabase dashboard SQL editor) before this project's migration history
  started tracking it, a real, pre-existing gap unrelated to Workflow #2
  Phases A-D. `lib/user-integrations.ts`'s `getUserIntegrations()` is the
  authoritative reference for the columns real code actually reads:
  `id, user_id, provider, name, credentials, status, last_verified_at,
  created_at`.

  This migration backfills exactly that minimal shape, dated to apply
  BEFORE 20260509190000 (the first migration that even mentions the table),
  so a genuinely fresh database -- local, staging, or a hypothetical
  disaster-recovery restore -- can replay this repository's entire
  migration history successfully, which it could not do before this fix.

  SAFE FOR PRODUCTION BY CONSTRUCTION: `CREATE TABLE IF NOT EXISTS` is a
  true no-op against the current production database, where this table
  already exists with its real (out-of-band-created) shape -- this
  migration changes NOTHING there even if it is ever applied. It exists
  purely so a database that does NOT yet have this table (any fresh
  bootstrap) ends up with a compatible one.

  RLS: enabled, with the same "owner can see their own rows" policy shape
  every other legacy per-user table in this project's early migrations
  uses (service-role remains the actual writer in application code, per
  lib/user-integrations.ts's own use of createServiceClient()).
*/

CREATE TABLE IF NOT EXISTS "public"."user_integrations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "name" "text",
    "credentials" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'connected'::"text" NOT NULL,
    "last_verified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'user_integrations' AND c.conname = 'user_integrations_user_id_fkey'
  ) THEN
    ALTER TABLE "public"."user_integrations"
      ADD CONSTRAINT "user_integrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_user_integrations_user" ON "public"."user_integrations" USING "btree" ("user_id");

ALTER TABLE "public"."user_integrations" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_integrations' AND policyname = 'Users can access their own integrations'
  ) THEN
    CREATE POLICY "Users can access their own integrations" ON "public"."user_integrations"
      FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));
  END IF;
END $$;

-- Explicit grants -- see 20260507105000's identical note (default
-- privileges are not set up until 20260913160000, and never retroactively).
GRANT SELECT ON TABLE "public"."user_integrations" TO "authenticated";
GRANT ALL ON TABLE "public"."user_integrations" TO "service_role";
