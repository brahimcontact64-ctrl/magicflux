/*
  Phase 14: Durable Command Bus + Deterministic Runtime Evolution

  1. Compaction columns on runtime_execution_events (Phase 13 table).
     Marks events as compactable or archivable WITHOUT deleting data.

  2. runtime_execution_commands — durable, append-only command bus.
     UNIQUE(execution_id, sequence_number) prevents gaps.
     append_execution_command() uses a DIFFERENT advisory lock key than
     the event store (hashtext('cmd:'||execution_id)) to prevent cross-lock deadlock.

  3. runtime_command_dispatch_log — immutable audit trail of every claim,
     ack, retry, and dead-letter operation on a command.

  4. runtime_workflow_versions — pins a workflow's nodes+connections snapshot
     at a specific SHA-256 hash, preventing replay-time mutation.

  5. PostgreSQL functions:
     - append_execution_command()    — atomic sequence-number assignment (SKIP LOCKED-safe)
     - fetch_pending_execution_commands() — SKIP LOCKED multi-worker claim
     - ack_execution_command()       — acknowledge processing completion
     - mark_execution_events_compactable() — bulk-mark compactable (SECURITY DEFINER to bypass INSERT-only RLS)
     - mark_execution_events_archivable()  — bulk-mark archivable  (SECURITY DEFINER)

  All statements are idempotent. No data is deleted. No existing tables are dropped.
*/

-- ============================================================================
-- 1) Compaction columns on the Phase 13 event store
-- ============================================================================

ALTER TABLE runtime_execution_events
  ADD COLUMN IF NOT EXISTS compactable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archivable  boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS runtime_execution_events_compactable_idx
  ON runtime_execution_events(execution_id, sequence_number ASC)
  WHERE compactable = true;

CREATE INDEX IF NOT EXISTS runtime_execution_events_archivable_idx
  ON runtime_execution_events(user_id, created_at DESC)
  WHERE archivable = true;

-- ============================================================================
-- 2) Durable command bus
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_execution_commands (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id          text        NOT NULL,
  workflow_id           text,
  user_id               uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
  command_type          text        NOT NULL,
  command_version       integer     NOT NULL DEFAULT 1,
  sequence_number       bigint      NOT NULL,
  causation_id          text,
  correlation_id        text,
  parent_command_id     text,
  payload               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status                text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','processing','acknowledged','failed','dead_letter')),
  retry_count           integer     NOT NULL DEFAULT 0,
  scheduled_for         timestamptz,
  processing_started_at timestamptz,
  acknowledged_at       timestamptz,
  worker_id             text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_execution_commands_seq_uniq
    UNIQUE (execution_id, sequence_number)
);

-- Primary lookup: ordered command stream for an execution
CREATE INDEX IF NOT EXISTS runtime_execution_commands_exec_seq_idx
  ON runtime_execution_commands(execution_id, sequence_number ASC);

-- Pending-command claim index (SKIP LOCKED hot path)
CREATE INDEX IF NOT EXISTS runtime_execution_commands_status_scheduled_idx
  ON runtime_execution_commands(status, scheduled_for ASC NULLS FIRST)
  WHERE status = 'pending';

-- Causation chain lookup
CREATE INDEX IF NOT EXISTS runtime_execution_commands_causation_idx
  ON runtime_execution_commands(causation_id)
  WHERE causation_id IS NOT NULL;

-- User-scoped audit
CREATE INDEX IF NOT EXISTS runtime_execution_commands_user_idx
  ON runtime_execution_commands(user_id, created_at DESC);

ALTER TABLE runtime_execution_commands ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service can insert execution commands" ON runtime_execution_commands;
CREATE POLICY "Service can insert execution commands"
  ON runtime_execution_commands FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Service can read execution commands" ON runtime_execution_commands;
CREATE POLICY "Service can read execution commands"
  ON runtime_execution_commands FOR SELECT USING (true);

DROP POLICY IF EXISTS "Service can update execution commands" ON runtime_execution_commands;
CREATE POLICY "Service can update execution commands"
  ON runtime_execution_commands FOR UPDATE USING (true);

-- ============================================================================
-- 3) Command dispatch log — immutable audit trail
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_command_dispatch_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id     uuid        NOT NULL REFERENCES runtime_execution_commands(id) ON DELETE CASCADE,
  execution_id   text        NOT NULL,
  user_id        uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
  worker_id      text,
  dispatch_type  text        NOT NULL
                   CHECK (dispatch_type IN ('claimed','acked','failed','dead_lettered','retried')),
  attempt_number integer     NOT NULL DEFAULT 1,
  payload        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_command_dispatch_log_command_idx
  ON runtime_command_dispatch_log(command_id, created_at ASC);

CREATE INDEX IF NOT EXISTS runtime_command_dispatch_log_exec_idx
  ON runtime_command_dispatch_log(execution_id, created_at ASC);

ALTER TABLE runtime_command_dispatch_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service can manage command dispatch log" ON runtime_command_dispatch_log;
CREATE POLICY "Service can manage command dispatch log"
  ON runtime_command_dispatch_log FOR ALL USING (true);

-- ============================================================================
-- 4) Workflow version pinning
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_workflow_versions (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id          text        NOT NULL,
  workflow_version     integer     NOT NULL,
  workflow_hash        text        NOT NULL,
  workflow_snapshot    jsonb       NOT NULL,
  planner_snapshot     jsonb,
  integration_snapshot jsonb,
  created_by           uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_workflow_versions_uniq
    UNIQUE (workflow_id, workflow_version)
);

CREATE INDEX IF NOT EXISTS runtime_workflow_versions_workflow_idx
  ON runtime_workflow_versions(workflow_id, workflow_version DESC);

CREATE INDEX IF NOT EXISTS runtime_workflow_versions_hash_idx
  ON runtime_workflow_versions(workflow_hash);

ALTER TABLE runtime_workflow_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service can manage workflow versions" ON runtime_workflow_versions;
CREATE POLICY "Service can manage workflow versions"
  ON runtime_workflow_versions FOR ALL USING (true);

-- ============================================================================
-- 5) append_execution_command()
--
--    Uses hashtext('cmd:'||p_execution_id) — a DIFFERENT key than the event
--    store's hashtext(p_execution_id) — to prevent cross-lock deadlock when
--    an event and a command are appended inside the same request.
-- ============================================================================

CREATE OR REPLACE FUNCTION append_execution_command(
  p_execution_id      text,
  p_workflow_id       text,
  p_user_id           uuid,
  p_command_type      text,
  p_command_version   integer,
  p_causation_id      text,
  p_correlation_id    text,
  p_parent_command_id text,
  p_payload           jsonb,
  p_metadata          jsonb,
  p_scheduled_for     timestamptz
)
RETURNS TABLE(command_id uuid, sequence_number bigint)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_seq bigint;
  v_id  uuid := gen_random_uuid();
BEGIN
  -- Serialize concurrent inserts for this execution only.
  -- KEY is DIFFERENT from append_execution_event to avoid cross-lock deadlock.
  PERFORM pg_advisory_xact_lock(hashtext('cmd:' || p_execution_id));

  SELECT COALESCE(MAX(c.sequence_number), 0) + 1
    INTO v_seq
    FROM runtime_execution_commands c
   WHERE c.execution_id = p_execution_id;

  INSERT INTO runtime_execution_commands (
    id, execution_id, workflow_id, user_id,
    command_type, command_version, sequence_number,
    causation_id, correlation_id, parent_command_id,
    payload, metadata, status, scheduled_for, created_at
  ) VALUES (
    v_id, p_execution_id, p_workflow_id, p_user_id,
    p_command_type, p_command_version, v_seq,
    p_causation_id, p_correlation_id, p_parent_command_id,
    p_payload, p_metadata, 'pending', p_scheduled_for, now()
  );

  RETURN QUERY SELECT v_id AS command_id, v_seq AS sequence_number;
END;
$$;

-- ============================================================================
-- 6) fetch_pending_execution_commands()
--
--    Atomically claims up to p_limit pending commands for the given worker.
--    Uses FOR UPDATE SKIP LOCKED so multiple workers can claim without contention.
--    Only claims commands whose scheduled_for is null or in the past.
-- ============================================================================

CREATE OR REPLACE FUNCTION fetch_pending_execution_commands(
  p_worker_id text,
  p_limit     integer DEFAULT 10
)
RETURNS SETOF runtime_execution_commands
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  UPDATE runtime_execution_commands
     SET status                = 'processing',
         processing_started_at = now(),
         worker_id             = p_worker_id
   WHERE id IN (
     SELECT id
       FROM runtime_execution_commands
      WHERE status = 'pending'
        AND (scheduled_for IS NULL OR scheduled_for <= now())
      ORDER BY sequence_number ASC
      LIMIT p_limit
        FOR UPDATE SKIP LOCKED
   )
  RETURNING *;
END;
$$;

-- ============================================================================
-- 7) ack_execution_command()
--
--    Marks a processing command as acknowledged by the given worker.
--    Returns true if a row was actually updated.
-- ============================================================================

CREATE OR REPLACE FUNCTION ack_execution_command(
  p_command_id uuid,
  p_worker_id  text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE runtime_execution_commands
     SET status          = 'acknowledged',
         acknowledged_at = now()
   WHERE id        = p_command_id
     AND worker_id = p_worker_id
     AND status    = 'processing';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- ============================================================================
-- 8) mark_execution_events_compactable()
--
--    Marks events up to (and including) p_up_to_sequence as compactable.
--    Uses SECURITY DEFINER to bypass the INSERT-only RLS on the event table.
--    DOES NOT delete data.
-- ============================================================================

CREATE OR REPLACE FUNCTION mark_execution_events_compactable(
  p_execution_id   text,
  p_user_id        uuid,
  p_up_to_sequence bigint
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE runtime_execution_events
     SET compactable = true
   WHERE execution_id    = p_execution_id
     AND user_id         = p_user_id
     AND sequence_number <= p_up_to_sequence
     AND compactable     = false;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ============================================================================
-- 9) mark_execution_events_archivable()
--
--    Marks events older than p_before_ts as archivable.
--    Uses SECURITY DEFINER to bypass the INSERT-only RLS on the event table.
--    DOES NOT delete data.
-- ============================================================================

CREATE OR REPLACE FUNCTION mark_execution_events_archivable(
  p_execution_id text,
  p_user_id      uuid,
  p_before_ts    timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE runtime_execution_events
     SET archivable = true
   WHERE execution_id = p_execution_id
     AND user_id      = p_user_id
     AND created_at   < p_before_ts
     AND archivable   = false;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
