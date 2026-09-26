/*
  # Backfill: missing service_role table grants on integration_credentials /
  # credential_verifications (discovered during Workflow #2 Phase D.2A real
  # Gmail OAuth certification)

  ROOT CAUSE: service_role's BYPASSRLS attribute only lets it skip ROW-LEVEL
  policies -- it is NOT a substitute for table-level GRANTs, which are a
  separate Postgres privilege layer evaluated first. Both
  save_credentials_with_verification() (20260520000003) and every direct
  query in lib/credentials/storage.ts run via createServiceClient() as
  service_role, and save_credentials_with_verification() is a plain
  LANGUAGE plpgsql function with no SECURITY DEFINER clause -- so it
  executes with the CALLING role's privileges (service_role), not the
  function owner's. Without explicit table grants, every write attempt
  fails with "permission denied for table integration_credentials" before
  RLS is ever evaluated. This is the exact same class of gap already fixed
  once for the Phase A runtime_* tables in
  20260924000001_add_inbound_reply_sequence_infrastructure.sql -- these two
  tables simply predate that fix and were never covered by it.

  MINIMUM PRIVILEGES (derived from an actual audit of every query in
  lib/credentials/storage.ts against these two tables, not an assumed
  default):
    - integration_credentials: SELECT (getProviderCredentialsForUser,
      verifyProviderConnection, getAllConnectedProviders,
      getCredentialRowId, getCredentialRowById,
      getDecryptedProviderCredentials), INSERT + UPDATE (saveProviderCredentials's
      upsert; save_credentials_with_verification()'s INSERT ... ON CONFLICT
      DO UPDATE), DELETE (deleteProviderCredentials).
    - credential_verifications: SELECT (getVerificationStatus), INSERT +
      UPDATE (updateVerificationStatus / save_credentials_with_verification()'s
      upsert). No code path anywhere in this repository ever deletes a
      credential_verifications row, so DELETE is deliberately withheld here
      -- least privilege, not the repo's usual GRANT ALL pattern.
  Neither table uses a sequence or identity column (both key on
  gen_random_uuid()/a composite natural key), so no sequence grants are
  needed.

  Deliberately NOT touched: anon/authenticated privileges (unchanged --
  this backfill is scoped to service_role only), existing RLS policies
  (untouched, still enforced for authenticated), and any row data.

  SAFE FOR PRODUCTION BY CONSTRUCTION: GRANT is idempotent and additive --
  running this against production (where these grants may already differ)
  only ever adds privileges service_role provably needs per the audit
  above; it never revokes anything or touches existing rows/policies.
  Per Workflow #2 Phase D safety rules, this migration is applied ONLY to
  the isolated local Supabase instance in this phase and is NOT applied to
  production without separate, explicit approval.
*/

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."integration_credentials" TO "service_role";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."credential_verifications" TO "service_role";
