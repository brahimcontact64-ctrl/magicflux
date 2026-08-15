/*
  Phase 12: Distributed Lease Authority + Split-Brain Protection

  Adds a monotonically incrementing fencing_token to runtime_execution_ownership.
  Each claimExecutionOwnership call increments the token; a stale executor holding
  an older token is fenced out before issuing external side effects.

  All statements are idempotent. No data is deleted. No RLS policies are modified.
*/

ALTER TABLE runtime_execution_ownership
  ADD COLUMN IF NOT EXISTS fencing_token bigint NOT NULL DEFAULT 0;

-- Fast lookup for authority validation: find the active row and compare tokens.
CREATE INDEX IF NOT EXISTS runtime_execution_ownership_fencing_idx
  ON runtime_execution_ownership(execution_id, fencing_token)
  WHERE state = 'active';
