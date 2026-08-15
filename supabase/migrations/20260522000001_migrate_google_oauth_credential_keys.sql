-- ============================================================================
-- Migrate shared Google OAuth credential key to per-provider isolated keys.
--
-- Before this migration, gmail / google_sheets / google_drive all stored
-- their OAuth token under the same credential_key = 'oauth_google', meaning
-- connecting any one provider would overwrite the others.
--
-- After this migration each provider uses its own key:
--   gmail         → oauth_google_gmail
--   google_sheets → oauth_google_sheets
--   google_drive  → oauth_google_drive
--
-- Two scenarios are handled atomically inside a DO block:
--
--   1. Conflict row exists (user reconnected after the code change was
--      deployed but before this migration ran):
--      Both oauth_google AND oauth_google_<provider> rows exist for the
--      same (user_id, provider).  The new-style row is already correct;
--      the stale oauth_google row is deleted.
--
--   2. Only the old oauth_google row exists (user connected before the
--      code change and has not reconnected):
--      credential_key is renamed to oauth_google_<provider>.  The
--      encrypted_value (AES-256-GCM token blob) is preserved unchanged.
--
-- Idempotent: running this migration again after it has already succeeded
-- is a no-op because no oauth_google rows remain for these providers.
--
-- Constraint preserved: UNIQUE (user_id, provider, credential_key).
-- ============================================================================

DO $$
BEGIN

  -- ── Step 1: remove stale oauth_google rows that would cause a UNIQUE ──────
  -- conflict when we rename in Step 2.  This only affects users who
  -- successfully reconnected their Google provider after the code was
  -- updated to write oauth_google_<provider> but before this migration ran.
  -- Their fresh token is already in the new-style row; the old row is noise.

  DELETE FROM integration_credentials AS old_row
  WHERE old_row.provider     IN ('gmail', 'google_sheets', 'google_drive')
    AND old_row.credential_key = 'oauth_google'
    AND EXISTS (
      SELECT 1
      FROM   integration_credentials AS new_row
      WHERE  new_row.user_id  = old_row.user_id
        AND  new_row.provider = old_row.provider
        AND  new_row.credential_key = CASE old_row.provider
               WHEN 'gmail'         THEN 'oauth_google_gmail'
               WHEN 'google_sheets' THEN 'oauth_google_sheets'
               WHEN 'google_drive'  THEN 'oauth_google_drive'
             END
    );

  -- ── Step 2: rename remaining oauth_google rows ────────────────────────────
  -- After Step 1 there are no new-style rows for the same (user_id, provider),
  -- so this UPDATE cannot violate the UNIQUE constraint.

  UPDATE integration_credentials
  SET
    credential_key = CASE provider
                       WHEN 'gmail'         THEN 'oauth_google_gmail'
                       WHEN 'google_sheets' THEN 'oauth_google_sheets'
                       WHEN 'google_drive'  THEN 'oauth_google_drive'
                     END,
    updated_at     = now()
  WHERE provider      IN ('gmail', 'google_sheets', 'google_drive')
    AND credential_key = 'oauth_google';

END;
$$;
