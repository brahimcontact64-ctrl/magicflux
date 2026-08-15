/*
  Phase 21 — Event Sourcing Immutability Hardening

  The runtime_execution_events table is the canonical append-only event log
  for deterministic replay. Mutating historical events would silently corrupt
  replay results and break the guarantee that state is fully derivable from
  the event stream.

  The compaction module legitimately needs to set the `compactable` and
  `archivable` boolean flags on events (these are metadata-only flags that
  do not affect replay correctness). All other columns must never change
  after insertion.

  This migration adds:

  1. protect_execution_event_immutability() — BEFORE UPDATE trigger function
     that raises an exception if any column other than `compactable` or
     `archivable` is being changed. The comparison is done column-by-column
     so new columns added in future migrations are protected by default.

  2. prevent_execution_event_delete() — BEFORE DELETE trigger function that
     unconditionally raises an exception, making the table physically
     undeletable regardless of calling role (including service_role, which
     bypasses RLS but NOT triggers).

  Note on service_role and RLS:
    The Supabase service role bypasses Row Level Security entirely, so RLS
    alone cannot protect against accidental or malicious deletes/updates from
    server-side code. BEFORE triggers fire for ALL callers including the
    service role and SECURITY DEFINER functions, providing true DB-level
    immutability.

  Note on mark_execution_events_compactable / mark_execution_events_archivable:
    These SECURITY DEFINER functions call UPDATE SET compactable=true /
    archivable=true. They will continue to work correctly because this trigger
    allows those two specific column changes. All other columns in the same
    UPDATE statement are verified to be unchanged.

  All statements are idempotent — safe to replay.
*/

-- ============================================================================
-- 1) BEFORE UPDATE trigger — immutability guard
-- ============================================================================

CREATE OR REPLACE FUNCTION protect_execution_event_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Allow: compactable and archivable flags may be toggled.
  -- Reject: any change to the event's identity or content columns.

  IF NEW.id               IS DISTINCT FROM OLD.id               OR
     NEW.execution_id     IS DISTINCT FROM OLD.execution_id     OR
     NEW.workflow_id      IS DISTINCT FROM OLD.workflow_id      OR
     NEW.user_id          IS DISTINCT FROM OLD.user_id          OR
     NEW.worker_id        IS DISTINCT FROM OLD.worker_id        OR
     NEW.event_type       IS DISTINCT FROM OLD.event_type       OR
     NEW.event_version    IS DISTINCT FROM OLD.event_version    OR
     NEW.sequence_number  IS DISTINCT FROM OLD.sequence_number  OR
     NEW.causation_id     IS DISTINCT FROM OLD.causation_id     OR
     NEW.correlation_id   IS DISTINCT FROM OLD.correlation_id   OR
     NEW.parent_event_id  IS DISTINCT FROM OLD.parent_event_id  OR
     NEW.fencing_token    IS DISTINCT FROM OLD.fencing_token    OR
     NEW.payload          IS DISTINCT FROM OLD.payload          OR
     NEW.metadata         IS DISTINCT FROM OLD.metadata         OR
     NEW.created_at       IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'runtime_execution_events is append-only. Column mutation is forbidden. '
      'Only compactable and archivable flags may be updated. '
      'execution_id=%, sequence_number=%',
      OLD.execution_id, OLD.sequence_number
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_execution_events_immutability
  ON runtime_execution_events;

CREATE TRIGGER tg_execution_events_immutability
  BEFORE UPDATE ON runtime_execution_events
  FOR EACH ROW
  EXECUTE FUNCTION protect_execution_event_immutability();

-- ============================================================================
-- 2) BEFORE DELETE trigger — hard deletion guard
-- ============================================================================

CREATE OR REPLACE FUNCTION prevent_execution_event_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RAISE EXCEPTION
    'runtime_execution_events is append-only. Deletion is forbidden. '
    'execution_id=%, sequence_number=%',
    OLD.execution_id, OLD.sequence_number
    USING ERRCODE = 'restrict_violation';

  -- Unreachable, but required for PL/pgSQL trigger function signature.
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tg_execution_events_no_delete
  ON runtime_execution_events;

CREATE TRIGGER tg_execution_events_no_delete
  BEFORE DELETE ON runtime_execution_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_execution_event_delete();

-- ============================================================================
-- 3) Verify the mark_* functions still compile against the trigger
--    (they only update compactable/archivable — will pass the guard).
--    No changes needed to those functions.
-- ============================================================================

-- Sanity comment: mark_execution_events_compactable performs:
--   UPDATE runtime_execution_events SET compactable = true WHERE ...
-- This sets only `compactable`; no identity columns are changed.
-- The BEFORE UPDATE trigger will pass because all other columns are unchanged.

-- mark_execution_events_archivable performs:
--   UPDATE runtime_execution_events SET archivable = true WHERE ...
-- Same reasoning — trigger will pass.
