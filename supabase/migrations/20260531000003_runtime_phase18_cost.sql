-- Phase 18.7: Cost Analytics
-- Per-resource cost records enabling workflow cost attribution, top-N analysis,
-- and monthly budget projections.

CREATE TABLE IF NOT EXISTS runtime_cost_records (
  id             uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_type      text             NOT NULL,
  workflow_id    uuid,
  execution_id   uuid,
  worker_id      text,
  user_id        uuid,
  quantity       double precision NOT NULL,
  unit_cost_usd  double precision NOT NULL DEFAULT 0,
  total_cost_usd double precision NOT NULL DEFAULT 0,
  metadata       jsonb            NOT NULL DEFAULT '{}',
  period_start   timestamptz      NOT NULL DEFAULT now(),
  period_end     timestamptz
);

CREATE INDEX IF NOT EXISTS runtime_cost_records_type_idx
  ON runtime_cost_records (cost_type, period_start DESC);

CREATE INDEX IF NOT EXISTS runtime_cost_records_workflow_idx
  ON runtime_cost_records (workflow_id, period_start DESC);

CREATE INDEX IF NOT EXISTS runtime_cost_records_user_idx
  ON runtime_cost_records (user_id, period_start DESC);

CREATE INDEX IF NOT EXISTS runtime_cost_records_period_idx
  ON runtime_cost_records (period_start DESC);

ALTER TABLE runtime_cost_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_bypass_cost_records"
  ON runtime_cost_records FOR ALL USING (auth.role() = 'service_role');
