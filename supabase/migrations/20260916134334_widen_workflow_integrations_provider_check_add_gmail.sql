-- Phase 9.9.8D -- widen workflow_integrations.provider's CHECK constraint to
-- allow 'gmail', so a genuine Gmail OAuth credential (Phase 9.9.8C's
-- discovery/attach fix) can actually be persisted as a workflow attachment,
-- never aliased to legacy 'email'/SMTP.
--
-- Verified via a read-only `supabase db dump --linked --schema public`
-- immediately before writing this migration; the live constraint was
-- exactly:
--   CHECK (("provider" = ANY (ARRAY['email'::"text", 'shopify'::"text",
--     'slack'::"text", 'airtable'::"text", 'twilio'::"text",
--     'webhook'::"text"])))
-- Cross-checked against every distinct provider value actually stored in
-- workflow_integrations in production (airtable, slack, email -- a strict
-- subset of the above). This migration ADDS exactly one value ('gmail') and
-- changes nothing else: every previously-allowed value is preserved
-- verbatim, and no other constraint, index, FK, RLS policy, or grant on
-- this table is touched.
ALTER TABLE "public"."workflow_integrations"
  DROP CONSTRAINT "workflow_integrations_provider_check";

ALTER TABLE "public"."workflow_integrations"
  ADD CONSTRAINT "workflow_integrations_provider_check"
  CHECK (
    ("provider" = ANY (ARRAY[
      'email'::"text",
      'shopify'::"text",
      'slack'::"text",
      'airtable'::"text",
      'twilio'::"text",
      'webhook'::"text",
      'gmail'::"text"
    ]))
  );
