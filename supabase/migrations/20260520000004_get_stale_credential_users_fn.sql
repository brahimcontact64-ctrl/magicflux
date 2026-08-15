-- Returns up to p_limit distinct user_ids whose credential verification records
-- are older than p_threshold (or do not exist), ordered by oldest verified_at first
-- (NULLs first so never-verified users are processed before merely-stale ones).
--
-- Used exclusively by the /api/cron/reverify-credentials route.
-- Only service_role may execute this function.

CREATE OR REPLACE FUNCTION get_stale_credential_users(
  p_threshold timestamptz,
  p_limit     int DEFAULT 50
)
RETURNS TABLE(user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT DISTINCT ON (ic.user_id)
    ic.user_id
  FROM integration_credentials ic
  LEFT JOIN credential_verifications cv
    ON cv.user_id = ic.user_id
   AND cv.provider = ic.provider
  WHERE cv.verified_at IS NULL
     OR cv.verified_at < p_threshold
  ORDER BY ic.user_id, cv.verified_at ASC NULLS FIRST
  LIMIT p_limit;
$$;

REVOKE EXECUTE ON FUNCTION get_stale_credential_users(timestamptz, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_stale_credential_users(timestamptz, int) TO service_role;
