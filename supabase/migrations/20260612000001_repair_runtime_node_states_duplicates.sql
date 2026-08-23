/*
  Repair: runtime_node_states duplicate rows blocking the
  (execution_id, node_id, user_id) unique index that
  20260523000001_runtime_multitenant_hardening.sql adds, and that
  RuntimeStateStore.persistNodeState()'s upsert conflict target
  (onConflict: 'execution_id,node_id,user_id') has always required.

  Root cause: no unique constraint matching that conflict target has ever
  existed in production, so every persistNodeState() upsert has failed with
  Postgres 42P10 ("no unique or exclusion constraint matching the ON
  CONFLICT specification") -- silently, because the calling code did not
  check the Supabase client's .error (fixed separately in
  runtime/runtime-state.ts). 12 legacy duplicate groups (36 rows, one
  queued/running/success triple per group, all attempt=1, predating this
  write path's current form) block adding that constraint directly.

  This migration is strictly non-destructive:
    1. Every row belonging to a duplicate group is archived verbatim first.
    2. Archive completeness is verified before any row is removed.
    3. Only exact redundant copies within a duplicate group are removed --
       never the deterministically-chosen authoritative row, never a
       singleton (non-duplicate) row.
    4. workflow_execution_steps (the append-only per-status/per-attempt
       audit log) is never touched by this migration.

  Idempotent: safe to re-run. Already-archived rows are not re-archived;
  once no duplicate groups remain, the DELETE and index-creation steps are
  no-ops.
*/

-- ============================================================================
-- 1) Archive table -- every runtime_node_states column, plus audit columns.
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_node_states_legacy_archive (
  original_row_id uuid,
  execution_id     text        NOT NULL,
  workflow_id      text        NOT NULL,
  user_id          uuid        NOT NULL,
  node_id          text        NOT NULL,
  node_name        text        NOT NULL,
  node_type        text        NOT NULL,
  status           text        NOT NULL,
  attempt          integer     NOT NULL,
  input_data       jsonb,
  output_data      jsonb,
  logs             text[],
  error_message    text,
  started_at       timestamptz,
  completed_at     timestamptz,
  updated_at       timestamptz NOT NULL,
  archived_at      timestamptz NOT NULL DEFAULT now(),
  archive_reason   text        NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_node_states_legacy_archive_original_idx
  ON runtime_node_states_legacy_archive(original_row_id);

CREATE INDEX IF NOT EXISTS runtime_node_states_legacy_archive_group_idx
  ON runtime_node_states_legacy_archive(execution_id, node_id, user_id);

-- ============================================================================
-- 2) Archive, verify, then deduplicate -- all inside one transactional block
--    so a failed verification aborts before any DELETE is even attempted.
-- ============================================================================

DO $$
DECLARE
  v_dup_row_count           integer;
  v_before_count            integer;
  v_after_count             integer;
  v_archived_present_count  integer;
  v_duplicate_groups_after  integer;
BEGIN
  SELECT count(*) INTO v_before_count FROM runtime_node_states;

  -- Rows that belong to any duplicate group under (execution_id, node_id, user_id).
  SELECT count(*) INTO v_dup_row_count
  FROM runtime_node_states s
  WHERE EXISTS (
    SELECT 1 FROM runtime_node_states s2
    WHERE s2.execution_id = s.execution_id
      AND s2.node_id      = s.node_id
      AND s2.user_id       = s.user_id
    GROUP BY s2.execution_id, s2.node_id, s2.user_id
    HAVING count(*) > 1
  );

  -- Archive every row in a duplicate group. Idempotent: skip rows already archived.
  INSERT INTO runtime_node_states_legacy_archive (
    original_row_id, execution_id, workflow_id, user_id, node_id, node_name,
    node_type, status, attempt, input_data, output_data, logs, error_message,
    started_at, completed_at, updated_at, archive_reason
  )
  SELECT
    s.id, s.execution_id, s.workflow_id, s.user_id, s.node_id, s.node_name,
    s.node_type, s.status, s.attempt, s.input_data, s.output_data, s.logs, s.error_message,
    s.started_at, s.completed_at, s.updated_at,
    'pre-existing duplicate under (execution_id,node_id,user_id) prior to unique constraint repair'
  FROM runtime_node_states s
  WHERE EXISTS (
    SELECT 1 FROM runtime_node_states s2
    WHERE s2.execution_id = s.execution_id
      AND s2.node_id      = s.node_id
      AND s2.user_id       = s.user_id
    GROUP BY s2.execution_id, s2.node_id, s2.user_id
    HAVING count(*) > 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM runtime_node_states_legacy_archive a WHERE a.original_row_id = s.id
  );

  -- Verify: every duplicate-group row currently in the source table must now
  -- have a corresponding archive entry. Abort (no deletion attempted) if not.
  SELECT count(*) INTO v_archived_present_count
  FROM runtime_node_states s
  WHERE EXISTS (
    SELECT 1 FROM runtime_node_states s2
    WHERE s2.execution_id = s.execution_id
      AND s2.node_id      = s.node_id
      AND s2.user_id       = s.user_id
    GROUP BY s2.execution_id, s2.node_id, s2.user_id
    HAVING count(*) > 1
  )
  AND EXISTS (
    SELECT 1 FROM runtime_node_states_legacy_archive a WHERE a.original_row_id = s.id
  );

  IF v_archived_present_count <> v_dup_row_count THEN
    RAISE EXCEPTION
      'Archive verification failed: % duplicate-group rows exist but only % have a matching archive entry. Aborting before any deletion.',
      v_dup_row_count, v_archived_present_count;
  END IF;

  -- Deduplicate: keep exactly one authoritative row per
  -- (execution_id, node_id, user_id), chosen deterministically --
  -- highest attempt, then latest updated_at, then status priority
  -- (success > failed > retrying > running > queued), then lowest id.
  -- Singleton (non-duplicate) groups are always rn=1 and never touched.
  WITH ranked AS (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY execution_id, node_id, user_id
        ORDER BY
          attempt DESC,
          updated_at DESC,
          CASE status
            WHEN 'success'  THEN 1
            WHEN 'failed'   THEN 2
            WHEN 'retrying' THEN 3
            WHEN 'running'  THEN 4
            WHEN 'queued'   THEN 5
            ELSE 6
          END ASC,
          id ASC
      ) AS rn
    FROM runtime_node_states
  )
  DELETE FROM runtime_node_states
  WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

  SELECT count(*) INTO v_after_count FROM runtime_node_states;

  -- Final safety check: no duplicate groups may remain.
  SELECT count(*) INTO v_duplicate_groups_after
  FROM (
    SELECT execution_id, node_id, user_id
    FROM runtime_node_states
    GROUP BY execution_id, node_id, user_id
    HAVING count(*) > 1
  ) remaining_dupes;

  IF v_duplicate_groups_after > 0 THEN
    RAISE EXCEPTION 'Deduplication failed: % duplicate groups remain after cleanup.', v_duplicate_groups_after;
  END IF;

  RAISE NOTICE 'runtime_node_states repair: % rows before, % rows after, % duplicate-group rows archived.',
    v_before_count, v_after_count, v_dup_row_count;
END;
$$;

-- ============================================================================
-- 3) The unique index the application's upsert conflict target requires.
--    Same name as 20260523000001_runtime_multitenant_hardening.sql's own
--    definition, so that migration -- left completely unmodified -- finds
--    it already present (CREATE UNIQUE INDEX IF NOT EXISTS) and no-ops here
--    when it runs afterward.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS runtime_node_states_owner_idx
  ON runtime_node_states(execution_id, node_id, user_id);
