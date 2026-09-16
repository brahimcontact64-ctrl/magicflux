-- Phase 9.9.11 -- Part D: durable side-effect ledger.
--
-- NOT YET APPLIED TO PRODUCTION -- drafted for review/approval only, per
-- the standing "stop before any schema migration" rule. lib/runtime/
-- side-effect-ledger.ts (which reads/writes this table) is intentionally
-- NOT wired into the live execution path (runtime/node-runner.ts) yet --
-- it ships this phase as designed, coded, and unit-tested against a mocked
-- DB only, so no production code path can ever reference a table that
-- doesn't exist yet.
--
-- Root cause this closes: node-runner.ts's existing in-process retry loop
-- (strengthened this same phase by classifying a network-ambiguous
-- provider outcome as `nonRetryable`) only protects a single attempt
-- within one process. It does NOT protect against the process itself
-- crashing AFTER a provider call has already, definitely succeeded (a
-- confirmed Airtable/Gmail/Slack response was received) but BEFORE that
-- success was persisted anywhere -- on recovery, nothing today can tell a
-- fresh attempt "this exact node's effect already happened, don't call
-- the provider again". None of Airtable, Gmail, or Slack support a
-- caller-supplied idempotency key for the operations this platform
-- performs (see the Phase 9.9.11 report's provider truth table), so this
-- ledger -- claimed via DB uniqueness/CAS BEFORE the provider is ever
-- called -- is the only mechanism that can close that gap.
--
-- Canonical key: (execution_id, node_id) -- conceptually
-- tenant/workflow/execution/node/effect, with user_id/workflow_id kept as
-- their own columns (not folded into one opaque string) so RLS and
-- indexed lookups stay simple, matching every other runtime_* table's
-- existing shape in this schema.
CREATE TABLE IF NOT EXISTS "public"."workflow_side_effects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "execution_id" "uuid" NOT NULL,
    "node_id" "text" NOT NULL,
    -- What kind of effect this is (e.g. 'airtable_create', 'gmail_send',
    -- 'slack_post') -- informational/observability only; uniqueness below
    -- is scoped to (execution_id, node_id), never this column alone, since
    -- a single node performs exactly one effect today.
    "effect_type" "text" NOT NULL,
    "status" "text" NOT NULL DEFAULT 'not_started',
    -- The provider's own response identifier once known (an Airtable
    -- record id, a Gmail messageId, a Slack ts) -- for observability and
    -- manual reconciliation of an 'indeterminate' row, never a secret.
    "provider_ref" "jsonb",
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "workflow_side_effects_status_check" CHECK (
        ("status" = ANY (ARRAY['not_started'::"text", 'in_progress'::"text", 'succeeded'::"text", 'failed'::"text", 'indeterminate'::"text"]))
    )
);

ALTER TABLE "public"."workflow_side_effects" OWNER TO "postgres";

ALTER TABLE ONLY "public"."workflow_side_effects"
    ADD CONSTRAINT "workflow_side_effects_pkey" PRIMARY KEY ("id");

-- The actual CAS uniqueness guarantee: at most one ledger row can ever
-- exist for a given node within a given execution -- an INSERT racing an
-- existing row (concurrent attempt, or a crashed-and-retried attempt)
-- fails with 23505, exactly the same insert-and-catch pattern already
-- proven by runtime_execution_locks.idempotency_key (lib/runtime/idempotency.ts).
ALTER TABLE ONLY "public"."workflow_side_effects"
    ADD CONSTRAINT "workflow_side_effects_execution_node_key" UNIQUE ("execution_id", "node_id");

ALTER TABLE ONLY "public"."workflow_side_effects"
    ADD CONSTRAINT "workflow_side_effects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."workflow_side_effects"
    ADD CONSTRAINT "workflow_side_effects_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."workflow_side_effects"
    ADD CONSTRAINT "workflow_side_effects_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions_v2"("id") ON DELETE CASCADE;

CREATE INDEX "idx_workflow_side_effects_execution" ON "public"."workflow_side_effects" USING "btree" ("execution_id");
CREATE INDEX "idx_workflow_side_effects_workflow" ON "public"."workflow_side_effects" USING "btree" ("workflow_id");
CREATE INDEX "idx_workflow_side_effects_user" ON "public"."workflow_side_effects" USING "btree" ("user_id");
CREATE INDEX "idx_workflow_side_effects_status" ON "public"."workflow_side_effects" USING "btree" ("status");

ALTER TABLE "public"."workflow_side_effects" ENABLE ROW LEVEL SECURITY;

-- Same tenant-isolation shape as every other per-user runtime table in
-- this schema (e.g. workflow_review_items, workflow_executions_v2).
CREATE POLICY "Users can view own side effects" ON "public"."workflow_side_effects" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));
CREATE POLICY "Users can insert own side effects" ON "public"."workflow_side_effects" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));
CREATE POLICY "Users can update own side effects" ON "public"."workflow_side_effects" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));
CREATE POLICY "Users can delete own side effects" ON "public"."workflow_side_effects" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));

GRANT ALL ON TABLE "public"."workflow_side_effects" TO "anon";
GRANT ALL ON TABLE "public"."workflow_side_effects" TO "authenticated";
GRANT ALL ON TABLE "public"."workflow_side_effects" TO "service_role";
