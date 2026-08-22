-- Phase 18.2: Runtime Metrics Engine
-- Persistent time-series metrics table for CPU, memory, queue depth,
-- throughput, command/execution latency, worker utilization, error rate,
-- and incident rate with aggregation windows.

CREATE TABLE IF NOT EXISTS runtime_metrics (
  id           uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_name  text             NOT NULL,
  metric_value double precision NOT NULL,
  labels       jsonb            NOT NULL DEFAULT '{}',
  "window"     text             NOT NULL DEFAULT '5m',
  recorded_at  timestamptz      NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_metrics_name_recorded_idx
  ON runtime_metrics (metric_name, recorded_at DESC);

CREATE INDEX IF NOT EXISTS runtime_metrics_recorded_at_idx
  ON runtime_metrics (recorded_at DESC);

CREATE INDEX IF NOT EXISTS runtime_metrics_window_idx
  ON runtime_metrics ("window", recorded_at DESC);

ALTER TABLE runtime_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_bypass_runtime_metrics" ON runtime_metrics;
CREATE POLICY "service_role_bypass_runtime_metrics"
  ON runtime_metrics FOR ALL USING (auth.role() = 'service_role');

-- Auto-purge metrics older than 30 days via pg_cron (if available)
-- Otherwise, the API layer trims on query.
