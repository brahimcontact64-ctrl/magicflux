-- ============================================================================
-- credential_verifications: one row per (user, provider) tracking the last
-- real API validation attempt and its outcome.
--
-- Populated by:
--   - /api/credentials/connect  (on successful save)
--   - /api/credentials/health   (on re-verify)
--   - lib/credentials/stale-verifier.ts  (periodic background reverify)
--
-- Status values:
--   healthy  — last API call confirmed the credentials work
--   expired  — credentials existed but the API reported they are revoked/expired
--   invalid  — API call returned a definitive auth error (401/403)
--   unknown  — verification was skipped (e.g. OAuth providers) or errored
-- ============================================================================

CREATE TABLE IF NOT EXISTS credential_verifications (
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider    text        NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  status      text        NOT NULL DEFAULT 'unknown'
    CONSTRAINT credential_verifications_status_check
      CHECK (status IN ('healthy', 'expired', 'invalid', 'unknown')),
  metadata    jsonb,

  PRIMARY KEY (user_id, provider)
);

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE credential_verifications ENABLE ROW LEVEL SECURITY;

-- Users may read their own verification records (e.g. health-check UI).
CREATE POLICY "credential_verifications: users select own"
  ON credential_verifications
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- All writes come through server-side API routes that use the service-role
-- client with a userId sourced from a verified JWT — no INSERT/UPDATE policy
-- for the authenticated role is required or appropriate here.

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS credential_verifications_user_idx
  ON credential_verifications (user_id);
