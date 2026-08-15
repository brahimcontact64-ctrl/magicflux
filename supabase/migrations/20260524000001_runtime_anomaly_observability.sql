/*
  Phase 7: Observability + Self-Healing Runtime

  1. Extend runtime_security_alerts with columns required by anomaly detection:
     message, worker_id, resolved_at.
  2. Expand the alert_type CHECK constraint to include anomaly detection types.
  3. Expand the severity CHECK constraint to include the task-spec values
     (low, medium, high) alongside the existing (info, warning, error, critical).
  4. Add supporting indexes.

  All statements are idempotent. No data is deleted. No RLS policies are modified.
*/

-- ============================================================================
-- 1) Add missing columns to runtime_security_alerts
-- ============================================================================

ALTER TABLE runtime_security_alerts
  ADD COLUMN IF NOT EXISTS message text,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

-- ============================================================================
-- 2) Expand alert_type CHECK constraint
--    PostgreSQL auto-names inline constraints as <table>_<column>_check.
--    Drop the old constraint and add a new named one that includes all types.
-- ============================================================================

ALTER TABLE runtime_security_alerts
  DROP CONSTRAINT IF EXISTS runtime_security_alerts_alert_type_check;

ALTER TABLE runtime_security_alerts
  ADD CONSTRAINT runtime_security_alerts_alert_type_check
  CHECK (alert_type IN (
    -- existing (webhook security)
    'prompt_injection',
    'tool_abuse',
    'provider_misuse',
    'unsafe_execution',
    'webhook_replay',
    'rate_limit_violation',
    -- anomaly detection (Phase 7)
    'repeated_node_failures',
    'retry_storm',
    'dead_letter_spike',
    'execution_loop',
    'worker_crash_frequency',
    'queue_congestion'
  ));

-- ============================================================================
-- 3) Expand severity CHECK constraint
--    Add low/medium/high alongside existing info/warning/error/critical.
-- ============================================================================

ALTER TABLE runtime_security_alerts
  DROP CONSTRAINT IF EXISTS runtime_security_alerts_severity_check;

ALTER TABLE runtime_security_alerts
  ADD CONSTRAINT runtime_security_alerts_severity_check
  CHECK (severity IN (
    'info', 'warning', 'error', 'critical',
    'low', 'medium', 'high'
  ));

-- ============================================================================
-- 4) Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS runtime_security_alerts_unresolved_idx
  ON runtime_security_alerts(created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS runtime_security_alerts_worker_idx
  ON runtime_security_alerts(worker_id, created_at DESC)
  WHERE worker_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS runtime_security_alerts_alert_type_idx
  ON runtime_security_alerts(alert_type, created_at DESC);
