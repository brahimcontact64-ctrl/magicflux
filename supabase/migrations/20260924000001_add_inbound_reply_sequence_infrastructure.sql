/*
  # Workflow #2 Phase A -- Inbound Reply Detection & Sequence Cancellation
  # Foundation (generic runtime infrastructure, not Workflow #2-specific)

  PROPOSED MIGRATION -- NOT YET APPLIED. Presented for approval per the
  standing migration-safety instruction; STOP before applying. This
  milestone is explicitly scoped to design/code/test locally only.

  ============================================================================
  WHY THIS SHAPE
  ============================================================================

  Generic, reusable correlation model requested by Phase A, independent of
  any specific workflow, provider, or lead-qualification vocabulary:

    outbound message  <-->  conversation/thread  <-->  lead/entity
           <-->  workflow execution  <-->  follow-up sequence

  Four new tables, each additive, each following the exact conventions
  already established by platform_connections (Phase 9.9.22A) and
  workflow_qualification_decisions (Phase 9.9.13/15):

  1. runtime_conversations -- one row per (workflow, provider, provider
     thread id). The stable anchor a reply's thread id resolves to. Carries
     an optional, deliberately untyped `entity_reference` (free text) so
     this stays decoupled from any specific "lead" concept a calling
     workflow might use (e.g. a qualification_decision id, an external CRM
     id, or nothing at all) -- this table has no opinion on what a "lead" is.

  2. runtime_followup_sequences -- the state machine this milestone exists
     to protect: active | completed | cancelled | replied. One row per
     follow-up sequence; a conversation could in principle have more than
     one sequence over its lifetime (e.g. a later re-engagement campaign),
     so this is kept as its own table rather than collapsed into
     runtime_conversations, even though Phase A itself only ever creates one
     sequence per conversation.

  3. runtime_outbound_messages -- correlation metadata for each message sent
     as part of a sequence (provider message id, thread id, In-Reply-To).
     Populated by a FUTURE follow-up-sending node handler (out of scope this
     phase -- no such node is built or wired in yet); the table and its
     storage function exist now so that work has something correct to write
     to instead of improvising a shape later.

  4. runtime_inbound_reply_events -- the idempotent inbound-event log. UNIQUE
     (provider, provider_message_id) is the sole authority for "have we
     already processed this exact inbound message" -- mirrors
     runtime_execution_locks' insert-and-catch-23505 pattern (Phase 9.9.11,
     lib/runtime/idempotency.ts) rather than inventing a new idempotency
     mechanism. Deliberately minimizes PII: no message body, no raw
     recipient list, sender kept only as a domain (for observability) plus a
     one-way SHA-256 hash (allows an exact-match comparison later without
     ever storing the plaintext address).

  ============================================================================
  ATOMIC STATE TRANSITION -- mirrors record_lead_outcome_atomic() exactly
  (Phase 9.9.15A Part F precedent: CAS UPDATE + audit event append as ONE
  atomic unit, so a crash between "sequence marked replied" and "audit event
  exists" is structurally impossible).
  ============================================================================

  transition_followup_sequence_atomic(sequence_id, user_id, target_status,
  reason, inbound_reply_event_id) enforces:
    - Only 'active' -> 'replied' | 'cancelled' | 'completed' is a real
      transition.
    - Requesting the sequence's OWN current terminal status again is an
      idempotent no-op (ok=true, already_in_state=true) -- required by Phase
      A's own test list ("reply to already-replied sequence").
    - Requesting a DIFFERENT terminal status than the one already recorded
      is safely rejected (ok=false) -- a reply can never un-cancel or
      un-complete a sequence, and a cancel can never overwrite a reply.
    - A lost CAS race (concurrent transition) re-reads and reports the
      actual current status; it NEVER writes an audit event for a
      transition that did not actually happen.
    - On a real transition, appends a runtime_execution_events row
      ('sequence_replied' / 'sequence_cancelled' / 'sequence_completed', per
      target_status) in the SAME transaction via the existing
      append_execution_event() RPC (Phase 13), exactly as
      record_lead_outcome_atomic() already does -- not duplicated.

  Deliberately NOT SECURITY DEFINER (same reasoning as
  record_lead_outcome_atomic itself): runs as whichever role already has
  genuine write access to these three tables, which is exclusively
  service_role in this codebase. EXECUTE revoked from PUBLIC/anon/
  authenticated explicitly (Phase 9.9.22A's own finding: this project's
  default privileges grant EXECUTE directly to anon/authenticated, so
  revoking from PUBLIC alone is insufficient), granted only to service_role.

  ============================================================================
  OWNERSHIP ENFORCEMENT
  ============================================================================

  Four trigger functions, one per table (runtime_conversations_enforce_owner,
  runtime_followup_sequences_enforce_owner,
  runtime_outbound_messages_enforce_owner,
  runtime_inbound_reply_events_enforce_owner), each mirroring
  platform_connections_enforce_owner() exactly: BEFORE INSERT/UPDATE,
  verifies user_id actually owns every FK'd row the new/updated row
  references (workflow_id; conversation_id; sequence_id; and, where
  non-null, matched_conversation_id/matched_sequence_id) -- a DB-level
  backstop independent of and in addition to RLS/application checks, never
  SECURITY DEFINER, no privilege escalation.

  ============================================================================
  RLS
  ============================================================================

  Same posture as platform_connections/workflow_acknowledgments: SELECT-only
  for authenticated (auth.uid() = user_id), scoped per row -- read-only
  dashboard/observability visibility into a tenant's own conversations/
  sequences/inbound events. No INSERT/UPDATE/DELETE policy for authenticated
  at all; every write (poller, correlation, CAS transition) is service-role
  only. anon has no GRANT at all.

  runtime_outbound_messages has NO SELECT policy for authenticated in this
  migration -- it exists purely as internal correlation plumbing for a
  future send-node and the correlation algorithm; nothing in Phase A's own
  scope needs to expose it to a dashboard yet. Adding one later is a pure
  additive migration.

  ============================================================================
  INDEXES / CONSTRAINTS
  ============================================================================

  - runtime_conversations: UNIQUE (workflow_id, provider, provider_thread_id)
    -- one conversation row per thread per workflow; index on
    (provider, provider_thread_id) for thread-id correlation lookups.
  - runtime_followup_sequences: index on (conversation_id), index on
    (status) for the "find all active sequences due for a send-time check"
    access pattern a future send node will use.
  - runtime_outbound_messages: UNIQUE (provider, provider_message_id); index
    on (provider, provider_thread_id) and on (sequence_id).
  - runtime_inbound_reply_events: UNIQUE (provider, provider_message_id) --
    the sole idempotency authority; index on (correlation_status) and on
    (matched_sequence_id) for observability queries.

  ============================================================================
  ROLLBACK
  ============================================================================

  Purely additive -- four new tables (runtime_conversations,
  runtime_followup_sequences, runtime_outbound_messages,
  runtime_inbound_reply_events), four new ownership-enforcement trigger
  functions + triggers (one per table, added during Phase B pre-flight
  review so all four match platform_connections_enforce_owner()'s
  precedent, not just the first two), and one new atomic transition
  function (transition_followup_sequence_atomic) -- zero changes to any
  existing table, column, function, or row.

  Corrected here (this note previously under-counted the tables/triggers
  and named a function, runtime_inbound_reply_enforce_owner, that was never
  actually created -- a documentation-accuracy defect caught during Phase B
  pre-flight review, fixed alongside the missing triggers it was describing
  incompletely).

  Rollback, in dependency order:
    DROP TRIGGER runtime_inbound_reply_events_enforce_owner_trigger ON runtime_inbound_reply_events;
    DROP TRIGGER runtime_outbound_messages_enforce_owner_trigger ON runtime_outbound_messages;
    DROP TRIGGER runtime_followup_sequences_enforce_owner_trigger ON runtime_followup_sequences;
    DROP TRIGGER runtime_conversations_enforce_owner_trigger ON runtime_conversations;
    DROP FUNCTION transition_followup_sequence_atomic(uuid, uuid, text, text, uuid);
    DROP FUNCTION runtime_inbound_reply_events_enforce_owner();
    DROP FUNCTION runtime_outbound_messages_enforce_owner();
    DROP FUNCTION runtime_followup_sequences_enforce_owner();
    DROP FUNCTION runtime_conversations_enforce_owner();
    DROP TABLE runtime_inbound_reply_events;
    DROP TABLE runtime_outbound_messages;
    DROP TABLE runtime_followup_sequences;
    DROP TABLE runtime_conversations;
  (Dropping a table also drops its own triggers/indexes/constraints
  automatically -- the explicit DROP TRIGGER/FUNCTION statements above only
  matter if rolling back the functions/triggers alone, without dropping the
  tables.) No data migration, no existing-row rewrite, nothing else to undo.
*/

CREATE TABLE "public"."runtime_conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "execution_id" "uuid",
    "provider" "text" NOT NULL,
    "provider_thread_id" "text" NOT NULL,
    -- Deliberately untyped/free-form: this table has no opinion on what a
    -- "lead" or business entity is. A calling workflow may store a
    -- qualification_decision id, an external CRM id, or leave this null.
    "entity_reference" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "runtime_conversations_provider_check" CHECK (("provider" <> ''))
);

ALTER TABLE "public"."runtime_conversations" OWNER TO "postgres";

ALTER TABLE ONLY "public"."runtime_conversations"
    ADD CONSTRAINT "runtime_conversations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."runtime_conversations"
    ADD CONSTRAINT "runtime_conversations_workflow_provider_thread_key" UNIQUE ("workflow_id", "provider", "provider_thread_id");

ALTER TABLE ONLY "public"."runtime_conversations"
    ADD CONSTRAINT "runtime_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."runtime_conversations"
    ADD CONSTRAINT "runtime_conversations_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE;

CREATE INDEX "idx_runtime_conversations_user" ON "public"."runtime_conversations" USING "btree" ("user_id");
-- Phase B pre-flight review finding: findConversationByThreadId() (the
-- correlation algorithm's own hottest lookup) filters by
-- (user_id, provider, provider_thread_id) together -- a plain
-- (provider, provider_thread_id) index still works (Postgres uses it, then
-- filters user_id from the returned rows/heap), but leads with the two
-- columns least selective for THIS query's actual access pattern. Reordered
-- to match the real query shape exactly.
CREATE INDEX "idx_runtime_conversations_thread" ON "public"."runtime_conversations" USING "btree" ("user_id", "provider", "provider_thread_id");
CREATE INDEX "idx_runtime_conversations_execution" ON "public"."runtime_conversations" USING "btree" ("execution_id");


CREATE TABLE "public"."runtime_followup_sequences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "execution_id" "uuid",
    "conversation_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "replied_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "last_transition_reason" "text",

    CONSTRAINT "runtime_followup_sequences_status_check" CHECK (
        ("status" = ANY (ARRAY['active'::"text", 'completed'::"text", 'cancelled'::"text", 'replied'::"text"]))
    )
);

ALTER TABLE "public"."runtime_followup_sequences" OWNER TO "postgres";

ALTER TABLE ONLY "public"."runtime_followup_sequences"
    ADD CONSTRAINT "runtime_followup_sequences_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."runtime_followup_sequences"
    ADD CONSTRAINT "runtime_followup_sequences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."runtime_followup_sequences"
    ADD CONSTRAINT "runtime_followup_sequences_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."runtime_followup_sequences"
    ADD CONSTRAINT "runtime_followup_sequences_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."runtime_conversations"("id") ON DELETE CASCADE;

CREATE INDEX "idx_runtime_followup_sequences_user" ON "public"."runtime_followup_sequences" USING "btree" ("user_id");
CREATE INDEX "idx_runtime_followup_sequences_conversation" ON "public"."runtime_followup_sequences" USING "btree" ("conversation_id");
CREATE INDEX "idx_runtime_followup_sequences_status" ON "public"."runtime_followup_sequences" USING "btree" ("status");


CREATE TABLE "public"."runtime_outbound_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "sequence_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_message_id" "text" NOT NULL,
    "provider_thread_id" "text",
    "in_reply_to_message_id" "text",
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."runtime_outbound_messages" OWNER TO "postgres";

ALTER TABLE ONLY "public"."runtime_outbound_messages"
    ADD CONSTRAINT "runtime_outbound_messages_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."runtime_outbound_messages"
    ADD CONSTRAINT "runtime_outbound_messages_provider_message_key" UNIQUE ("provider", "provider_message_id");

ALTER TABLE ONLY "public"."runtime_outbound_messages"
    ADD CONSTRAINT "runtime_outbound_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."runtime_outbound_messages"
    ADD CONSTRAINT "runtime_outbound_messages_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "public"."runtime_followup_sequences"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."runtime_outbound_messages"
    ADD CONSTRAINT "runtime_outbound_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."runtime_conversations"("id") ON DELETE CASCADE;

CREATE INDEX "idx_runtime_outbound_messages_thread" ON "public"."runtime_outbound_messages" USING "btree" ("provider", "provider_thread_id");
CREATE INDEX "idx_runtime_outbound_messages_sequence" ON "public"."runtime_outbound_messages" USING "btree" ("sequence_id");


CREATE TABLE "public"."runtime_inbound_reply_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_message_id" "text" NOT NULL,
    "provider_thread_id" "text",
    "in_reply_to" "text",
    "references_header" "text",
    -- Minimized PII (Phase A explicit requirement): never the raw sender
    -- address. sender_domain is low-sensitivity and useful for
    -- observability; sender_hash (SHA-256 of the lowercased, trimmed
    -- address) allows an exact-match comparison without ever storing or
    -- displaying the plaintext address anywhere, including in this table.
    "sender_domain" "text",
    "sender_hash" "text",
    "received_at" timestamp with time zone NOT NULL,
    "correlation_status" "text" NOT NULL,
    "matched_conversation_id" "uuid",
    "matched_sequence_id" "uuid",
    "processed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "runtime_inbound_reply_events_correlation_status_check" CHECK (
        ("correlation_status" = ANY (ARRAY['strong_match'::"text", 'ambiguous'::"text", 'no_match'::"text"]))
    )
);

ALTER TABLE "public"."runtime_inbound_reply_events" OWNER TO "postgres";

ALTER TABLE ONLY "public"."runtime_inbound_reply_events"
    ADD CONSTRAINT "runtime_inbound_reply_events_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."runtime_inbound_reply_events"
    ADD CONSTRAINT "runtime_inbound_reply_events_provider_message_key" UNIQUE ("provider", "provider_message_id");

ALTER TABLE ONLY "public"."runtime_inbound_reply_events"
    ADD CONSTRAINT "runtime_inbound_reply_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."runtime_inbound_reply_events"
    ADD CONSTRAINT "runtime_inbound_reply_events_matched_conversation_id_fkey" FOREIGN KEY ("matched_conversation_id") REFERENCES "public"."runtime_conversations"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."runtime_inbound_reply_events"
    ADD CONSTRAINT "runtime_inbound_reply_events_matched_sequence_id_fkey" FOREIGN KEY ("matched_sequence_id") REFERENCES "public"."runtime_followup_sequences"("id") ON DELETE SET NULL;

CREATE INDEX "idx_runtime_inbound_reply_events_user" ON "public"."runtime_inbound_reply_events" USING "btree" ("user_id");
CREATE INDEX "idx_runtime_inbound_reply_events_correlation_status" ON "public"."runtime_inbound_reply_events" USING "btree" ("correlation_status");
CREATE INDEX "idx_runtime_inbound_reply_events_matched_sequence" ON "public"."runtime_inbound_reply_events" USING "btree" ("matched_sequence_id");


-- ============================================================================
-- Ownership enforcement -- mirrors platform_connections_enforce_owner()
-- exactly (Phase 9.9.22A precedent).
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."runtime_conversations_enforce_owner"()
RETURNS "trigger"
LANGUAGE "plpgsql"
SET "search_path" TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."workflows"
    WHERE "id" = NEW."workflow_id" AND "user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'runtime_conversations.user_id (%) does not own workflow_id (%)', NEW."user_id", NEW."workflow_id";
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."runtime_conversations_enforce_owner"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."runtime_conversations_enforce_owner"() FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."runtime_conversations_enforce_owner"() TO "service_role";

CREATE TRIGGER "runtime_conversations_enforce_owner_trigger"
    BEFORE INSERT OR UPDATE OF "user_id", "workflow_id" ON "public"."runtime_conversations"
    FOR EACH ROW EXECUTE FUNCTION "public"."runtime_conversations_enforce_owner"();


CREATE OR REPLACE FUNCTION "public"."runtime_followup_sequences_enforce_owner"()
RETURNS "trigger"
LANGUAGE "plpgsql"
SET "search_path" TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."workflows"
    WHERE "id" = NEW."workflow_id" AND "user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'runtime_followup_sequences.user_id (%) does not own workflow_id (%)', NEW."user_id", NEW."workflow_id";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "public"."runtime_conversations"
    WHERE "id" = NEW."conversation_id" AND "user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'runtime_followup_sequences.user_id (%) does not own conversation_id (%)', NEW."user_id", NEW."conversation_id";
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."runtime_followup_sequences_enforce_owner"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."runtime_followup_sequences_enforce_owner"() FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."runtime_followup_sequences_enforce_owner"() TO "service_role";

CREATE TRIGGER "runtime_followup_sequences_enforce_owner_trigger"
    BEFORE INSERT OR UPDATE OF "user_id", "workflow_id", "conversation_id" ON "public"."runtime_followup_sequences"
    FOR EACH ROW EXECUTE FUNCTION "public"."runtime_followup_sequences_enforce_owner"();


-- Phase B pre-flight review finding: runtime_outbound_messages and
-- runtime_inbound_reply_events were drafted WITHOUT this same
-- ownership-enforcement trigger, unlike the two tables above -- an
-- oversight relative to this migration's own stated goal of mirroring
-- platform_connections_enforce_owner() throughout. Both writers are
-- service_role-only today (no INSERT policy exists for authenticated on
-- any of these four tables), so this is not exploitable by an end-user
-- request as things stand -- but Phase 9.9.22A's own precedent treats this
-- exact class of trigger as DB-level defense-in-depth independent of and
-- in addition to that application-level guarantee, not merely a redundant
-- check with it. Fixed here, before checkpoint, rather than left as a
-- silent inconsistency with the two tables directly above.
CREATE OR REPLACE FUNCTION "public"."runtime_outbound_messages_enforce_owner"()
RETURNS "trigger"
LANGUAGE "plpgsql"
SET "search_path" TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."runtime_followup_sequences"
    WHERE "id" = NEW."sequence_id" AND "user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'runtime_outbound_messages.user_id (%) does not own sequence_id (%)', NEW."user_id", NEW."sequence_id";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "public"."runtime_conversations"
    WHERE "id" = NEW."conversation_id" AND "user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'runtime_outbound_messages.user_id (%) does not own conversation_id (%)', NEW."user_id", NEW."conversation_id";
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."runtime_outbound_messages_enforce_owner"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."runtime_outbound_messages_enforce_owner"() FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."runtime_outbound_messages_enforce_owner"() TO "service_role";

CREATE TRIGGER "runtime_outbound_messages_enforce_owner_trigger"
    BEFORE INSERT OR UPDATE OF "user_id", "sequence_id", "conversation_id" ON "public"."runtime_outbound_messages"
    FOR EACH ROW EXECUTE FUNCTION "public"."runtime_outbound_messages_enforce_owner"();


-- matched_conversation_id/matched_sequence_id are nullable (an
-- 'ambiguous'/'no_match' inbound event legitimately has neither) --
-- ownership is only checked when a match is actually recorded.
CREATE OR REPLACE FUNCTION "public"."runtime_inbound_reply_events_enforce_owner"()
RETURNS "trigger"
LANGUAGE "plpgsql"
SET "search_path" TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW."matched_conversation_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "public"."runtime_conversations"
    WHERE "id" = NEW."matched_conversation_id" AND "user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'runtime_inbound_reply_events.user_id (%) does not own matched_conversation_id (%)', NEW."user_id", NEW."matched_conversation_id";
  END IF;

  IF NEW."matched_sequence_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "public"."runtime_followup_sequences"
    WHERE "id" = NEW."matched_sequence_id" AND "user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'runtime_inbound_reply_events.user_id (%) does not own matched_sequence_id (%)', NEW."user_id", NEW."matched_sequence_id";
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."runtime_inbound_reply_events_enforce_owner"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."runtime_inbound_reply_events_enforce_owner"() FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."runtime_inbound_reply_events_enforce_owner"() TO "service_role";

CREATE TRIGGER "runtime_inbound_reply_events_enforce_owner_trigger"
    BEFORE INSERT OR UPDATE OF "user_id", "matched_conversation_id", "matched_sequence_id" ON "public"."runtime_inbound_reply_events"
    FOR EACH ROW EXECUTE FUNCTION "public"."runtime_inbound_reply_events_enforce_owner"();


-- ============================================================================
-- transition_followup_sequence_atomic() -- the CAS transition + audit event
-- as ONE atomic unit (Phase 9.9.15A Part F precedent). See header comment
-- above for the full transition-table rationale.
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."transition_followup_sequence_atomic"(
    p_sequence_id uuid,
    p_user_id uuid,
    p_target_status text,
    p_reason text,
    p_inbound_reply_event_id uuid
)
RETURNS TABLE(
    ok boolean,
    already_in_state boolean,
    previous_status text,
    new_status text,
    current_status text,
    execution_id uuid,
    workflow_id uuid,
    reason text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row RECORD;
  v_updated_id uuid;
  v_fresh_status text;
  v_event_type text;
  v_timestamp_column text;
BEGIN
  IF p_target_status NOT IN ('replied', 'cancelled', 'completed') THEN
    RETURN QUERY SELECT false, false, NULL::text, p_target_status, NULL::text, NULL::uuid, NULL::uuid, 'target_status must be replied, cancelled, or completed.';
    RETURN;
  END IF;

  SELECT s.id, s.status, s.execution_id, s.workflow_id
    INTO v_row
    FROM "public"."runtime_followup_sequences" s
   WHERE s.id = p_sequence_id
     AND s.user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, NULL::text, p_target_status, NULL::text, NULL::uuid, NULL::uuid, 'Follow-up sequence not found.';
    RETURN;
  END IF;

  -- Idempotent no-op: already in the exact target state -- no audit event,
  -- no duplicate lifecycle transition (Phase A requirement: the same
  -- inbound message, or a duplicate transition request, must never cancel
  -- a sequence twice).
  IF v_row.status = p_target_status THEN
    RETURN QUERY SELECT true, true, v_row.status, p_target_status, v_row.status, v_row.execution_id, v_row.workflow_id, NULL::text;
    RETURN;
  END IF;

  -- Every non-active status is terminal -- a reply can never un-cancel or
  -- un-complete a sequence, and a cancel can never overwrite a reply.
  IF v_row.status <> 'active' THEN
    RETURN QUERY SELECT false, false, v_row.status, p_target_status, v_row.status, v_row.execution_id, v_row.workflow_id,
      format('Sequence already in terminal state "%s" -- cannot transition to "%s".', v_row.status, p_target_status);
    RETURN;
  END IF;

  v_timestamp_column := CASE p_target_status
    WHEN 'replied' THEN 'replied_at'
    WHEN 'cancelled' THEN 'cancelled_at'
    WHEN 'completed' THEN 'completed_at'
  END;

  -- CAS UPDATE: only applies if the row is STILL 'active' as just observed.
  BEGIN
    EXECUTE format(
      'UPDATE "public"."runtime_followup_sequences"
          SET status = $1, %I = now(), last_transition_reason = $2, updated_at = now()
        WHERE id = $3 AND user_id = $4 AND status = $5
       RETURNING id',
      v_timestamp_column
    )
    INTO v_updated_id
    USING p_target_status, p_reason, p_sequence_id, p_user_id, v_row.status;
  EXCEPTION WHEN check_violation THEN
    RETURN QUERY SELECT false, false, NULL::text, p_target_status, NULL::text, NULL::uuid, NULL::uuid, ('Invalid transition data: ' || SQLERRM);
    RETURN;
  END;

  IF v_updated_id IS NULL THEN
    -- Lost the race to a concurrent transition -- re-read, NEVER write an
    -- audit event for a transition that did not actually happen.
    SELECT s.status INTO v_fresh_status FROM "public"."runtime_followup_sequences" s WHERE s.id = p_sequence_id;
    RETURN QUERY SELECT false, false, NULL::text, p_target_status, v_fresh_status, v_row.execution_id, v_row.workflow_id,
      format('Sequence was concurrently transitioned to "%s" by another action.', v_fresh_status);
    RETURN;
  END IF;

  v_event_type := 'sequence_' || p_target_status;

  -- Audit -- same transaction as the UPDATE above, via the existing
  -- append_execution_event() RPC (Phase 13), not duplicated.
  PERFORM "public"."append_execution_event"(
    COALESCE(v_row.execution_id::text, p_sequence_id::text),
    v_row.workflow_id::text,
    p_user_id,
    NULL,
    v_event_type,
    1,
    NULL, NULL, NULL, NULL,
    jsonb_build_object(
      'sequence_id', p_sequence_id,
      'previous_status', v_row.status,
      'new_status', p_target_status,
      'reason', p_reason,
      'inbound_reply_event_id', p_inbound_reply_event_id
    ),
    jsonb_build_object('source', 'inbound_reply')
  );

  RETURN QUERY SELECT true, false, v_row.status, p_target_status, p_target_status, v_row.execution_id, v_row.workflow_id, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION "public"."transition_followup_sequence_atomic"(uuid, uuid, text, text, uuid) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."transition_followup_sequence_atomic"(uuid, uuid, text, text, uuid) TO "service_role";


-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE "public"."runtime_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."runtime_followup_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."runtime_outbound_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."runtime_inbound_reply_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own conversations" ON "public"."runtime_conversations" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));
CREATE POLICY "Users can view own followup sequences" ON "public"."runtime_followup_sequences" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));
CREATE POLICY "Users can view own inbound reply events" ON "public"."runtime_inbound_reply_events" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));
-- runtime_outbound_messages intentionally has NO policy for authenticated
-- (see header note) -- RLS is enabled with zero policies, so it is denied
-- by default for every non-service role.

GRANT SELECT ON TABLE "public"."runtime_conversations" TO "authenticated";
GRANT SELECT ON TABLE "public"."runtime_followup_sequences" TO "authenticated";
GRANT SELECT ON TABLE "public"."runtime_inbound_reply_events" TO "authenticated";

-- Workflow #2 Phase D.1 local-bootstrap finding, fixed here (genuine
-- correctness defect in this already-checkpointed migration, confirmed by
-- direct local reproduction -- see the Phase D.1 report's own section on
-- this): BYPASSRLS (which service_role has) only skips ROW-LEVEL policy
-- checks: it does NOT grant table-level SELECT/INSERT/UPDATE/DELETE
-- privileges, which are a completely separate, orthogonal Postgres
-- permission layer. Every function in lib/runtime/inbound-reply/storage.ts
-- writes via createServiceClient() (the service_role key) -- without these
-- grants, every one of those calls fails with "permission denied for
-- table ..." the instant this migration is applied anywhere, exactly as
-- reproduced against a real local Postgres instance during Phase D.1.
-- Mirrors the exact grant platform_connections (Phase 9.9.22A,
-- 20260923000001, already live in production) already correctly includes
-- for itself -- this migration simply omitted the equivalent grants for
-- its own four new tables.
GRANT ALL ON TABLE "public"."runtime_conversations" TO "service_role";
GRANT ALL ON TABLE "public"."runtime_followup_sequences" TO "service_role";
GRANT ALL ON TABLE "public"."runtime_outbound_messages" TO "service_role";
GRANT ALL ON TABLE "public"."runtime_inbound_reply_events" TO "service_role";
