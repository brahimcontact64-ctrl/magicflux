/*
  # Workflow #2 Phase D.3 -- runtime_outbound_messages.internet_message_id

  LIVE-CERTIFICATION FINDING (Phase D.2): a real reply's RFC 5322
  In-Reply-To/References headers carry the sender's own RFC Message-ID
  (e.g. "<abc123@mail.gmail.com>"), a completely different identifier
  namespace from a provider's own API-native message id (Gmail's
  provider_message_id, e.g. "1a0ddf2d0cf1885e"). The existing In-Reply-To/
  References correlation fallbacks compared a reply's RFC identifiers
  against provider_message_id and could therefore never match a genuine
  Gmail-sent outbound message -- only provider_thread_id correlation
  actually worked. This column lets a future send record the OUTBOUND
  message's own real, provider-confirmed RFC Message-ID (never a locally
  generated/assumed value -- see lib/runtime/inbound-reply/gmail-send-adapter.ts's
  own header comment for why), so those two fallbacks can finally compare
  like with like.

  ADDITIVE, BACKWARDS-COMPATIBLE BY CONSTRUCTION:
    - Nullable. Every pre-D.3 outbound row keeps internet_message_id = NULL
      forever -- no backfill, no historical Gmail refetch (explicitly out of
      scope; NULL simply means "RFC-header fallback unavailable for this old
      row," and such a row continues to correlate via provider_thread_id
      exactly as before).
    - No existing row is rewritten; no existing column, constraint, policy,
      or grant is touched.

  INDEX, NOT UNIQUE: RFC 5322 Message-IDs are conventionally
  globally-unique-by-construction (a client-chosen random/timestamp
  component plus the sending domain), but that is a social convention the
  standard encourages, never one Postgres can safely assume as an
  application-level invariant -- a hypothetical provider-side anomaly
  producing a duplicate must never turn into a hard INSERT failure that
  blocks a real send. A plain (non-unique) btree index on
  (provider, internet_message_id) is sufficient for the correlation
  lookup's access pattern (findOutboundMessageByInternetMessageId in
  storage.ts, itself further scoped by user_id at query time for tenant
  isolation, matching findOutboundMessageByProviderMessageId's existing
  convention exactly).

  RLS / GRANTS: unchanged. runtime_outbound_messages already has RLS
  enabled with no policy for authenticated (service-role-only writes/reads,
  per the Phase A migration's own documented posture) -- adding a nullable
  column changes neither. No new GRANT is required: GRANT is table-wide in
  Postgres, and service_role already has the necessary privileges on this
  table (see 20260924000001's own grants, unaffected by this migration).

  ROLLBACK: DROP INDEX IF EXISTS "public"."idx_runtime_outbound_messages_internet_message_id";
  ALTER TABLE "public"."runtime_outbound_messages" DROP COLUMN IF EXISTS "internet_message_id";
  -- Safe at any time: no other object depends on this column.

  SAFE FOR PRODUCTION BY CONSTRUCTION -- but deliberately NOT applied there
  in this phase: local-only per Workflow #2 Phase D's standing safety rules.
*/

ALTER TABLE "public"."runtime_outbound_messages"
  ADD COLUMN IF NOT EXISTS "internet_message_id" "text";

CREATE INDEX IF NOT EXISTS "idx_runtime_outbound_messages_internet_message_id"
  ON "public"."runtime_outbound_messages" USING "btree" ("provider", "internet_message_id");
