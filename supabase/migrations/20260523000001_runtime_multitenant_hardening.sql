-- ============================================================================
-- Runtime multitenant hardening: add user_id to UPSERT conflict targets.
--
-- Background:
--   runtime_execution_controls has execution_id text PRIMARY KEY.  Without an
--   explicit conflict target, Supabase upsert defaults to the PK, meaning any
--   upsert with the same execution_id overwrites the row regardless of user_id.
--   If two users somehow share an execution_id string, one user's pause/cancel
--   signals would clobber the other's.  Adding UNIQUE(execution_id, user_id)
--   lets the app-layer specify onConflict: 'execution_id,user_id', so the
--   conflict resolution is tenant-scoped: same user → update; different user
--   with same execution_id → PK violation (error), not a silent overwrite.
--
--   runtime_node_states and runtime_execution_snapshots had no explicit
--   onConflict, so their upserts always inserted (PK is a uuid).  Adding
--   UNIQUE indexes on (execution_id, node_id, user_id) and
--   (execution_id, snapshot_version, user_id) respectively lets the app
--   specify tenant-scoped conflict targets so subsequent calls to
--   persistNodeState / writeSnapshot update the existing row rather than
--   accumulating duplicates, while keeping isolation by user_id.
--
-- All three statements are idempotent (IF NOT EXISTS).
-- No data is deleted; no existing constraints are dropped.
-- RLS policies are not modified — they already use auth.uid() = user_id.
-- ============================================================================

-- Tenant-scoped conflict target for runtime_node_states upsert.
-- App layer uses: { onConflict: 'execution_id,node_id,user_id' }
CREATE UNIQUE INDEX IF NOT EXISTS runtime_node_states_owner_idx
  ON runtime_node_states(execution_id, node_id, user_id);

-- Tenant-scoped conflict target for runtime_execution_controls upsert.
-- Prevents cross-tenant overwrite when execution_id PK is the default target.
-- App layer uses: { onConflict: 'execution_id,user_id' }
CREATE UNIQUE INDEX IF NOT EXISTS runtime_execution_controls_owner_idx
  ON runtime_execution_controls(execution_id, user_id);

-- Tenant-scoped conflict target for runtime_execution_snapshots upsert.
-- App layer uses: { onConflict: 'execution_id,snapshot_version,user_id' }
CREATE UNIQUE INDEX IF NOT EXISTS runtime_execution_snapshots_owner_idx
  ON runtime_execution_snapshots(execution_id, snapshot_version, user_id);
