/*
  # Phase 3: Planner & Execution Tables

  ## New Tables

  ### 1. `automation_plans`
  Stores AI-generated automation plans from the planner engine.
  - `id` — UUID primary key
  - `session_id` — anonymous session identifier
  - `user_id` — optional authenticated user
  - `prompt` — original user prompt
  - `plan_json` — full AutomationPlan JSON object
  - `composition_json` — ComposedWorkflow JSON (block layout)
  - `n8n_json` — generated n8n-compatible workflow JSON
  - `env_config` — .env file content
  - `pattern` — matched workflow pattern name
  - `trigger_type` — type of trigger used
  - `integrations` — array of required integrations
  - `complexity` — simple/moderate/complex
  - `estimated_nodes` — node count
  - `confidence` — planner confidence 0-100
  - `validation_score` — validation readiness score 0-100
  - `is_valid` — whether workflow passed validation
  - `created_at`

  ### 2. `workflow_executions`
  Tracks n8n deployment and execution history.
  - `id` — UUID primary key
  - `plan_id` — FK to automation_plans
  - `user_id` — optional authenticated user
  - `session_id` — session identifier
  - `n8n_workflow_id` — ID from n8n instance
  - `n8n_instance_url` — n8n instance URL
  - `n8n_execution_id` — specific execution ID
  - `status` — pending/deploying/active/paused/failed/deleted
  - `workflow_name` — name of the workflow
  - `error_message` — error details if failed
  - `deployed_at` — when deployment completed
  - `activated_at` — when workflow was activated
  - `last_checked_at` — last status check time
  - `created_at`

  ## Security
  - RLS enabled on both tables
  - Anonymous users can insert (session-based access)
  - Authenticated users read/write own records
  - No cross-user data access
*/

-- ── automation_plans ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS automation_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      text NOT NULL DEFAULT '',
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  prompt          text NOT NULL DEFAULT '',
  plan_json       jsonb NOT NULL DEFAULT '{}',
  composition_json jsonb NOT NULL DEFAULT '{}',
  n8n_json        jsonb NOT NULL DEFAULT '{}',
  env_config      text NOT NULL DEFAULT '',
  pattern         text NOT NULL DEFAULT '',
  trigger_type    text NOT NULL DEFAULT 'webhook',
  integrations    text[] NOT NULL DEFAULT '{}',
  complexity      text NOT NULL DEFAULT 'simple' CHECK (complexity IN ('simple', 'moderate', 'complex')),
  estimated_nodes integer NOT NULL DEFAULT 0,
  confidence      integer NOT NULL DEFAULT 0,
  validation_score integer NOT NULL DEFAULT 0,
  is_valid        boolean NOT NULL DEFAULT false,
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE automation_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert automation plans"
  ON automation_plans FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read own plans"
  ON automation_plans FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Authenticated users can update own plans"
  ON automation_plans FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS automation_plans_user_id_idx ON automation_plans(user_id);
CREATE INDEX IF NOT EXISTS automation_plans_session_id_idx ON automation_plans(session_id);
CREATE INDEX IF NOT EXISTS automation_plans_created_at_idx ON automation_plans(created_at DESC);

-- ── workflow_executions ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_executions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             uuid REFERENCES automation_plans(id) ON DELETE SET NULL,
  user_id             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id          text NOT NULL DEFAULT '',
  n8n_workflow_id     text NOT NULL DEFAULT '',
  n8n_instance_url    text NOT NULL DEFAULT '',
  n8n_execution_id    text,
  status              text NOT NULL DEFAULT 'pending' CHECK (
                        status IN ('pending', 'deploying', 'active', 'paused', 'failed', 'deleted')
                      ),
  workflow_name       text NOT NULL DEFAULT '',
  error_message       text,
  deployed_at         timestamptz,
  activated_at        timestamptz,
  last_checked_at     timestamptz DEFAULT now(),
  created_at          timestamptz DEFAULT now()
);

ALTER TABLE workflow_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert workflow executions"
  ON workflow_executions FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read own executions"
  ON workflow_executions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Authenticated users can update own executions"
  ON workflow_executions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS workflow_executions_user_id_idx ON workflow_executions(user_id);
CREATE INDEX IF NOT EXISTS workflow_executions_plan_id_idx ON workflow_executions(plan_id);
CREATE INDEX IF NOT EXISTS workflow_executions_status_idx ON workflow_executions(status);
CREATE INDEX IF NOT EXISTS workflow_executions_created_at_idx ON workflow_executions(created_at DESC);
