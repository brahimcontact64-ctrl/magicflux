/*
  # Phase 7: Runtime Infrastructure Hardening

  Adds distributed tracing, worker registry, replay persistence,
  queue DLQ expansion, retention support, and runtime cancellation primitives.
*/

ALTER TABLE runtime_events
  ADD COLUMN IF NOT EXISTS trace_id text,
  ADD COLUMN IF NOT EXISTS span_id text,
  ADD COLUMN IF NOT EXISTS parent_span_id text;

CREATE INDEX IF NOT EXISTS runtime_events_trace_idx
  ON runtime_events(trace_id, created_at DESC);

ALTER TABLE runtime_queue_jobs
  ADD COLUMN IF NOT EXISTS trace_id text,
  ADD COLUMN IF NOT EXISTS span_id text,
  ADD COLUMN IF NOT EXISTS parent_span_id text,
  ADD COLUMN IF NOT EXISTS cancelled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS timeout_ms integer,
  ADD COLUMN IF NOT EXISTS execution_id text;

CREATE INDEX IF NOT EXISTS runtime_queue_jobs_trace_idx
  ON runtime_queue_jobs(trace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_traces (
  trace_id text PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id text,
  workflow_id text,
  execution_id text,
  correlation_id text NOT NULL,
  root_agent text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_traces_user_idx
  ON runtime_traces(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_traces_corr_idx
  ON runtime_traces(correlation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_spans (
  span_id text PRIMARY KEY,
  trace_id text NOT NULL REFERENCES runtime_traces(trace_id) ON DELETE CASCADE,
  parent_span_id text,
  name text NOT NULL,
  kind text NOT NULL,
  agent_id text,
  queue_name text,
  job_id text,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id text,
  workflow_id text,
  execution_id text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'error', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_ms integer,
  error_message text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_spans_trace_idx
  ON runtime_spans(trace_id, started_at DESC);

CREATE INDEX IF NOT EXISTS runtime_spans_user_idx
  ON runtime_spans(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS runtime_workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id text NOT NULL UNIQUE,
  hostname text,
  pid integer,
  queues text[] NOT NULL DEFAULT '{}',
  capabilities text[] NOT NULL DEFAULT '{}',
  concurrency integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'healthy', 'degraded', 'stopping', 'stopped', 'crashed')),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  cpu_load numeric(8,4),
  memory_mb numeric(12,2),
  jobs_processed bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_workers_status_idx
  ON runtime_workers(status, heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS runtime_queue_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  queue_name text NOT NULL,
  task_type text NOT NULL,
  job_id text,
  trace_id text,
  span_id text,
  correlation_id text,
  session_id text,
  workflow_id text,
  execution_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  stack_trace text,
  error_message text,
  failed_at timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  replay_status text CHECK (replay_status IN ('pending', 'replayed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_queue_dlq_user_idx
  ON runtime_queue_dead_letters(user_id, failed_at DESC);

CREATE INDEX IF NOT EXISTS runtime_queue_dlq_trace_idx
  ON runtime_queue_dead_letters(trace_id, failed_at DESC);

CREATE TABLE IF NOT EXISTS runtime_replays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  replay_type text NOT NULL CHECK (replay_type IN ('execution', 'step', 'dlq_job', 'event_stream', 'queue_job', 'tool_call')),
  source_execution_id text,
  source_step_id text,
  source_event_id uuid,
  source_queue_job_id text,
  source_dlq_id uuid,
  original_trace_id text,
  replay_trace_id text,
  correlation_id text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  result jsonb,
  error_message text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_replays_user_idx
  ON runtime_replays(user_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS runtime_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  execution_id text,
  trace_id text,
  queue_job_id text,
  reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'applied', 'failed')),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE runtime_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_spans ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_queue_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_cancellations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own traces" ON runtime_traces;

CREATE POLICY "Users can view own traces"
  ON runtime_traces FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own traces" ON runtime_traces;

CREATE POLICY "Users can insert own traces"
  ON runtime_traces FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own traces" ON runtime_traces;

CREATE POLICY "Users can update own traces"
  ON runtime_traces FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own spans" ON runtime_spans;

CREATE POLICY "Users can view own spans"
  ON runtime_spans FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own spans" ON runtime_spans;

CREATE POLICY "Users can insert own spans"
  ON runtime_spans FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own spans" ON runtime_spans;

CREATE POLICY "Users can update own spans"
  ON runtime_spans FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own workers" ON runtime_workers;

CREATE POLICY "Users can view own workers"
  ON runtime_workers FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Users can insert workers" ON runtime_workers;

CREATE POLICY "Users can insert workers"
  ON runtime_workers FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can update workers" ON runtime_workers;

CREATE POLICY "Users can update workers"
  ON runtime_workers FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Users can view own queue dlq" ON runtime_queue_dead_letters;

CREATE POLICY "Users can view own queue dlq"
  ON runtime_queue_dead_letters FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own queue dlq" ON runtime_queue_dead_letters;

CREATE POLICY "Users can insert own queue dlq"
  ON runtime_queue_dead_letters FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own queue dlq" ON runtime_queue_dead_letters;

CREATE POLICY "Users can update own queue dlq"
  ON runtime_queue_dead_letters FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own replays" ON runtime_replays;

CREATE POLICY "Users can view own replays"
  ON runtime_replays FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own replays" ON runtime_replays;

CREATE POLICY "Users can insert own replays"
  ON runtime_replays FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own replays" ON runtime_replays;

CREATE POLICY "Users can update own replays"
  ON runtime_replays FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own cancellations" ON runtime_cancellations;

CREATE POLICY "Users can view own cancellations"
  ON runtime_cancellations FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own cancellations" ON runtime_cancellations;

CREATE POLICY "Users can insert own cancellations"
  ON runtime_cancellations FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own cancellations" ON runtime_cancellations;

CREATE POLICY "Users can update own cancellations"
  ON runtime_cancellations FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
