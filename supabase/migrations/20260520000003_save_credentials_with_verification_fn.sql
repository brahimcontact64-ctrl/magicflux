-- ============================================================================
-- save_credentials_with_verification()
--
-- Atomically upserts one or more integration_credentials rows together with
-- the matching credential_verifications record.  Both writes happen inside a
-- single PL/pgSQL transaction: either both succeed or both roll back.
--
-- Called from: lib/credentials/storage.ts saveCredentialsWithVerification()
-- Client used: service-role (bypasses RLS)
-- ============================================================================

CREATE OR REPLACE FUNCTION save_credentials_with_verification(
  p_user_id  uuid,
  p_provider text,
  p_rows     jsonb,     -- array of {credential_key, encrypted_value, is_secret, created_at, updated_at}
  p_status   text,
  p_metadata jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Guard against unexpected status values at the DB layer
  IF p_status NOT IN ('healthy', 'expired', 'invalid', 'unknown') THEN
    RAISE EXCEPTION 'save_credentials_with_verification: invalid status value "%"', p_status;
  END IF;

  -- Upsert every credential row in the provided array
  INSERT INTO integration_credentials (
    user_id,
    provider,
    credential_key,
    encrypted_value,
    is_secret,
    created_at,
    updated_at
  )
  SELECT
    p_user_id,
    p_provider,
    (r->>'credential_key')::text,
    (r->>'encrypted_value')::text,
    (r->>'is_secret')::boolean,
    (r->>'created_at')::timestamptz,
    (r->>'updated_at')::timestamptz
  FROM jsonb_array_elements(p_rows) AS r
  ON CONFLICT (user_id, provider, credential_key)
  DO UPDATE SET
    encrypted_value = EXCLUDED.encrypted_value,
    is_secret       = EXCLUDED.is_secret,
    updated_at      = EXCLUDED.updated_at;

  -- Atomically upsert the verification record
  INSERT INTO credential_verifications (user_id, provider, verified_at, status, metadata)
  VALUES (p_user_id, p_provider, now(), p_status, p_metadata)
  ON CONFLICT (user_id, provider)
  DO UPDATE SET
    verified_at = now(),
    status      = EXCLUDED.status,
    metadata    = EXCLUDED.metadata;

  -- Any exception above causes an automatic ROLLBACK of the entire function.
END;
$$;

-- Only the service-role should call this function (it writes both tables).
REVOKE EXECUTE ON FUNCTION save_credentials_with_verification(uuid, text, jsonb, text, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION save_credentials_with_verification(uuid, text, jsonb, text, jsonb) TO service_role;
