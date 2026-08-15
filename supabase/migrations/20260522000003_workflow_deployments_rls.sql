-- ============================================================================
-- workflow_deployments: formalize table schema and add RLS.
--
-- This table is written by app/api/n8n/orchestrate/route.ts but had no
-- tracked migration.  The INSERT in that route already writes user_id, so
-- the column exists in the live database.  This migration is idempotent:
-- CREATE TABLE IF NOT EXISTS / ENABLE ROW LEVEL SECURITY / DROP+CREATE
-- POLICY are all safe to re-run.
--
-- Ownership fix: the UPDATE in orchestrate/route.ts previously filtered
-- only by n8n_workflow_id (no user_id), allowing a cross-tenant n8n
-- workflow ID collision to corrupt another user's deployment record.
-- The code-level fix adds .eq('user_id', authUser.id) to that UPDATE;
-- this migration adds RLS as the database-level enforcement layer so
-- even a service-role oversight cannot bypass ownership.
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_deployments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id       text,
  template_id      text,
  template_name    text,
  industry         text,
  deployment_mode  text,
  status           text NOT NULL DEFAULT 'deploying',
  n8n_workflow_id  text,
  n8n_instance_url text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_deployments_user_idx
  ON workflow_deployments(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_deployments_n8n_idx
  ON workflow_deployments(n8n_workflow_id)
  WHERE n8n_workflow_id IS NOT NULL;

ALTER TABLE workflow_deployments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can access own deployments" ON workflow_deployments;
CREATE POLICY "Users can access own deployments"
  ON workflow_deployments
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
