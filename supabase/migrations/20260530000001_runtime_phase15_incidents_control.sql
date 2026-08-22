-- Phase 15: Runtime Production Control Plane + Operator Dashboard
-- Creates incident tracking tables with dedup, audit trail, and operator actions.

-- ─────────────────────────────────────────────────────────────────────────────
-- runtime_incidents
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS runtime_incidents (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_type     text        NOT NULL,
  severity          text        NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status            text        NOT NULL DEFAULT 'open'   CHECK (status   IN ('open', 'investigating', 'resolved')),
  execution_id      uuid        NULL,
  workflow_id       uuid        NULL,
  worker_id         text        NULL,
  user_id           uuid        NULL,
  title             text        NOT NULL,
  description       text        NOT NULL DEFAULT '',
  occurrence_count  integer     NOT NULL DEFAULT 1,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz NULL,
  resolved_by       text        NULL,
  details           jsonb       NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Partial unique index for dedup: only one open/investigating incident per (type, execution_id, worker_id).
-- NULLs are handled with COALESCE so two NULLs match each other.
CREATE UNIQUE INDEX IF NOT EXISTS runtime_incidents_dedup_idx
  ON runtime_incidents (
    incident_type,
    COALESCE(execution_id::text, ''),
    COALESCE(worker_id, '')
  )
  WHERE status IN ('open', 'investigating');

CREATE INDEX IF NOT EXISTS runtime_incidents_status_idx
  ON runtime_incidents (status, severity, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS runtime_incidents_execution_idx
  ON runtime_incidents (execution_id)
  WHERE execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS runtime_incidents_user_idx
  ON runtime_incidents (user_id)
  WHERE user_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- runtime_incident_events
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS runtime_incident_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid        NOT NULL REFERENCES runtime_incidents(id) ON DELETE CASCADE,
  event_type   text        NOT NULL CHECK (event_type IN ('created', 'updated', 'escalated', 'resolved', 'comment')),
  actor        text        NOT NULL DEFAULT 'system',
  payload      jsonb       NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_incident_events_incident_idx
  ON runtime_incident_events (incident_id, created_at ASC);

-- ─────────────────────────────────────────────────────────────────────────────
-- runtime_operator_actions
-- Full audit log of every operator action taken via the control plane.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS runtime_operator_actions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type   text        NOT NULL,
  operator_id   text        NOT NULL,
  execution_id  uuid        NULL,
  workflow_id   uuid        NULL,
  worker_id     text        NULL,
  incident_id   uuid        NULL,
  payload       jsonb       NOT NULL DEFAULT '{}',
  result        jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_operator_actions_operator_idx
  ON runtime_operator_actions (operator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_operator_actions_execution_idx
  ON runtime_operator_actions (execution_id)
  WHERE execution_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- open_or_bump_incident()
-- Atomically creates a new incident or bumps occurrence_count + last_seen_at
-- on the existing open/investigating incident for the same (type, execution, worker).
-- Returns the incident id and whether it was newly created.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION open_or_bump_incident(
  p_incident_type   text,
  p_severity        text,
  p_execution_id    uuid,
  p_workflow_id     uuid,
  p_worker_id       text,
  p_user_id         uuid,
  p_title           text,
  p_description     text,
  p_details         jsonb
) RETURNS TABLE(incident_id uuid, was_created boolean)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_incident_id uuid;
  v_created     boolean := false;
BEGIN
  -- Try to find existing open/investigating incident for this dedup key.
  SELECT id INTO v_incident_id
    FROM runtime_incidents
   WHERE incident_type = p_incident_type
     AND COALESCE(execution_id::text, '') = COALESCE(p_execution_id::text, '')
     AND COALESCE(worker_id, '')          = COALESCE(p_worker_id, '')
     AND status IN ('open', 'investigating')
   LIMIT 1;

  IF v_incident_id IS NOT NULL THEN
    -- Bump occurrence_count, update last_seen_at, and possibly escalate severity.
    UPDATE runtime_incidents
       SET occurrence_count = occurrence_count + 1,
           last_seen_at     = now(),
           updated_at       = now(),
           -- Escalate if incoming severity is higher (critical > high > medium > low)
           severity = CASE
             WHEN p_severity = 'critical' THEN 'critical'
             WHEN p_severity = 'high'     AND severity IN ('low', 'medium') THEN 'high'
             WHEN p_severity = 'medium'   AND severity = 'low'             THEN 'medium'
             ELSE severity
           END,
           details  = details || p_details
     WHERE id = v_incident_id;
  ELSE
    -- Insert new incident.
    INSERT INTO runtime_incidents (
      incident_type, severity, status,
      execution_id, workflow_id, worker_id, user_id,
      title, description, details,
      occurrence_count, first_seen_at, last_seen_at
    ) VALUES (
      p_incident_type, p_severity, 'open',
      p_execution_id, p_workflow_id, p_worker_id, p_user_id,
      p_title, p_description, p_details,
      1, now(), now()
    )
    RETURNING id INTO v_incident_id;
    v_created := true;
  END IF;

  RETURN QUERY SELECT v_incident_id, v_created;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — service-role bypass (same pattern as other runtime tables)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE runtime_incidents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_incident_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_operator_actions   ENABLE ROW LEVEL SECURITY;

-- Service role has full access (used by server-side code via createServiceClient).
DROP POLICY IF EXISTS "service_role_incidents" ON runtime_incidents;
CREATE POLICY "service_role_incidents"
  ON runtime_incidents FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "service_role_incident_events" ON runtime_incident_events;
CREATE POLICY "service_role_incident_events"
  ON runtime_incident_events FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "service_role_operator_actions" ON runtime_operator_actions;
CREATE POLICY "service_role_operator_actions"
  ON runtime_operator_actions FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
