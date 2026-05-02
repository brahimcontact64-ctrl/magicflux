/*
  # Phase 3: Managed Service Tables

  ## Summary
  Adds tables required for the managed SaaS product layer:
  multi-tenant user accounts, workflow deployments, credential vaults,
  managed service requests, and AI tool-action audit log.

  ## New Tables

  ### 1. user_profiles
  Extends auth.users with plan, org, and managed-mode preferences.
  - id (uuid, FK → auth.users)
  - plan: 'free' | 'diy' | 'managed' | 'enterprise'
  - company, industry, n8n_instance_url, managed_mode

  ### 2. workflow_deployments
  Every time a user deploys or requests deployment of a workflow.
  - id, user_id (nullable for anon sessions), template_id, template_name
  - deployment_mode: 'download' | 'self_deploy' | 'managed'
  - status: 'pending' | 'deploying' | 'active' | 'failed' | 'cancelled'
  - n8n_workflow_id, n8n_instance_url, error_message
  - workflow_json (the generated JSON), applied_customizations (jsonb array)

  ### 3. credential_configs
  Per-user per-service credential placeholders (never store real secrets here).
  - id, user_id, service (gmail|slack|shopify|twilio|airtable|hubspot|n8n)
  - is_configured (boolean flag)
  - config_meta (jsonb — non-secret config like account names, webhook URLs)
  - verified_at

  ### 4. managed_requests
  "Run it for me" service requests submitted by users.
  - id, user_id, deployment_id (FK)
  - request_type: 'setup' | 'customization' | 'support'
  - description, status, assigned_to, resolution_notes, resolved_at

  ### 5. tool_action_log
  Audit trail for AI agent tool-use actions (add_slack, add_approval, etc.).
  - id, session_id, user_id, deployment_id
  - action_type (ModificationType), prompt, result_summary, applied_at

  ## Security
  - RLS on all tables
  - Users can only read/write their own rows
  - Anon users can insert workflow_deployments (session-based)
  - Managed requests require authenticated users
*/

-- ── user_profiles ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','diy','managed','enterprise')),
  company text DEFAULT '',
  industry text DEFAULT '',
  n8n_instance_url text DEFAULT '',
  managed_mode boolean NOT NULL DEFAULT false,
  onboarding_complete boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON user_profiles FOR SELECT TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON user_profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON user_profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ── workflow_deployments ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id text DEFAULT '',
  template_id text NOT NULL,
  template_name text NOT NULL,
  industry text NOT NULL,
  deployment_mode text NOT NULL DEFAULT 'download'
    CHECK (deployment_mode IN ('download','self_deploy','managed')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','deploying','active','failed','cancelled')),
  n8n_workflow_id text DEFAULT '',
  n8n_instance_url text DEFAULT '',
  error_message text DEFAULT '',
  workflow_json jsonb,
  applied_customizations jsonb DEFAULT '[]'::jsonb,
  package_score jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE workflow_deployments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon can insert deployments"
  ON workflow_deployments FOR INSERT TO anon
  WITH CHECK (template_id IS NOT NULL);

CREATE POLICY "Authenticated can insert deployments"
  ON workflow_deployments FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Users can view own deployments"
  ON workflow_deployments FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own deployments"
  ON workflow_deployments FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── credential_configs ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS credential_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service text NOT NULL CHECK (service IN ('gmail','slack','shopify','twilio','airtable','hubspot','n8n','google_sheets','google_calendar','webhook')),
  is_configured boolean NOT NULL DEFAULT false,
  config_meta jsonb DEFAULT '{}'::jsonb,
  verified_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, service)
);

ALTER TABLE credential_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own credentials"
  ON credential_configs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own credentials"
  ON credential_configs FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own credentials"
  ON credential_configs FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── managed_requests ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS managed_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  deployment_id uuid REFERENCES workflow_deployments(id) ON DELETE SET NULL,
  request_type text NOT NULL DEFAULT 'setup'
    CHECK (request_type IN ('setup','customization','support')),
  template_id text DEFAULT '',
  template_name text DEFAULT '',
  description text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','resolved','cancelled')),
  assigned_to text DEFAULT '',
  resolution_notes text DEFAULT '',
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE managed_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own managed requests"
  ON managed_requests FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert managed requests"
  ON managed_requests FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own managed requests"
  ON managed_requests FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── tool_action_log ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tool_action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text DEFAULT '',
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deployment_id uuid REFERENCES workflow_deployments(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  prompt text NOT NULL,
  result_summary text DEFAULT '',
  applied_at timestamptz DEFAULT now()
);

ALTER TABLE tool_action_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon can insert tool actions"
  ON tool_action_log FOR INSERT TO anon
  WITH CHECK (action_type IS NOT NULL AND prompt IS NOT NULL);

CREATE POLICY "Authenticated can insert tool actions"
  ON tool_action_log FOR INSERT TO authenticated
  WITH CHECK (action_type IS NOT NULL AND prompt IS NOT NULL);

CREATE POLICY "Users can view own tool actions"
  ON tool_action_log FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ── indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_deployments_user ON workflow_deployments(user_id);
CREATE INDEX IF NOT EXISTS idx_deployments_session ON workflow_deployments(session_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON workflow_deployments(status);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credential_configs(user_id);
CREATE INDEX IF NOT EXISTS idx_managed_req_user ON managed_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_managed_req_status ON managed_requests(status);
CREATE INDEX IF NOT EXISTS idx_tool_log_session ON tool_action_log(session_id);
