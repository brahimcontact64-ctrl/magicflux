-- Phase 9.9.12 -- Part B/E/H: durable SLA acknowledgment/escalation
-- primitive.
--
-- NOT YET APPLIED TO PRODUCTION -- drafted for review/approval only, per
-- the standing "stop before any schema migration" rule (see the Phase
-- 9.9.11/11A precedent this mirrors). lib/runtime/acknowledgment-resume.ts
-- and lib/workflow-runtime/node-handlers/wait-for-acknowledgment.ts (which
-- read/write this table) are NOT wired into any live route/cron until this
-- migration is explicitly approved and applied -- no production code path
-- can reference a table that does not exist yet.
--
-- Root problem this closes: "notification sent != lead handled". A
-- notification (Gmail/Slack/Airtable, already durable via the Phase
-- 9.9.11A side-effect ledger) proves a message was DELIVERED, never that a
-- human actually took ownership. This table is the durable record of
-- "is anyone accountable for this yet, and by when" -- deliberately
-- separate from workflow_review_items (Phase 9.9.2): Human Review answers
-- "what should the AI have decided instead", acknowledgment answers "has a
-- human taken ownership of an already-decided outcome before a deadline".
-- Conflating the two would make neither concept honest.
--
-- Schema shape mirrors workflow_review_items closely (same tenant/
-- execution identity columns, same crash-safety bookkeeping columns) since
-- it solves a structurally similar problem -- durable pause, a single
-- terminal decision, crash-safe resume -- with two real differences this
-- schema adds: (1) an absolute UTC deadline that can ALSO decide the
-- terminal outcome (never just a human), and (2) an explicit late-
-- acknowledgment record that never overwrites the fact that a breach
-- already occurred (Part H).
CREATE TABLE IF NOT EXISTS "public"."workflow_acknowledgments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "execution_id" "uuid" NOT NULL,
    "node_id" "text" NOT NULL,
    "node_name" "text",
    "deployment_version_id" "uuid",
    "mode" "text" DEFAULT 'live'::"text" NOT NULL,

    -- The only two ways this durable wait can resolve, mirroring
    -- workflow_review_items' own CAS-guarded status column exactly --
    -- 'pending' -> 'acknowledged' XOR 'pending' -> 'timed_out', enforced by
    -- the application's WHERE status = 'pending' compare-and-swap (Part E),
    -- never both, never neither, once resolved.
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,

    -- Absolute UTC deadline (Part I -- V1 is elapsed-duration, never
    -- business-hours-aware; presentation may localize this, storage never
    -- does). This is what runtime/node-runner.ts... no -- what
    -- lib/workflow-runtime/node-handlers/wait-for-acknowledgment.ts hands
    -- the engine as its `nextRunAt`, so the EXISTING durable timer
    -- (lib/runtime/retry-dispatcher.ts's dispatchDueRetries(), already
    -- proven for Wait nodes) is what actually wakes this up -- no new
    -- scheduler/cron is introduced for the timeout side.
    "deadline_at" timestamp with time zone NOT NULL,

    -- Reusable, business-configurable label for which escalation step this
    -- instance represents (Part F) -- purely observational/filterable;
    -- each instance is independently a full state machine regardless of
    -- its level. Multiple levels are composed by chaining multiple
    -- waitForAcknowledgment nodes in the workflow graph, each with its own
    -- node_id (and therefore its own row here) -- never a single row
    -- tracking multiple levels itself.
    "escalation_level" integer DEFAULT 0 NOT NULL,

    -- Set only by a real acknowledgment BEFORE the deadline (status
    -- transitions to 'acknowledged'). NULL for a timed-out row.
    "acknowledged_by" "uuid",
    "acknowledged_at" timestamp with time zone,

    -- Never the plaintext token (Part D/J) -- SHA-256 hex digest only,
    -- compared in constant time. Used for the unauthenticated,
    -- single-use-by-CAS acknowledgment link sent via the notification
    -- itself; NULL when acknowledgment is only ever expected via the
    -- authenticated dashboard action.
    "acknowledgment_token_hash" "text",

    -- Part H -- an acknowledgment that arrives AFTER 'timed_out' already
    -- won is recorded HERE, separately, and status is never rewound back
    -- to 'acknowledged' -- the SLA breach remains a permanent historical
    -- fact even though a human did eventually respond.
    "late_acknowledged_by" "uuid",
    "late_acknowledged_at" timestamp with time zone,

    -- Crash-safety bookkeeping for the decide-then-resume gap, identical
    -- in spirit to workflow_review_items.resume_attempts/last_resume_error
    -- -- resumed_at IS NULL is what a recovery sweep uses to find a
    -- terminal decision (acknowledged/timed_out) that never got resumed.
    "resumed_at" timestamp with time zone,
    "resume_attempts" integer DEFAULT 0 NOT NULL,
    "last_resume_error" "text",

    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "workflow_acknowledgments_status_check" CHECK (
        ("status" = ANY (ARRAY['pending'::"text", 'acknowledged'::"text", 'timed_out'::"text"]))
    ),
    -- A 'pending' row must never carry a terminal decision's own metadata,
    -- and an 'acknowledged' row must always carry it -- mirrors
    -- workflow_review_items' own decision-metadata CHECK constraint
    -- pattern, catching an inconsistent write at the database layer, not
    -- just in application code.
    CONSTRAINT "workflow_acknowledgments_ack_metadata_check" CHECK (
        (("status" = 'acknowledged'::"text" AND "acknowledged_by" IS NOT NULL AND "acknowledged_at" IS NOT NULL)
         OR ("status" <> 'acknowledged'::"text" AND "acknowledged_by" IS NULL AND "acknowledged_at" IS NULL))
    )
);

ALTER TABLE "public"."workflow_acknowledgments" OWNER TO "postgres";

ALTER TABLE ONLY "public"."workflow_acknowledgments"
    ADD CONSTRAINT "workflow_acknowledgments_pkey" PRIMARY KEY ("id");

-- One durable wait per node per execution -- the same canonical identity
-- shape workflow_review_items already uses (execution_id, node_id), which
-- is sufficient here because a single waitForAcknowledgment node instance
-- represents exactly one escalation step; a second step is a SEPARATE node
-- (its own node_id), never a second row for the same node.
ALTER TABLE ONLY "public"."workflow_acknowledgments"
    ADD CONSTRAINT "workflow_acknowledgments_execution_node_key" UNIQUE ("execution_id", "node_id");

ALTER TABLE ONLY "public"."workflow_acknowledgments"
    ADD CONSTRAINT "workflow_acknowledgments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."workflow_acknowledgments"
    ADD CONSTRAINT "workflow_acknowledgments_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."workflow_acknowledgments"
    ADD CONSTRAINT "workflow_acknowledgments_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions_v2"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."workflow_acknowledgments"
    ADD CONSTRAINT "workflow_acknowledgments_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."workflow_acknowledgments"
    ADD CONSTRAINT "workflow_acknowledgments_late_acknowledged_by_fkey" FOREIGN KEY ("late_acknowledged_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

CREATE INDEX "idx_workflow_acknowledgments_execution" ON "public"."workflow_acknowledgments" USING "btree" ("execution_id");
CREATE INDEX "idx_workflow_acknowledgments_workflow" ON "public"."workflow_acknowledgments" USING "btree" ("workflow_id");
CREATE INDEX "idx_workflow_acknowledgments_user" ON "public"."workflow_acknowledgments" USING "btree" ("user_id");
-- Powers both the dashboard's "awaiting acknowledgment" list and the
-- recovery sweep's "acknowledged/timed_out but never resumed" scan.
CREATE INDEX "idx_workflow_acknowledgments_status" ON "public"."workflow_acknowledgments" USING "btree" ("status");
CREATE INDEX "idx_workflow_acknowledgments_deadline" ON "public"."workflow_acknowledgments" USING "btree" ("deadline_at");

ALTER TABLE "public"."workflow_acknowledgments" ENABLE ROW LEVEL SECURITY;

-- Phase 9.9.11A's own RLS lesson applied from the start here (Part J):
-- authenticated users get SELECT ONLY -- read-only dashboard visibility
-- into their own workflows' pending/breached items. Neither the
-- authenticated dashboard "Acknowledge" action nor the unauthenticated
-- token link ever writes through the user's own session/anon key; BOTH
-- acknowledgment routes go through service_role exclusively (the CAS
-- compare-and-swap and the metadata CHECK constraint are the actual
-- correctness/security guarantees, and only the trusted server-side
-- runtime may attempt them), exactly matching workflow_review_items' own
-- decide route and Phase 9.9.11A's workflow_side_effects precedent. No
-- INSERT/UPDATE/DELETE policy exists for authenticated at all -- RLS
-- structurally denies those regardless of any broader table-level grant
-- this project's own default-privileges may still apply (see the Phase
-- 9.9.11A report for why that default grant is harmless: RLS, not the
-- grant, is the actual enforcement layer).
CREATE POLICY "Users can view own acknowledgments" ON "public"."workflow_acknowledgments" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));

GRANT SELECT ON TABLE "public"."workflow_acknowledgments" TO "authenticated";
GRANT ALL ON TABLE "public"."workflow_acknowledgments" TO "service_role";
