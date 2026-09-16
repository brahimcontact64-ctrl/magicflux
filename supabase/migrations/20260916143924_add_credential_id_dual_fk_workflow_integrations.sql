-- Phase 9.9.8E -- workflow_integrations.integration_id has a single FK to
-- user_integrations(id). Phase 9.9.8C's Gmail OAuth discovery/attach fix
-- (necessarily) surfaces integration_credentials.id for OAuth-bridged
-- providers, since that table -- not user_integrations -- is where a real
-- Gmail credential's identity lives. Persisting that id into integration_id
-- can never succeed: it is a value from a disjoint UUID space that is never
-- present in user_integrations, so every attach attempt fails with a
-- Postgres 23503 foreign_key_violation, surfaced to the client as a generic
-- "temporary_system_problem" (confirmed live in production, read-only, via
-- matching 503s in `vercel logs` and a direct query proving the real Gmail
-- credential id does not exist in user_integrations).
--
-- A single FK column cannot validly reference two different tables. This
-- migration adds a second, independently-enforced identity column instead
-- of weakening the existing one:
--   * integration_id  -- kept, FK unchanged, now nullable -- legacy
--     Airtable/Slack/SMTP-email attachments (user_integrations.id).
--   * credential_id    -- new, nullable, FK -> integration_credentials(id)
--     ON DELETE CASCADE -- OAuth/native attachments (Gmail today).
--   * XOR CHECK constraint requires exactly one of the two to be set on
--     every row, always -- never both, never neither.
--
-- Verified read-only immediately before writing this migration (production,
-- via the Supabase REST API with the service-role key, no mutation): all 10
-- existing workflow_integrations rows have a non-null integration_id, and
-- every one of those 3 distinct integration_id values exists in
-- user_integrations. Making integration_id nullable is therefore a no-op
-- for every current row -- none will violate the new XOR CHECK (each keeps
-- integration_id set and credential_id NULL), and none needs backfilling
-- into credential_id, since no gmail (or any other OAuth-bridged) row has
-- ever been successfully attached in production.
--
-- Nothing else on this table changes: provider CHECK, RLS policies, grants,
-- workflow_id/user_id FKs, and the (workflow_id, provider) unique
-- constraint are all untouched.

ALTER TABLE "public"."workflow_integrations"
  ALTER COLUMN "integration_id" DROP NOT NULL;

ALTER TABLE "public"."workflow_integrations"
  ADD COLUMN "credential_id" "uuid";

ALTER TABLE "public"."workflow_integrations"
  ADD CONSTRAINT "workflow_integrations_credential_id_fkey"
  FOREIGN KEY ("credential_id") REFERENCES "public"."integration_credentials"("id") ON DELETE CASCADE;

CREATE INDEX "idx_workflow_integrations_credential" ON "public"."workflow_integrations" USING "btree" ("credential_id");

ALTER TABLE "public"."workflow_integrations"
  ADD CONSTRAINT "workflow_integrations_identity_xor_check"
  CHECK (
    (("integration_id" IS NOT NULL) AND ("credential_id" IS NULL))
    OR
    (("integration_id" IS NULL) AND ("credential_id" IS NOT NULL))
  );
