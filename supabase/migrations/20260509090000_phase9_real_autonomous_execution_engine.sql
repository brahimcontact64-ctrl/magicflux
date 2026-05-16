/*
  # Phase 9: Real Autonomous Execution Engine

  Adds execution checkpoints, runtime control flags, persisted node lifecycle
  states, graph mutation history, and expanded timeline taxonomy.
*/

-- ============================================================================
-- 1) Runtime control + checkpoints
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_execution_controls (
  execution_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pause_requested boolean NOT NULL DEFAULT false,
  cancel_requested boolean NOT NULL DEFAULT false,
  resume_requested boolean NOT NULL DEFAULT false,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_execution_controls_user_idx
  ON runtime_execution_controls(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS runtime_execution_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id text NOT NULL,
  workflow_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  checkpoint_type text NOT NULL CHECK (
    checkpoint_type IN (
      'node_completed',
      'waiting',
      'paused',
      'retrying',
      'cancelled',
      'failed',
      'completed'
    )
  ),
  current_node_id text,
  state_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  pending_queue jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_execution_checkpoints_execution_idx
  ON runtime_execution_checkpoints(execution_id, created_at DESC);

-- ============================================================================
-- 2) Persisted node state model
-- ============================================================================

CREATE TABLE IF NOT EXISTS runtime_node_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id text NOT NULL,
  workflow_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  node_name text NOT NULL,
  node_type text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('queued', 'running', 'success', 'failed', 'retrying', 'cancelled')
  ),
  attempt integer NOT NULL DEFAULT 1,
  input_data jsonb,
  output_data jsonb,
  logs text[] NOT NULL DEFAULT '{}',
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, node_id, attempt, status)
);

CREATE INDEX IF NOT EXISTS runtime_node_states_execution_idx
  ON runtime_node_states(execution_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS runtime_node_states_user_idx
  ON runtime_node_states(user_id, updated_at DESC);

-- ============================================================================
-- 3) Graph mutation history
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_graph_mutations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  version integer NOT NULL,
  mutation_type text NOT NULL,
  reason text,
  patch jsonb NOT NULL DEFAULT '{}'::jsonb,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_graph_mutations_workflow_idx
  ON workflow_graph_mutations(workflow_id, version DESC);

CREATE INDEX IF NOT EXISTS workflow_graph_mutations_user_idx
  ON workflow_graph_mutations(user_id, created_at DESC);

-- ============================================================================
-- 4) Expand timeline event taxonomy
-- ============================================================================

ALTER TABLE timeline_events
  DROP CONSTRAINT IF EXISTS timeline_events_event_type_check;

ALTER TABLE timeline_events
  ADD CONSTRAINT timeline_events_event_type_check CHECK (
    event_type IN (
      'workflow_generated',
      'workflow_mutated',
      'node_created',
      'graph_mutated',
      'integration_connected',
      'credentials_required',
      'execution_started',
      'execution_completed',
      'test_succeeded',
      'deployment_started',
      'deployment_completed',
      'retry_attempt',
      'runtime_failure',
      'failure_recovered',
      'rollback_executed'
    )
  );

-- ============================================================================
-- 5) RLS policies
-- ============================================================================

ALTER TABLE runtime_execution_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_execution_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_node_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_graph_mutations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can access own execution controls" ON runtime_execution_controls;
CREATE POLICY "Users can access own execution controls" ON runtime_execution_controls
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can access own execution checkpoints" ON runtime_execution_checkpoints;
CREATE POLICY "Users can access own execution checkpoints" ON runtime_execution_checkpoints
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can access own runtime node states" ON runtime_node_states;
CREATE POLICY "Users can access own runtime node states" ON runtime_node_states
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can access own workflow graph mutations" ON workflow_graph_mutations;
CREATE POLICY "Users can access own workflow graph mutations" ON workflow_graph_mutations
  FOR ALL USING (auth.uid() = user_id);
