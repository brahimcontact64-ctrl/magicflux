-- Phase 19: Production Hardening for Phase 18 schemas
-- Fixes two critical idempotency/constraint bugs introduced in Phase 18:
--
-- 1. runtime_sla_targets: the partial unique index (WHERE is_active = true)
--    cannot be used as a conflict target by column name in PostgREST upserts.
--    Replace it with a full unique constraint so onConflict:'target_type' works.
--
-- 2. runtime_alert_rules: no unique constraint on 'name' caused ON CONFLICT DO
--    NOTHING to always insert, duplicating default rules on every migration run.
--    Add UNIQUE (name) and clean up any duplicates first.

-- ============================================================
-- 1. Fix runtime_sla_targets
-- ============================================================

-- Remove duplicate rows (keep the oldest per target_type).
-- Uses a subquery to delete newer duplicates before adding the constraint.
DELETE FROM runtime_sla_targets
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY target_type ORDER BY created_at ASC) AS rn
    FROM runtime_sla_targets
  ) ranked
  WHERE rn > 1
);

-- Drop the partial index that was preventing upserts by column name.
DROP INDEX IF EXISTS runtime_sla_targets_type_idx;

-- Add a full unique constraint so PostgREST can use it as a conflict target.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'runtime_sla_targets_target_type_key'
  ) THEN
    ALTER TABLE runtime_sla_targets
      ADD CONSTRAINT runtime_sla_targets_target_type_key UNIQUE (target_type);
  END IF;
END $$;

-- ============================================================
-- 2. Fix runtime_alert_rules
-- ============================================================

-- Remove duplicate default rules (those with no created_by), keeping oldest.
DELETE FROM runtime_alert_rules
WHERE created_by IS NULL
  AND id IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at ASC) AS rn
      FROM runtime_alert_rules
      WHERE created_by IS NULL
    ) ranked
    WHERE rn > 1
  );

-- Add unique constraint on name so ON CONFLICT (name) DO NOTHING is idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'runtime_alert_rules_name_key'
  ) THEN
    ALTER TABLE runtime_alert_rules
      ADD CONSTRAINT runtime_alert_rules_name_key UNIQUE (name);
  END IF;
END $$;

-- Re-seed with explicit conflict target now that the constraint exists.
-- This is a no-op if the defaults were already inserted by migration 005.
INSERT INTO runtime_alert_rules
  (name, condition_type, threshold, window_minutes, severity, channels, is_active)
VALUES
  ('High Command Backlog',   'queue_overload',         200, 5,  'warning',  '["dashboard"]', false),
  ('Worker Crash Detected',  'worker_crash',             1, 5,  'critical', '["dashboard"]', false),
  ('Incident Explosion',     'incident_explosion',      10, 15, 'critical', '["dashboard"]', false),
  ('Replay Integrity Breach','replay_corruption',        1, 5,  'critical', '["dashboard"]', false),
  ('SLA Violation',          'sla_violation',            1, 10, 'warning',  '["dashboard"]', false)
ON CONFLICT (name) DO NOTHING;
