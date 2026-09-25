/*
  # Backfill: legacy automation_conversations table shape (discovered during
  # Workflow #2 Phase D.1 local-staging bootstrap)

  Same class of pre-existing gap as
  20260509185000_backfill_legacy_user_integrations_table.sql (see that
  file's header for the full rationale) -- a from-scratch `supabase db
  reset --local` fails at
  20260510124000_add_workflow_id_to_automation_conversations.sql's second
  statement:

    CREATE INDEX IF NOT EXISTS automation_conversations_workflow_id_idx
      ON automation_conversations(workflow_id, updated_at DESC)

  `CREATE INDEX IF NOT EXISTS` only guards against the INDEX already
  existing, not against the referenced TABLE being absent -- unlike that
  same migration's first statement (`ALTER TABLE IF EXISTS`, correctly
  guarded). No earlier migration ever creates automation_conversations; it
  was evidently created out-of-band on production, like user_integrations.

  Column set backfilled here is the full set real application code reads
  or writes (lib/conversation/service.ts, lib/agent/executor.ts) --
  session_id (unique, upserted on), the slot_ and detected_ prefixed
  fields the conversational planner persists, conversation_history,
  required_integrations, collected_credentials, missing_fields (jsonb),
  planner_status, confidence, canonical_prompt, and created_at/updated_at.
  `workflow_id` itself is deliberately NOT included here -- the very next
  migration (20260510124000) adds it with its own `ADD COLUMN IF NOT
  EXISTS`, so it is left to do exactly that, unmodified.

  SAFE FOR PRODUCTION BY CONSTRUCTION: `CREATE TABLE IF NOT EXISTS` is a
  true no-op there, where this table already exists with its real shape.
*/

CREATE TABLE IF NOT EXISTS "public"."automation_conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "text" NOT NULL,
    "user_id" "uuid",
    "current_goal" "text",
    "detected_trigger" "text",
    "detected_action" "text",
    "detected_platform" "text",
    "slot_trigger" "text",
    "slot_action" "text",
    "slot_platform" "text",
    "slot_destination" "text",
    "slot_ai_provider" "text",
    "slot_schedule" "text",
    "required_integrations" "jsonb" DEFAULT '[]'::"jsonb",
    "collected_credentials" "jsonb" DEFAULT '{}'::"jsonb",
    "missing_fields" "jsonb" DEFAULT '[]'::"jsonb",
    "conversation_history" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "planner_status" "text",
    "confidence" numeric,
    "canonical_prompt" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'automation_conversations' AND c.conname = 'automation_conversations_session_id_key'
  ) THEN
    ALTER TABLE "public"."automation_conversations" ADD CONSTRAINT "automation_conversations_session_id_key" UNIQUE ("session_id");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'automation_conversations' AND c.conname = 'automation_conversations_user_id_fkey'
  ) THEN
    ALTER TABLE "public"."automation_conversations"
      ADD CONSTRAINT "automation_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_automation_conversations_user" ON "public"."automation_conversations" USING "btree" ("user_id");

ALTER TABLE "public"."automation_conversations" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'automation_conversations' AND policyname = 'Users can access their own conversations'
  ) THEN
    CREATE POLICY "Users can access their own conversations" ON "public"."automation_conversations"
      FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));
  END IF;
END $$;

-- Explicit grants -- see 20260507105000's identical note (default
-- privileges are not set up until 20260913160000, and never retroactively).
GRANT SELECT ON TABLE "public"."automation_conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."automation_conversations" TO "service_role";
