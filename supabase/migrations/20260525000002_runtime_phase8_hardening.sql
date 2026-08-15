/*
  Phase 8: Runtime hardening fixes

  1. Add failed_at column to runtime_worker_restart_requests
  2. Add cleanup index for expired completed/failed requests
*/

-- ============================================================================
-- 1) failed_at column for restart requests
-- ============================================================================

ALTER TABLE runtime_worker_restart_requests
  ADD COLUMN IF NOT EXISTS failed_at timestamptz;

-- ============================================================================
-- 2) Cleanup index: locate old completed/failed requests by updated_at
-- ============================================================================

CREATE INDEX IF NOT EXISTS runtime_worker_restart_requests_cleanup_idx
  ON runtime_worker_restart_requests(updated_at)
  WHERE status IN ('completed', 'failed');
