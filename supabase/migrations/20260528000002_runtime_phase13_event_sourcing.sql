/*
  Phase 13: Durable Event Sourcing + Deterministic Replay

  1. runtime_execution_events — append-only ordered event log per execution.
     sequence_number is monotonically incrementing per execution_id.
     No UPDATE or DELETE is permitted; enforced by RLS (INSERT + SELECT only).

  2. runtime_idempotency_keys — prevents duplicate n8n side effects from
     retries, replays, or split-brain scenarios.

  3. append_execution_event() — atomic sequence-number assignment using a
     per-execution advisory lock (hashtext). Prevents sequence gaps and
     unique-constraint violations under concurrent inserts.

  All statements are idempotent. No data is deleted. No existing tables are modified.
*/

-- ============================================================================
-- 1) Append-only execution event log
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_execution_events (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id     text        NOT NULL,
  workflow_id      text,
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  worker_id        text,
  event_type       text        NOT NULL,
  event_version    integer     NOT NULL DEFAULT 1,
  sequence_number  bigint      NOT NULL,
  causation_id     text,
  correlation_id   text,
  parent_event_id  text,
  fencing_token    bigint,
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_execution_events_seq_uniq
    UNIQUE (execution_id, sequence_number)
);

-- Primary lookup: ordered event stream for an execution (replay hot path)
CREATE INDEX IF NOT EXISTS runtime_execution_events_exec_seq_idx
  ON runtime_execution_events(execution_id, sequence_number ASC);

-- Causality lookup: find child events given a parent event_id
CREATE INDEX IF NOT EXISTS runtime_execution_events_causation_idx
  ON runtime_execution_events(causation_id)
  WHERE causation_id IS NOT NULL;

-- Correlation lookup: session/request tracing across executions
CREATE INDEX IF NOT EXISTS runtime_execution_events_correlation_idx
  ON runtime_execution_events(correlation_id)
  WHERE correlation_id IS NOT NULL;

-- User-scoped audit + cleanup
CREATE INDEX IF NOT EXISTS runtime_execution_events_user_created_idx
  ON runtime_execution_events(user_id, created_at DESC);

ALTER TABLE runtime_execution_events ENABLE ROW LEVEL SECURITY;

-- Service layer may INSERT and SELECT; UPDATE and DELETE are intentionally excluded.
DROP POLICY IF EXISTS "Service can insert execution events" ON runtime_execution_events;
CREATE POLICY "Service can insert execution events"
  ON runtime_execution_events FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Service can read execution events" ON runtime_execution_events;
CREATE POLICY "Service can read execution events"
  ON runtime_execution_events FOR SELECT USING (true);

-- ============================================================================
-- 2) Idempotency keys — prevent duplicate n8n side effects
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_idempotency_keys (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text        NOT NULL,
  execution_id     text        NOT NULL,
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation        text        NOT NULL,
  result           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key, user_id)
);

CREATE INDEX IF NOT EXISTS runtime_idempotency_keys_exec_idx
  ON runtime_idempotency_keys(execution_id, operation);

CREATE INDEX IF NOT EXISTS runtime_idempotency_keys_created_idx
  ON runtime_idempotency_keys(created_at DESC);

ALTER TABLE runtime_idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service can manage idempotency keys" ON runtime_idempotency_keys;
CREATE POLICY "Service can manage idempotency keys"
  ON runtime_idempotency_keys FOR ALL USING (true);

-- ============================================================================
-- 3) append_execution_event() — atomic sequence-number assignment
--
--    Uses pg_advisory_xact_lock(hashtext(execution_id)) to serialize inserts
--    for the same execution. The lock is released automatically at transaction
--    end. Concurrent inserts for DIFFERENT executions are unaffected.
-- ============================================================================

CREATE OR REPLACE FUNCTION append_execution_event(
  p_execution_id    text,
  p_workflow_id     text,
  p_user_id         uuid,
  p_worker_id       text,
  p_event_type      text,
  p_event_version   integer,
  p_causation_id    text,
  p_correlation_id  text,
  p_parent_event_id text,
  p_fencing_token   bigint,
  p_payload         jsonb,
  p_metadata        jsonb
)
RETURNS TABLE(event_id uuid, sequence_number bigint)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_seq bigint;
  v_id  uuid := gen_random_uuid();
BEGIN
  -- Serialize concurrent inserts for this execution only.
  PERFORM pg_advisory_xact_lock(hashtext(p_execution_id));

  SELECT COALESCE(MAX(e.sequence_number), 0) + 1
    INTO v_seq
    FROM runtime_execution_events e
   WHERE e.execution_id = p_execution_id;

  INSERT INTO runtime_execution_events (
    id, execution_id, workflow_id, user_id, worker_id,
    event_type, event_version, sequence_number,
    causation_id, correlation_id, parent_event_id, fencing_token,
    payload, metadata, created_at
  ) VALUES (
    v_id, p_execution_id, p_workflow_id, p_user_id, p_worker_id,
    p_event_type, p_event_version, v_seq,
    p_causation_id, p_correlation_id, p_parent_event_id, p_fencing_token,
    p_payload, p_metadata, now()
  );

  RETURN QUERY SELECT v_id AS event_id, v_seq AS sequence_number;
END;
$$;
