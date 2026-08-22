-- ============================================================================
-- integration_credentials: per-key credential storage with field-level
-- verification.  Each row stores one credential field for one provider for
-- one user.  Secret values are AES-256-GCM encrypted before storage.
--
-- This table replaces the coarse-grained "provider connected = yes/no"
-- check that was previously done in user_integrations.  The application
-- layer can now verify which specific fields are present and which are
-- missing without decrypting individual values.
--
-- The user_integrations table is kept for backward compatibility.  The
-- service layer falls back to it when a provider has no rows here.
-- ============================================================================

CREATE TABLE IF NOT EXISTS integration_credentials (
  id               uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider         text        NOT NULL,
  credential_key   text        NOT NULL,
  encrypted_value  text        NOT NULL,
  is_secret        boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT integration_credentials_unique UNIQUE (user_id, provider, credential_key)
);

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE integration_credentials ENABLE ROW LEVEL SECURITY;

-- Users can only SELECT their own rows.
DROP POLICY IF EXISTS "integration_credentials: users select own" ON integration_credentials;
CREATE POLICY "integration_credentials: users select own"
  ON integration_credentials
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Users can only INSERT rows for themselves.
DROP POLICY IF EXISTS "integration_credentials: users insert own" ON integration_credentials;
CREATE POLICY "integration_credentials: users insert own"
  ON integration_credentials
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users can only UPDATE their own rows.
DROP POLICY IF EXISTS "integration_credentials: users update own" ON integration_credentials;
CREATE POLICY "integration_credentials: users update own"
  ON integration_credentials
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can only DELETE their own rows.
DROP POLICY IF EXISTS "integration_credentials: users delete own" ON integration_credentials;
CREATE POLICY "integration_credentials: users delete own"
  ON integration_credentials
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS integration_credentials_user_provider_idx
  ON integration_credentials (user_id, provider);

CREATE INDEX IF NOT EXISTS integration_credentials_user_idx
  ON integration_credentials (user_id);
