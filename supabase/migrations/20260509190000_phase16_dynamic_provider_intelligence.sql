/*
  # Phase 16: Dynamic Provider Intelligence Memory

  Adds provider intelligence persistence for dynamic provider reasoning,
  learned credentials/auth patterns, runtime health, and adapter metadata.
*/

CREATE TABLE IF NOT EXISTS provider_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  display_name text NOT NULL,
  provider_type text NOT NULL DEFAULT 'other',
  capabilities text[] NOT NULL DEFAULT '{}',
  auth_strategy jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_credentials text[] NOT NULL DEFAULT '{}',
  docs_url text,
  logo_url text,
  validation_strategy text NOT NULL DEFAULT 'ping_endpoint',
  endpoint_hints text[] NOT NULL DEFAULT '{}',
  aliases text[] NOT NULL DEFAULT '{}',
  confidence integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  health_score integer NOT NULL DEFAULT 0,
  last_latency_ms integer,
  estimated_cost_usd numeric(12,6),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_key)
);

CREATE INDEX IF NOT EXISTS provider_intelligence_user_idx
  ON provider_intelligence(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS provider_intelligence_provider_idx
  ON provider_intelligence(provider_key);

CREATE INDEX IF NOT EXISTS provider_intelligence_capabilities_idx
  ON provider_intelligence USING gin(capabilities);

CREATE INDEX IF NOT EXISTS provider_intelligence_aliases_idx
  ON provider_intelligence USING gin(aliases);

ALTER TABLE provider_intelligence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can access own provider intelligence" ON provider_intelligence;
CREATE POLICY "Users can access own provider intelligence" ON provider_intelligence
  FOR ALL USING (auth.uid() = user_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_integrations'
  ) THEN
    ALTER TABLE user_integrations
      ADD COLUMN IF NOT EXISTS provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END $$;
