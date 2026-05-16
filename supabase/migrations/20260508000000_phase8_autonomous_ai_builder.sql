/*
  # Phase 8: Autonomous AI Builder Operating System

  Adds persistent project memory, background tasks, multi-agent orchestration,
  file generation, self-healing retries, runtime timeline, live graph mutation,
  deployment rollback, and editable workflow graphs.
*/

-- ============================================================================
-- 1. PERSISTENT PROJECT MEMORY
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  memory_type text NOT NULL CHECK (memory_type IN ('workflow', 'integration', 'preference', 'business_context', 'goal', 'error_fix', 'deployment')),
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  importance_score numeric(3,2) NOT NULL DEFAULT 0.5 CHECK (importance_score >= 0 AND importance_score <= 1),
  last_accessed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, project_id, memory_type, key)
);

CREATE INDEX IF NOT EXISTS project_memory_user_project_idx
  ON project_memory(user_id, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS project_memory_type_key_idx
  ON project_memory(memory_type, key);

CREATE INDEX IF NOT EXISTS project_memory_accessed_idx
  ON project_memory(last_accessed_at DESC);

-- Workflow-specific memory
CREATE TABLE IF NOT EXISTS workflow_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  memory_type text NOT NULL CHECK (memory_type IN ('architecture', 'integrations', 'preferences', 'errors', 'deployments')),
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, workflow_id, version, memory_type, key)
);

CREATE INDEX IF NOT EXISTS workflow_memory_workflow_idx
  ON workflow_memory(workflow_id, version, created_at DESC);

-- Agent memory events for learning
CREATE TABLE IF NOT EXISTS agent_memory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  workflow_id text,
  agent_name text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('decision', 'success', 'failure', 'learning', 'adaptation')),
  action_taken text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  learnings jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence_score numeric(3,2),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_memory_events_user_idx
  ON agent_memory_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_memory_events_agent_idx
  ON agent_memory_events(agent_name, created_at DESC);

-- ============================================================================
-- 2. BACKGROUND AUTONOMOUS TASKS
-- ============================================================================

CREATE TABLE IF NOT EXISTS background_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  workflow_id text,
  task_type text NOT NULL CHECK (task_type IN ('generate_workflow', 'validate_integrations', 'deploy_workflow', 'test_execution', 'monitor_runs', 'retry_failed', 'generate_report')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting_for_credentials', 'waiting_for_approval', 'completed', 'failed', 'cancelled')),
  priority integer NOT NULL DEFAULT 0,
  queue_name text NOT NULL DEFAULT 'default',
  job_id text UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error_message text,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_count integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 3,
  timeout_ms integer,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS background_tasks_user_status_idx
  ON background_tasks(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS background_tasks_workflow_idx
  ON background_tasks(workflow_id, status);

CREATE INDEX IF NOT EXISTS background_tasks_queue_idx
  ON background_tasks(queue_name, status, priority DESC, created_at ASC);

-- ============================================================================
-- 3. MULTI-AGENT ORCHESTRATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_orchestration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  workflow_id text,
  root_agent text NOT NULL DEFAULT 'planner',
  current_agent text NOT NULL,
  orchestration_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  agent_states jsonb NOT NULL DEFAULT '{}'::jsonb,
  shared_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  handoffs jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_orchestration_session_idx
  ON agent_orchestration(session_id, created_at DESC);

-- ============================================================================
-- 4. REAL FILE / CODE GENERATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS generated_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workflow_id text,
  session_id text,
  file_type text NOT NULL CHECK (file_type IN ('workflow_json', 'env_template', 'setup_guide', 'schema_snippet', 'n8n_export', 'integration_config', 'dashboard_scaffold')),
  file_name text NOT NULL,
  file_path text,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  generated_by text NOT NULL DEFAULT 'ai',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS generated_files_user_workflow_idx
  ON generated_files(user_id, workflow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS generated_files_type_idx
  ON generated_files(file_type, created_at DESC);

-- File version history
CREATE TABLE IF NOT EXISTS generated_file_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES generated_files(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content text NOT NULL,
  changes_description text,
  created_by text NOT NULL DEFAULT 'ai',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(file_id, version)
);

CREATE INDEX IF NOT EXISTS generated_file_versions_file_idx
  ON generated_file_versions(file_id, version DESC);

-- ============================================================================
-- 5. SELF-HEALING RETRIES
-- ============================================================================

CREATE TABLE IF NOT EXISTS retry_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  failure_class text NOT NULL CHECK (failure_class IN ('temporary_api_failure', 'invalid_credentials', 'rate_limit', 'deployment_failure', 'validation_failure', 'missing_provider', 'runtime_error')),
  max_retries integer NOT NULL DEFAULT 3,
  base_delay_ms integer NOT NULL DEFAULT 1000,
  max_delay_ms integer NOT NULL DEFAULT 30000,
  backoff_multiplier numeric(3,2) NOT NULL DEFAULT 2.0,
  jitter_enabled boolean NOT NULL DEFAULT true,
  recovery_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Insert default retry policies
INSERT INTO retry_policies (name, failure_class, max_retries, base_delay_ms, max_delay_ms, backoff_multiplier, recovery_actions)
VALUES
  ('api_transient', 'temporary_api_failure', 5, 1000, 30000, 2.0, '["retry"]'::jsonb),
  ('credentials_invalid', 'invalid_credentials', 0, 0, 0, 1.0, '["request_credentials"]'::jsonb),
  ('rate_limit', 'rate_limit', 3, 2000, 60000, 2.0, '["retry", "notify_user"]'::jsonb),
  ('deployment_fail', 'deployment_failure', 2, 5000, 30000, 1.5, '["rollback", "notify_user"]'::jsonb),
  ('validation_fail', 'validation_failure', 1, 1000, 5000, 1.0, '["fix_validation", "notify_user"]'::jsonb),
  ('provider_missing', 'missing_provider', 0, 0, 0, 1.0, '["request_provider"]'::jsonb),
  ('runtime_error', 'runtime_error', 3, 2000, 15000, 1.8, '["retry", "log_error"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS failure_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id text,
  workflow_id text,
  failure_class text NOT NULL,
  original_error text NOT NULL,
  retry_count integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL,
  next_retry_at timestamptz,
  recovery_action text,
  recovery_result jsonb,
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS failure_attempts_user_idx
  ON failure_attempts(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS failure_attempts_workflow_idx
  ON failure_attempts(workflow_id, created_at DESC);

-- ============================================================================
-- 6. RUNTIME EVENT TIMELINE
-- ============================================================================

CREATE TABLE IF NOT EXISTS timeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  workflow_id text,
  event_type text NOT NULL CHECK (event_type IN ('workflow_generated', 'integration_connected', 'credentials_required', 'test_succeeded', 'deployment_completed', 'retry_attempt', 'failure_recovered', 'rollback_executed')),
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'info' CHECK (status IN ('info', 'success', 'warning', 'error')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  internal_event_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS timeline_events_user_session_idx
  ON timeline_events(user_id, session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS timeline_events_workflow_idx
  ON timeline_events(workflow_id, created_at DESC);

-- ============================================================================
-- 7. LIVE NODE MUTATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_graph_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  version integer NOT NULL,
  graph_data jsonb NOT NULL,
  changes_description text,
  changed_by text NOT NULL DEFAULT 'ai',
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_id, version)
);

CREATE INDEX IF NOT EXISTS workflow_graph_versions_workflow_idx
  ON workflow_graph_versions(workflow_id, version DESC);

-- ============================================================================
-- 8. DEPLOY ROLLBACK
-- ============================================================================

CREATE TABLE IF NOT EXISTS deployment_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  version integer NOT NULL,
  deployment_id text NOT NULL,
  n8n_workflow_id text,
  status text NOT NULL CHECK (status IN ('active', 'rolled_back', 'superseded')),
  deployed_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  rollback_reason text,
  workflow_data jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_id, version)
);

CREATE INDEX IF NOT EXISTS deployment_versions_workflow_idx
  ON deployment_versions(workflow_id, version DESC);

CREATE INDEX IF NOT EXISTS deployment_versions_status_idx
  ON deployment_versions(status, deployed_at DESC);

-- ============================================================================
-- 9. EDITABLE VISUAL WORKFLOW GRAPH
-- ============================================================================

ALTER TABLE workflow_graph_versions
  ADD COLUMN IF NOT EXISTS layout_positions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS node_states jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ============================================================================
-- UPDATE EXISTING TABLES (SAFE MODE)
-- ============================================================================

-- Add memory context to conversations (only if table exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'conversations'
  ) THEN
    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS memory_context jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS project_id text,
      ADD COLUMN IF NOT EXISTS workflow_id text;
  END IF;
END $$;

-- Add timeline support to runtime events (only if table exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'runtime_events'
  ) THEN
    ALTER TABLE runtime_events
      ADD COLUMN IF NOT EXISTS timeline_event_id uuid REFERENCES timeline_events(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Add orchestration support to agent action events (only if table exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'agent_action_events'
  ) THEN
    ALTER TABLE agent_action_events
      ADD COLUMN IF NOT EXISTS orchestration_id text,
      ADD COLUMN IF NOT EXISTS agent_handoff jsonb;
  END IF;
END $$;

-- ============================================================================
-- RLS POLICIES (SAFE MODE)
-- ============================================================================

-- Project memory policies
ALTER TABLE project_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can access their own project memory" ON project_memory;
CREATE POLICY "Users can access their own project memory" ON project_memory
  FOR ALL USING (auth.uid() = user_id);

-- Workflow memory policies
ALTER TABLE workflow_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can access their own workflow memory" ON workflow_memory;
CREATE POLICY "Users can access their own workflow memory" ON workflow_memory
  FOR ALL USING (auth.uid() = user_id);

-- Agent memory events policies
ALTER TABLE agent_memory_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can access their own agent memory events" ON agent_memory_events;
CREATE POLICY "Users can access their own agent memory events" ON agent_memory_events
  FOR ALL USING (auth.uid() = user_id);

-- Background tasks policies
ALTER TABLE background_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can access their own background tasks" ON background_tasks;
CREATE POLICY "Users can access their own background tasks" ON background_tasks
  FOR ALL USING (auth.uid() = user_id);

-- Agent orchestration policies
ALTER TABLE agent_orchestration ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can access their own agent orchestrations" ON agent_orchestration;
CREATE POLICY "Users can access their own agent orchestrations" ON agent_orchestration
  FOR ALL USING (auth.uid() = user_id);

-- Generated files policies
ALTER TABLE generated_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can access their own generated files" ON generated_files;
CREATE POLICY "Users can access their own generated files" ON generated_files
  FOR ALL USING (auth.uid() = user_id);

-- Generated file versions policies (uses ownership through generated_files relation)
ALTER TABLE generated_file_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can access versions of their own files" ON generated_file_versions;
CREATE POLICY "Users can access versions of their own files" ON generated_file_versions
  FOR ALL USING (
    EXISTS (
      SELECT 1
      FROM generated_files gf
      WHERE gf.id = generated_file_versions.file_id
      AND gf.user_id = auth.uid()
    )
  );

-- Failure attempts policies
ALTER TABLE failure_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can access their own failure attempts" ON failure_attempts;
CREATE POLICY "Users can access their own failure attempts" ON failure_attempts
  FOR ALL USING (auth.uid() = user_id);

-- Timeline events policies
ALTER TABLE timeline_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can access their own timeline events" ON timeline_events;
CREATE POLICY "Users can access their own timeline events" ON timeline_events
  FOR ALL USING (auth.uid() = user_id);

-- Workflow graph versions policies
ALTER TABLE workflow_graph_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can access their own workflow graph versions" ON workflow_graph_versions;
CREATE POLICY "Users can access their own workflow graph versions" ON workflow_graph_versions
  FOR ALL USING (auth.uid() = user_id);

-- Deployment versions policies
ALTER TABLE deployment_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can access their own deployment versions" ON deployment_versions;
CREATE POLICY "Users can access their own deployment versions" ON deployment_versions
  FOR ALL USING (auth.uid() = user_id);