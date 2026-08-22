-- Phase 18.6: SLA Monitoring
-- SLA targets define acceptable thresholds; violations are recorded when
-- executions, commands, or workers breach those thresholds.

CREATE TABLE IF NOT EXISTS runtime_sla_targets (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type  text    NOT NULL,
  threshold_ms bigint  NOT NULL,
  warning_pct  integer NOT NULL DEFAULT 80,
  description  text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS runtime_sla_targets_type_idx
  ON runtime_sla_targets (target_type) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS runtime_sla_violations (
  id               uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id        uuid   REFERENCES runtime_sla_targets(id) ON DELETE SET NULL,
  target_type      text   NOT NULL,
  severity         text   NOT NULL DEFAULT 'warning',
  actual_value_ms  bigint NOT NULL,
  threshold_ms     bigint NOT NULL,
  execution_id     uuid,
  worker_id        text,
  command_id       uuid,
  details          jsonb  NOT NULL DEFAULT '{}',
  recorded_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_sla_violations_type_idx
  ON runtime_sla_violations (target_type, recorded_at DESC);

CREATE INDEX IF NOT EXISTS runtime_sla_violations_recorded_idx
  ON runtime_sla_violations (recorded_at DESC);

CREATE INDEX IF NOT EXISTS runtime_sla_violations_execution_idx
  ON runtime_sla_violations (execution_id) WHERE execution_id IS NOT NULL;

ALTER TABLE runtime_sla_targets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_sla_violations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_bypass_sla_targets" ON runtime_sla_targets;
CREATE POLICY "service_role_bypass_sla_targets"
  ON runtime_sla_targets FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "service_role_bypass_sla_violations" ON runtime_sla_violations;
CREATE POLICY "service_role_bypass_sla_violations"
  ON runtime_sla_violations FOR ALL USING (auth.role() = 'service_role');

-- Default SLA targets
INSERT INTO runtime_sla_targets (target_type, threshold_ms, warning_pct, description) VALUES
  ('execution_duration', 300000, 80, 'Workflow execution must complete within 5 minutes'),
  ('worker_availability',  5000, 80, 'Worker must heartbeat within 5 seconds'),
  ('queue_latency',        10000, 80, 'Commands must be picked up within 10 seconds'),
  ('command_ack_time',     30000, 80, 'Commands must be acknowledged within 30 seconds')
ON CONFLICT DO NOTHING;
