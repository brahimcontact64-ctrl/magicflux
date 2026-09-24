/*
  # Workflow #2 Phase B -- Guarded Follow-up Sending: send-lock + attempt key

  PROPOSED MIGRATION -- NOT YET APPLIED. Presented for approval per the
  standing migration-safety instruction; STOP before applying. Phase A's
  own migration (20260924000001) is deliberately left untouched -- this is
  a separate, additive migration, per instruction, not a rewrite of an
  already-checkpointed one.

  ============================================================================
  WHY THIS IS NEEDED -- the race Phase A's send-guard alone does not close
  ============================================================================

  Phase A's assertSequenceSendable() is a plain read immediately before a
  send. That is necessary but NOT sufficient: "read status, then make a
  network call" always leaves a window between the read and the provider
  call where a reply can commit. No purely check-then-act pattern closes
  this without either (a) making the provider call itself transactional
  with the database, which no email API supports, or (b) accepting a
  bounded, honestly-disclosed residual window and minimizing it as far as
  practical. This migration implements (b) as narrowly as possible:

  1. A per-sequence send LEASE (send_lock_token/send_lock_expires_at,
     added to the existing runtime_followup_sequences table -- Phase A's
     own table, extended additively, not duplicated into a parallel one).
     Acquiring it is itself a CAS: it only succeeds if the sequence is
     STILL 'active' AND no other lease is currently held. This closes the
     "two concurrent send attempts for the same sequence both fire" race
     completely (only one can hold the lease at a time).

  2. Crucially, the lease does NOT change the sequence's own `status`
     column, and Phase A's transition_followup_sequence_atomic() is
     UNCHANGED and UNAWARE of the lease entirely -- a reply's transition to
     'replied' always succeeds the instant it's 'active', lease or no
     lease. This is deliberate: a send lease must never be able to block or
     delay a genuine stop-on-reply signal. The residual race this migration
     does NOT and CANNOT close is: the lease is acquired while 'active',
     the provider call is in flight, and a reply commits DURING that
     network round trip -- the email has, by that point, already been
     handed to Gmail and cannot be recalled. This is inherent to sending
     through any external provider API and is not specific to this
     implementation; it is minimized (the window is now only the length of
     one Gmail API round trip, not an entire poll interval) and made fully
     observable (the send path re-checks sequence status immediately after
     a successful send and records a distinct `sent_during_race_window`
     flag on the outbound message when this occurs) rather than hidden.

  3. A lease has a bounded expiry (send_lock_expires_at), mirroring
     runtime_execution_locks.lease_expires_at / reclaimOrphanedIdempotencyLocks()'s
     established pattern (lib/runtime/idempotency.ts, Phase 9.9.14) exactly:
     a crashed sender's lease is never held forever -- it simply expires and
     becomes acquirable again after the lease window passes.

  4. attempt_key (added to runtime_outbound_messages, Phase A's own table):
     an optional, caller-supplied stable identifier for "this exact logical
     follow-up attempt" (e.g. "<sequenceId>:step-1"), UNIQUE when present.
     This is the FAST, CHEAP check for "was this exact attempt already
     recorded as successfully sent" -- checked BEFORE even acquiring the
     send lease, so a retry of an already-succeeded attempt never re-sends
     at all, not even via the lease path. This is the mechanism behind
     Phase B's stated at-most-once design; see the report's own "Send
     Idempotency/Retry Semantics" section for the explicit, honest
     statement of what this can and cannot guarantee (Gmail's
     messages.send has NO server-side idempotency key -- a crash in the
     exact window between Gmail accepting the send and this attempt_key row
     being written is a real, disclosed, unclosed gap, not something this
     migration claims to solve).

  ============================================================================
  ROLLBACK
  ============================================================================

  Purely additive -- two nullable columns on runtime_followup_sequences
  (send_lock_token, send_lock_expires_at), one nullable+conditionally-unique
  column on runtime_outbound_messages (attempt_key), and two new atomic
  functions (acquire_followup_send_lock_atomic,
  release_followup_send_lock_atomic). Zero changes to any existing row,
  and zero changes to the Phase A migration file itself.

  Rollback:
    DROP FUNCTION release_followup_send_lock_atomic(uuid, uuid, uuid);
    DROP FUNCTION acquire_followup_send_lock_atomic(uuid, uuid, uuid, integer);
    ALTER TABLE runtime_outbound_messages DROP CONSTRAINT runtime_outbound_messages_attempt_key_key;
    ALTER TABLE runtime_outbound_messages DROP COLUMN attempt_key;
    ALTER TABLE runtime_followup_sequences DROP COLUMN send_lock_token;
    ALTER TABLE runtime_followup_sequences DROP COLUMN send_lock_expires_at;
  No data migration, no existing-row rewrite -- every existing row simply
  has these new columns as NULL.
*/

ALTER TABLE "public"."runtime_followup_sequences"
    ADD COLUMN IF NOT EXISTS "send_lock_token" "uuid";

ALTER TABLE "public"."runtime_followup_sequences"
    ADD COLUMN IF NOT EXISTS "send_lock_expires_at" timestamp with time zone;

ALTER TABLE "public"."runtime_outbound_messages"
    ADD COLUMN IF NOT EXISTS "attempt_key" "text";

-- Set (never just logged) when the send path's own post-send re-check
-- finds the sequence was transitioned away from 'active' DURING the
-- provider network call -- the one race window this migration's lease
-- cannot close (see header note). Durable, not just a transient log line,
-- so a real occurrence is queryable/auditable after the fact, not only
-- visible in whatever log retention window happens to still have it.
ALTER TABLE "public"."runtime_outbound_messages"
    ADD COLUMN IF NOT EXISTS "sent_during_race_window" boolean DEFAULT false NOT NULL;

ALTER TABLE ONLY "public"."runtime_outbound_messages"
    ADD CONSTRAINT "runtime_outbound_messages_attempt_key_key" UNIQUE ("attempt_key");

-- Postgres UNIQUE constraints already treat multiple NULLs as
-- non-conflicting (NULL is never equal to NULL), so callers that don't
-- supply an attempt_key are entirely unaffected -- this column is optional.

CREATE INDEX "idx_runtime_outbound_messages_attempt_key" ON "public"."runtime_outbound_messages" USING "btree" ("attempt_key");

-- ============================================================================
-- acquire_followup_send_lock_atomic() -- the CAS lease acquisition. Never
-- SECURITY DEFINER (same posture as transition_followup_sequence_atomic
-- and record_lead_outcome_atomic): runs as service_role, which already has
-- full write access to this table.
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."acquire_followup_send_lock_atomic"(
    p_sequence_id uuid,
    p_user_id uuid,
    p_lock_token uuid,
    p_lease_seconds integer
)
RETURNS TABLE(
    ok boolean,
    reason text,
    current_status text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated_id uuid;
  v_status text;
BEGIN
  SELECT s.status INTO v_status
    FROM "public"."runtime_followup_sequences" s
   WHERE s.id = p_sequence_id AND s.user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Follow-up sequence not found.', NULL::text;
    RETURN;
  END IF;

  IF v_status <> 'active' THEN
    RETURN QUERY SELECT false, format('Sequence is "%s", not active.', v_status), v_status;
    RETURN;
  END IF;

  -- CAS: only acquires if STILL active AND no unexpired lease is held.
  -- Two concurrent acquisition attempts for the same sequence can never
  -- both succeed -- Postgres's row-level UPDATE locking serializes them,
  -- and the second to proceed re-evaluates this WHERE clause against the
  -- first's now-committed lock_token/expiry and correctly finds 0 rows.
  UPDATE "public"."runtime_followup_sequences"
     SET send_lock_token = p_lock_token,
         send_lock_expires_at = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   WHERE id = p_sequence_id
     AND user_id = p_user_id
     AND status = 'active'
     AND (send_lock_token IS NULL OR send_lock_expires_at <= now())
  RETURNING id INTO v_updated_id;

  IF v_updated_id IS NULL THEN
    -- Lost the race -- either a reply just transitioned the sequence away
    -- from 'active' (re-read below for an accurate reason), or another
    -- send attempt is already holding an unexpired lease.
    SELECT s.status INTO v_status FROM "public"."runtime_followup_sequences" s WHERE s.id = p_sequence_id;
    IF v_status <> 'active' THEN
      RETURN QUERY SELECT false, format('Sequence transitioned to "%s" concurrently with this send attempt.', v_status), v_status;
    ELSE
      RETURN QUERY SELECT false, 'Another send attempt currently holds this sequence''s send lock.', v_status;
    END IF;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, NULL::text, 'active'::text;
END;
$$;

REVOKE ALL ON FUNCTION "public"."acquire_followup_send_lock_atomic"(uuid, uuid, uuid, integer) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."acquire_followup_send_lock_atomic"(uuid, uuid, uuid, integer) TO "service_role";

-- ============================================================================
-- release_followup_send_lock_atomic() -- only clears the lock if it still
-- matches the caller's own token, so a stale/expired lock this caller once
-- held (and that may have since been re-acquired by someone else after
-- expiry) can never be clobbered by a late release call.
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."release_followup_send_lock_atomic"(
    p_sequence_id uuid,
    p_user_id uuid,
    p_lock_token uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "public"."runtime_followup_sequences"
     SET send_lock_token = NULL,
         send_lock_expires_at = NULL,
         updated_at = now()
   WHERE id = p_sequence_id
     AND user_id = p_user_id
     AND send_lock_token = p_lock_token;
END;
$$;

REVOKE ALL ON FUNCTION "public"."release_followup_send_lock_atomic"(uuid, uuid, uuid) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."release_followup_send_lock_atomic"(uuid, uuid, uuid) TO "service_role";
