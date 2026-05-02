/*
  # Phase 4 Live Deploy Tracking

  Adds columns to workflow_executions to track one-click deployment results,
  test execution outcomes, approval URLs, and credential provisioning status.

  ## Changes to workflow_executions
  - `orchestration_stage` — final stage of the orchestration pipeline (e.g. 'complete', 'failed')
  - `test_status` — result of the post-activation test run ('success', 'failed', 'timeout', 'skipped')
  - `test_execution_id` — n8n execution ID for the test run
  - `test_message` — human-readable test result message
  - `approval_url` — auto-fetched resume/approval webhook URL (if workflow has approval node)
  - `credential_types_provisioned` — list of n8n credential types created automatically
  - `live_deploy_at` — timestamp when workflow became fully live (one-click path)

  ## Security
  - RLS already enabled on workflow_executions
  - No new tables, no policy changes needed
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_executions' AND column_name = 'orchestration_stage'
  ) THEN
    ALTER TABLE workflow_executions ADD COLUMN orchestration_stage text DEFAULT 'draft_created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_executions' AND column_name = 'test_status'
  ) THEN
    ALTER TABLE workflow_executions ADD COLUMN test_status text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_executions' AND column_name = 'test_execution_id'
  ) THEN
    ALTER TABLE workflow_executions ADD COLUMN test_execution_id text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_executions' AND column_name = 'test_message'
  ) THEN
    ALTER TABLE workflow_executions ADD COLUMN test_message text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_executions' AND column_name = 'approval_url'
  ) THEN
    ALTER TABLE workflow_executions ADD COLUMN approval_url text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_executions' AND column_name = 'credential_types_provisioned'
  ) THEN
    ALTER TABLE workflow_executions ADD COLUMN credential_types_provisioned text[] DEFAULT '{}';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_executions' AND column_name = 'live_deploy_at'
  ) THEN
    ALTER TABLE workflow_executions ADD COLUMN live_deploy_at timestamptz;
  END IF;
END $$;
