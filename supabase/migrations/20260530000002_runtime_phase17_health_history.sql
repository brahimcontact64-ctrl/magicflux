-- Phase 17: Health score snapshot table for trend charts.
-- Populated by the overview API endpoint on each load.

CREATE TABLE IF NOT EXISTS runtime_health_score_snapshots (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  overall_score integer     NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  components    jsonb       NOT NULL DEFAULT '{}',
  signals       jsonb       NOT NULL DEFAULT '{}',
  computed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_health_snapshots_computed_at_idx
  ON runtime_health_score_snapshots (computed_at DESC);

ALTER TABLE runtime_health_score_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_bypass_health_snapshots"
  ON runtime_health_score_snapshots
  FOR ALL
  USING (auth.role() = 'service_role');
