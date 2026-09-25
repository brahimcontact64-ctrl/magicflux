/*
  # Backfill: minimal workflows baseline table (discovered during
  # Workflow #2 Phase D.1 local-staging bootstrap)

  Same class of gap as the two backfill migrations immediately after this
  one in timestamp order (user_integrations, automation_conversations) --
  see 20260509185000's header for the general rationale -- but larger in
  scope: `workflows` itself, the single most central table in this
  application, is referenced by dozens of migrations and never CREATEd by
  any of them. This repository's migration history begins at "Phase 5"
  (20260507110000) and evidently assumes an already-existing baseline
  schema from an untracked "Phase 1-4" that predates migration tracking
  entirely -- a genuinely separate, pre-existing gap, not something
  Workflow #2 Phases A-D introduced.

  SCOPE DECISION: this migration intentionally backfills only the MINIMAL
  columns actually required for (a) later migrations' own ALTER
  TABLE/foreign-key statements to succeed during a from-scratch replay, and
  (b) Workflow #2's own runtime_conversations/runtime_followup_sequences
  ownership-trigger checks (`user_id`, `id`) and Phase D.1's seed script
  (`user_id`, `name`, `status`, `workflow_json`). It is NOT an attempt to
  perfectly reconstruct the real, fully-evolved production `workflows`
  schema -- that table's true baseline shape was never captured anywhere
  and cannot be reconstructed with full confidence from migration history
  alone. `status`'s CHECK constraint values are copied verbatim from
  20260605000001_phase8_workflow_lifecycle_and_scheduler.sql (the first
  migration to state them explicitly) so later ALTERs to this constraint
  apply cleanly.

  SAFE FOR PRODUCTION BY CONSTRUCTION: `CREATE TABLE IF NOT EXISTS` is a
  true no-op there, where this table already exists with its real,
  fully-evolved shape accumulated over many more columns than are listed
  here.
*/

CREATE TABLE IF NOT EXISTS "public"."workflows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "workflow_json" "jsonb" DEFAULT '{}'::"jsonb",
    "integrations" "jsonb" DEFAULT '[]'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    PRIMARY KEY ("id"),
    CONSTRAINT "workflows_status_check" CHECK (
        "status" = ANY (ARRAY['draft'::"text", 'validating'::"text", 'active'::"text", 'paused'::"text", 'disabled'::"text", 'error'::"text", 'archived'::"text", 'deployed'::"text"])
    )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'workflows' AND c.conname = 'workflows_user_id_fkey'
  ) THEN
    ALTER TABLE "public"."workflows"
      ADD CONSTRAINT "workflows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_workflows_user" ON "public"."workflows" USING "btree" ("user_id");

ALTER TABLE "public"."workflows" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'workflows' AND policyname = 'Users can access their own workflows'
  ) THEN
    CREATE POLICY "Users can access their own workflows" ON "public"."workflows"
      FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));
  END IF;
END $$;

-- Explicit grants -- do not rely on ALTER DEFAULT PRIVILEGES (only set up
-- much later, 20260913160000, which affects future object creation only,
-- never retroactively). Mirrors the exact pattern real migrations from
-- this era use (e.g. GRANT ALL ... TO service_role, GRANT SELECT ... TO
-- authenticated on platform_connections).
GRANT SELECT ON TABLE "public"."workflows" TO "authenticated";
GRANT ALL ON TABLE "public"."workflows" TO "service_role";
