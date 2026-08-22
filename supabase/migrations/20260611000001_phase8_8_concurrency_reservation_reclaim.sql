/*
  Phase 8.8 — fix reserve_concurrency_slot() to allow re-reserving a
  previously-released execution_id.

  runtime_concurrency_reservations.execution_id is a PRIMARY KEY (see
  20260610000001_phase8_1_production_hardening.sql), and the original
  reserve_concurrency_slot() ended with:

    INSERT INTO runtime_concurrency_reservations (...)
    VALUES (...)
    ON CONFLICT (execution_id) DO NOTHING;
    RETURN jsonb_build_object('reserved', true);

  Found via Phase 8.8's live retry-recovery certification: every execution
  was previously reserved AT MOST ONCE in its lifetime (one webhook/schedule
  dispatch => one reservation => released when the worker's job settles,
  regardless of terminal status). Phase 8.8 introduces the first scenario
  where the SAME execution_id can legitimately be reserved a second time —
  resuming a 'waiting' execution via the new retry dispatcher.

  On that second call, the row already exists (released_at set from the
  first release), so ON CONFLICT DO NOTHING silently no-ops the INSERT —
  yet the function still unconditionally returned {reserved: true}. The
  stale row's released_at is never cleared, so this "reservation" is
  invisible to the very COUNT(*) ... WHERE released_at IS NULL queries this
  function itself uses to enforce concurrency limits — i.e. every retried
  execution's concurrency slot silently never counted against anyone's
  limit. Root cause, not a new mechanism: fixed by allowing the conflict to
  reclaim the row (SET released_at = NULL, refresh expires_at) only when it
  was actually previously released — a currently-held row (released_at IS
  NULL) is left untouched, matching the original "do not double-book"
  invariant exactly.
*/

CREATE OR REPLACE FUNCTION reserve_concurrency_slot(
  p_execution_id text,
  p_user_id uuid,
  p_workflow_id text,
  p_max_per_user int,
  p_max_per_workflow int,
  p_ttl_seconds int
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_count int;
  v_workflow_count int;
  v_reserved_id text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('concurrency_user:' || p_user_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('concurrency_workflow:' || p_workflow_id, 0));

  UPDATE runtime_concurrency_reservations
  SET released_at = now()
  WHERE released_at IS NULL AND expires_at < now();

  SELECT count(*) INTO v_user_count
  FROM runtime_concurrency_reservations
  WHERE user_id = p_user_id AND released_at IS NULL;

  IF v_user_count >= p_max_per_user THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'USER_CONCURRENCY_LIMIT', 'current', v_user_count, 'limit', p_max_per_user);
  END IF;

  SELECT count(*) INTO v_workflow_count
  FROM runtime_concurrency_reservations
  WHERE workflow_id = p_workflow_id AND released_at IS NULL;

  IF v_workflow_count >= p_max_per_workflow THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'WORKFLOW_CONCURRENCY_LIMIT', 'current', v_workflow_count, 'limit', p_max_per_workflow);
  END IF;

  INSERT INTO runtime_concurrency_reservations (execution_id, user_id, workflow_id, expires_at)
  VALUES (p_execution_id, p_user_id, p_workflow_id, now() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (execution_id) DO UPDATE
    SET released_at = NULL,
        expires_at = EXCLUDED.expires_at,
        reserved_at = now()
    WHERE runtime_concurrency_reservations.released_at IS NOT NULL
  RETURNING execution_id INTO v_reserved_id;

  IF v_reserved_id IS NULL THEN
    -- Row exists and is still actively held (released_at IS NULL) by
    -- whatever reserved it before — refuse rather than double-book. In
    -- practice unreachable given the count checks above already exclude
    -- this execution_id, but fail closed rather than assume.
    RETURN jsonb_build_object('reserved', false, 'reason', 'USER_CONCURRENCY_LIMIT', 'current', p_max_per_user, 'limit', p_max_per_user);
  END IF;

  RETURN jsonb_build_object('reserved', true);
END;
$$;

GRANT EXECUTE ON FUNCTION reserve_concurrency_slot(text, uuid, text, int, int, int) TO service_role;
