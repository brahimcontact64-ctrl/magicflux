/*
  # Phase 6: Event Bus + Execution Queues + Runtime Discipline

  Adds typed runtime event stream, dead-letter persistence, and queue job tracking.
*/

CREATE TABLE IF NOT EXISTS runtime_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  timestamp timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  workflow_id text,
  session_id text,
  agent_id text,
  execution_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical')),
  correlation_id text NOT NULL,
  source text NOT NULL DEFAULT 'runtime',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_events_user_idx
  ON runtime_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_events_session_idx
  ON runtime_events(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_events_corr_idx
  ON runtime_events(correlation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_events_type_idx
  ON runtime_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_event_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid,
  event_type text NOT NULL,
  correlation_id text NOT NULL,
  reason text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS runtime_event_dead_letters_corr_idx
  ON runtime_event_dead_letters(correlation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_queue_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id text,
  workflow_id text,
  queue_name text NOT NULL,
  job_id text NOT NULL,
  task_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'active', 'completed', 'failed', 'delayed', 'waiting', 'stalled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  delay_ms integer NOT NULL DEFAULT 0,
  priority integer,
  correlation_id text NOT NULL,
  dedupe_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error_message text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_queue_jobs_user_idx
  ON runtime_queue_jobs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_queue_jobs_session_idx
  ON runtime_queue_jobs(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_queue_jobs_corr_idx
  ON runtime_queue_jobs(correlation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS runtime_queue_jobs_status_idx
  ON runtime_queue_jobs(status, created_at DESC);

ALTER TABLE runtime_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_event_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_queue_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own runtime events" ON runtime_events;

CREATE POLICY "Users can view own runtime events"
  ON runtime_events FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own runtime events" ON runtime_events;

CREATE POLICY "Users can insert own runtime events"
  ON runtime_events FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own runtime dead letters" ON runtime_event_dead_letters;

CREATE POLICY "Users can view own runtime dead letters"
  ON runtime_event_dead_letters FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM runtime_events e
      WHERE e.event_id = runtime_event_dead_letters.event_id
        AND e.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert own runtime dead letters" ON runtime_event_dead_letters;

CREATE POLICY "Users can insert own runtime dead letters"
  ON runtime_event_dead_letters FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM runtime_events e
      WHERE e.event_id = runtime_event_dead_letters.event_id
        AND e.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can view own runtime queue jobs" ON runtime_queue_jobs;

CREATE POLICY "Users can view own runtime queue jobs"
  ON runtime_queue_jobs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own runtime queue jobs" ON runtime_queue_jobs;

CREATE POLICY "Users can insert own runtime queue jobs"
  ON runtime_queue_jobs FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own runtime queue jobs" ON runtime_queue_jobs;

CREATE POLICY "Users can update own runtime queue jobs"
  ON runtime_queue_jobs FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
