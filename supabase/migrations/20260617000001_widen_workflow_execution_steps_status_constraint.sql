/*
  Repair: workflow_execution_steps.status CHECK constraint is missing
  'queued', 'retrying', and 'cancelled' in production.

  Discovered live during the Phase 8.9 Step 7/8 production webhook E2E smoke
  test: the very first real webhook-triggered execution failed immediately
  with "new row for relation workflow_execution_steps violates check
  constraint workflow_execution_steps_status_check" while persisting the
  Webhook Trigger node's initial 'queued' state (runtime/workflow-engine.ts
  writes 'queued' for every node as it enters the processing queue, before
  NodeRunner.run() advances it to 'running' then a terminal status).

  Root cause confirmed by direct read-only probing of the live constraint
  (not the tracked migration file, which was never what actually created
  this table -- consistent with the schema-drift pattern found repeatedly
  throughout this project's migration-repair work): the table's real,
  live CHECK constraint currently allows only
  ('running', 'success', 'failed', 'skipped', 'waiting') -- confirmed via
  read-only INSERT probes against a scratch execution_id, never against
  real data. 'queued', 'retrying', 'cancelled' are missing.

  This migration is a pure widening: the new allowed set is the union of
  the confirmed-live set and every literal status value
  runtime/node-runner.ts and runtime/workflow-engine.ts actually write via
  persistNodeState() (queued, running, success, failed, retrying,
  cancelled) -- confirmed by grepping every `status: '...'` literal in both
  files. Nothing is removed, so no existing row (only 'success'/'running'
  values exist in the 44 pre-existing legacy rows) can be invalidated.

  Idempotent: safe to replay (drops only the specific named/discovered
  status-related constraint before re-adding the widened one).
*/

DO $$
DECLARE
  constraint_row record;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflow_execution_steps') THEN
    FOR constraint_row IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'workflow_execution_steps'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%status%'
    LOOP
      EXECUTE format('ALTER TABLE workflow_execution_steps DROP CONSTRAINT IF EXISTS %I', constraint_row.conname);
    END LOOP;

    ALTER TABLE workflow_execution_steps
      ADD CONSTRAINT workflow_execution_steps_status_check CHECK (
        status IN ('queued', 'running', 'success', 'failed', 'retrying', 'cancelled', 'skipped', 'waiting')
      );
  END IF;
END $$;
