-- Phase 18.9: Global Alerting Engine
-- Alert rules watch for queue overload, worker crashes, incident explosions,
-- replay corruption, and SLA violations; firings are delivered to
-- dashboard, email, webhook, Slack, and Telegram channels.

CREATE TABLE IF NOT EXISTS runtime_alert_rules (
  id             uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text    NOT NULL,
  condition_type text    NOT NULL,
  threshold      integer NOT NULL DEFAULT 1,
  window_minutes integer NOT NULL DEFAULT 5,
  severity       text    NOT NULL DEFAULT 'warning',
  channels       jsonb   NOT NULL DEFAULT '[]',
  channel_config jsonb   NOT NULL DEFAULT '{}',
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_alert_rules_active_idx
  ON runtime_alert_rules (is_active, condition_type);

CREATE TABLE IF NOT EXISTS runtime_alert_firings (
  id            uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id       uuid  NOT NULL REFERENCES runtime_alert_rules(id) ON DELETE CASCADE,
  fired_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  payload       jsonb NOT NULL DEFAULT '{}',
  channels_sent jsonb NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS runtime_alert_firings_rule_idx
  ON runtime_alert_firings (rule_id, fired_at DESC);

CREATE INDEX IF NOT EXISTS runtime_alert_firings_fired_idx
  ON runtime_alert_firings (fired_at DESC);

ALTER TABLE runtime_alert_rules   ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_alert_firings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_bypass_alert_rules" ON runtime_alert_rules;
CREATE POLICY "service_role_bypass_alert_rules"
  ON runtime_alert_rules FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "service_role_bypass_alert_firings" ON runtime_alert_firings;
CREATE POLICY "service_role_bypass_alert_firings"
  ON runtime_alert_firings FOR ALL USING (auth.role() = 'service_role');

-- Default alert rules (dashboard-only, inactive by default)
INSERT INTO runtime_alert_rules
  (name, condition_type, threshold, window_minutes, severity, channels, is_active)
VALUES
  ('High Command Backlog',   'queue_overload',         200, 5,  'warning',  '["dashboard"]', false),
  ('Worker Crash Detected',  'worker_crash',             1, 5,  'critical', '["dashboard"]', false),
  ('Incident Explosion',     'incident_explosion',      10, 15, 'critical', '["dashboard"]', false),
  ('Replay Integrity Breach','replay_corruption',        1, 5,  'critical', '["dashboard"]', false),
  ('SLA Violation',          'sla_violation',            1, 10, 'warning',  '["dashboard"]', false)
ON CONFLICT DO NOTHING;
