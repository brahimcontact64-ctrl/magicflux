-- Phase 9.9.11A -- Part D: durable side-effect ledger.
--
-- Revised from the Phase 9.9.11 draft after the Part 1 safety review this
-- phase explicitly required, before ever applying anything. Two real
-- issues were found and fixed here (never applied in their original form):
--
-- 1) Canonical uniqueness key widened from (execution_id, node_id) to
--    (execution_id, node_id, effect_key). Every CURRENT external node type
--    (Airtable/Gmail/Slack) performs exactly one effect per invocation, so
--    the runtime always passes a constant "primary" effect_key today -- but
--    the schema itself must not assume that stays true forever. A future
--    node performing more than one distinct external effect (e.g. sending
--    to multiple recipients, or a combined multi-provider action) needs
--    each effect independently claimable; baking in the narrower key would
--    have made that a breaking migration later instead of a day-one
--    correct one.
--
-- 2) RLS/grants tightened. The original draft granted authenticated users
--    INSERT/UPDATE/DELETE (scoped only by auth.uid() = user_id) alongside
--    SELECT -- but this ledger's whole purpose is a trusted record of what
--    the SERVER-SIDE runtime observed a provider actually do. A normal
--    authenticated user hitting Supabase's REST API directly with their
--    own session JWT (a real, independently reachable surface, separate
--    from this app's own Next.js routes) could otherwise INSERT a row
--    claiming their own workflow's Airtable/Gmail/Slack node already
--    "succeeded" -- which the runtime is specifically designed to TRUST
--    to skip a real provider call (see runtime/node-runner.ts's ledger
--    wiring). That is forgeable execution state, not mere data leakage.
--    Authenticated users now get SELECT only (read-only observability into
--    their own workflows' side-effect status); only service_role (which
--    RLS never restricts, and which the runtime exclusively writes
--    through via createServiceClient()) can insert/update/delete -- it
--    genuinely needs exactly that, no more.
--
-- Root cause this closes: node-runner.ts's existing in-process retry loop
-- (Phase 9.9.11's indeterminate-outcome classification) only protects a
-- single attempt within one process. It does NOT protect against the
-- process itself crashing AFTER a provider call has already, definitely
-- succeeded but BEFORE that success was persisted anywhere -- on recovery,
-- nothing before this could tell a fresh attempt "this exact effect
-- already happened, don't call the provider again". None of Airtable,
-- Gmail, or Slack support a caller-supplied idempotency key for the
-- operations this platform performs (see the Phase 9.9.11 report's
-- provider truth table), so this ledger -- claimed via DB uniqueness/CAS
-- BEFORE the provider is ever called -- is the mechanism that closes it.
CREATE TABLE IF NOT EXISTS "public"."workflow_side_effects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "execution_id" "uuid" NOT NULL,
    "node_id" "text" NOT NULL,
    -- Disambiguates MULTIPLE distinct external effects a single node could
    -- ever perform in one execution (see the header comment above) -- every
    -- current call site passes the constant "primary", since no existing
    -- node type performs more than one effect, but the constraint below
    -- does not assume that.
    "effect_key" "text" NOT NULL,
    -- What kind of effect this is (e.g. 'airtable_create', 'gmail_send',
    -- 'slack_post') -- informational/observability only, never part of the
    -- uniqueness guarantee (effect_key is).
    "effect_type" "text" NOT NULL,
    "status" "text" NOT NULL DEFAULT 'not_started',
    -- The provider's own response identifier once known (an Airtable
    -- record id, a Gmail messageId, a Slack ts) -- for observability and
    -- manual reconciliation of an 'indeterminate' row, never a secret,
    -- never a message body, never a credential/token.
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
-- exist for a given effect within a given execution -- an INSERT racing an
-- existing row (concurrent attempt, or a crashed-and-retried attempt)
-- fails with 23505, exactly the same insert-and-catch pattern already
-- proven by runtime_execution_locks.idempotency_key (lib/runtime/idempotency.ts).
ALTER TABLE ONLY "public"."workflow_side_effects"
    ADD CONSTRAINT "workflow_side_effects_execution_node_effect_key" UNIQUE ("execution_id", "node_id", "effect_key");

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

-- Read-only for the owning user (observability into their own workflows'
-- side-effect status) -- never write access. Only the trusted server-side
-- runtime (service_role, which RLS does not apply to) claims/records
-- ledger state; a normal authenticated session must never be able to
-- forge a "succeeded"/"indeterminate" row the runtime would trust to skip
-- or refuse a real provider call.
CREATE POLICY "Users can view own side effects" ON "public"."workflow_side_effects" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));

-- No anon access at all -- there is no legitimate unauthenticated use case
-- for side-effect ledger visibility, and service_role (the runtime's own
-- client) never needs it granted explicitly since RLS/grants never
-- restrict that role.
GRANT SELECT ON TABLE "public"."workflow_side_effects" TO "authenticated";
GRANT ALL ON TABLE "public"."workflow_side_effects" TO "service_role";
