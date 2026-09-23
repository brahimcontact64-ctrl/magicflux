-- Phase 9.9.22 -- Native Connector Framework + WooCommerce Direct Connector.
--
-- NOT YET APPLIED TO PRODUCTION -- drafted for review/approval only, per
-- the standing "stop before any schema migration" rule (see the Phase
-- 9.9.12 workflow_acknowledgments migration for the established
-- precedent this mirrors). lib/connectors/** and the
-- app/api/connectors/** routes that read/write this table are NOT wired
-- into any live UI navigation until this migration is explicitly approved
-- and applied -- no production code path a real user can reach depends on
-- a table that does not exist yet.
--
-- ── Why a new table, not an existing one (audited before writing this) ──
--
-- integration_credentials (per user, per provider, per credential_key,
-- AES-256-GCM encrypted, unique on (user_id, provider, credential_key))
-- already correctly represents "the keys MagicFlux needs to call OUT to
-- WooCommerce's REST API" -- store_url, consumer_key, consumer_secret.
-- Those are added to THAT existing table via lib/credentials/
-- provider-registry.ts's new 'woocommerce' entry; this migration does not
-- touch integration_credentials at all.
--
-- workflow_integrations (workflow_id, provider, credential_id XOR
-- integration_id, unique on (workflow_id, provider)) represents "does
-- this workflow's OUTBOUND action node have the credential it needs" --
-- Gmail send, Slack post, Airtable write. WooCommerce here is the
-- opposite direction: an INBOUND trigger source, with its own lifecycle
-- (a provider-side webhook SUBSCRIPTION that must be created, can be
-- revoked externally, and needs its own generated verification secret --
-- none of which workflow_integrations' shape has any column for, and
-- none of which is a "credential a node reads to call out"). Reusing it
-- here would be exactly the kind of conceptual overload this phase's own
-- instructions warned against for workflow_json.security.
--
-- workflow_json.security already holds the GENERIC webhook's own secret
-- and (Phase 9.9.21) ephemeral test-mode state -- deliberately NOT
-- reused here either, both because a platform connector's state
-- (provider subscription ids, connection status, last-verified-at) is
-- durable and queryable, not the small ephemeral scalar the JSONB
-- convention was designed for, and because overloading it was explicitly
-- disallowed for this phase.
--
-- platform_connections is therefore the smallest new table that
-- correctly represents "this workflow has an inbound connection to this
-- external platform, with this provider-side subscription, verified with
-- this generated secret" -- built to be REUSED by future Shopify/Framer/
-- Webflow/Wix connectors via the same `platform` discriminator column
-- (CHECK constraint widened per connector, same pattern already
-- established for workflow_integrations.provider), never a WooCommerce-
-- only table.

CREATE TABLE IF NOT EXISTS "public"."platform_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "workflow_id" "uuid" NOT NULL,

    -- Widen this CHECK, never rename/repurpose the column, when a future
    -- connector (Shopify, Framer, ...) is added -- mirrors the exact
    -- widening pattern already used for workflow_integrations.provider.
    "platform" "text" NOT NULL,

    "status" "text" DEFAULT 'connecting'::"text" NOT NULL,

    -- Not secret -- needed for display and for re-calling the provider's
    -- API (re-verify, recreate a revoked subscription). The actual
    -- Consumer Key/Secret used to AUTHENTICATE to that API live in
    -- integration_credentials (provider='woocommerce'), never here.
    "store_url" "text" NOT NULL,

    -- MagicFlux-GENERATED secret, given to WooCommerce at subscription-
    -- creation time, used ONLY to verify X-WC-Webhook-Signature on
    -- inbound deliveries. AES-256-GCM via the same envelope format as
    -- every other encrypted value in this codebase
    -- (lib/security/encryption.ts's encryptSecretValue/decryptSecretValue)
    -- -- never plaintext at rest, never returned to the browser after the
    -- initial connect response.
    "webhook_secret_encrypted" "text" NOT NULL,

    -- One row per (workflow, platform); one WooCommerce STORE can only
    -- create one webhook object PER TOPIC, so this maps each subscribed
    -- topic to that topic's provider-side webhook id, letting several
    -- provider-side webhook objects share one MagicFlux connection row
    -- (and one generated secret) instead of needing one row per topic.
    "provider_subscriptions" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "topics" "text"[] DEFAULT '{}'::"text"[] NOT NULL,

    "last_verified_at" timestamp with time zone,
    "last_event_at" timestamp with time zone,
    "last_error" "text",
    "error_category" "text",

    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "platform_connections_platform_check" CHECK (
        ("platform" = ANY (ARRAY['woocommerce'::"text"]))
    ),
    CONSTRAINT "platform_connections_status_check" CHECK (
        ("status" = ANY (ARRAY['connecting'::"text", 'connected'::"text", 'needs_attention'::"text", 'disconnected'::"text"]))
    )
);

ALTER TABLE "public"."platform_connections" OWNER TO "postgres";

ALTER TABLE ONLY "public"."platform_connections"
    ADD CONSTRAINT "platform_connections_pkey" PRIMARY KEY ("id");

-- One connection per (workflow, platform) for V1 -- matches the same
-- one-credential-set-per-provider simplification every existing provider
-- (Gmail, Slack, Airtable) already makes via integration_credentials'
-- own (user_id, provider) shape; a genuine multi-store-per-workflow
-- requirement is a deliberate, explicit future migration, not smuggled
-- in here.
ALTER TABLE ONLY "public"."platform_connections"
    ADD CONSTRAINT "platform_connections_workflow_platform_key" UNIQUE ("workflow_id", "platform");

ALTER TABLE ONLY "public"."platform_connections"
    ADD CONSTRAINT "platform_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."platform_connections"
    ADD CONSTRAINT "platform_connections_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE;

CREATE INDEX "idx_platform_connections_user" ON "public"."platform_connections" USING "btree" ("user_id");
CREATE INDEX "idx_platform_connections_workflow" ON "public"."platform_connections" USING "btree" ("workflow_id");
CREATE INDEX "idx_platform_connections_status" ON "public"."platform_connections" USING "btree" ("status");

ALTER TABLE "public"."platform_connections" ENABLE ROW LEVEL SECURITY;

-- Same posture as workflow_acknowledgments/workflow_side_effects (Phase
-- 9.9.11A/9.9.12 precedent): authenticated users get SELECT ONLY, for
-- read-only dashboard visibility into their own connections. Every write
-- (connect, disconnect, subscription create/replace, inbound-event
-- bookkeeping) goes through the service role exclusively -- SSRF
-- validation, provider-API calls, and signature verification are all
-- server-side-only operations that must never be reachable via the
-- user's own session/anon key.
CREATE POLICY "Users can view own platform connections" ON "public"."platform_connections" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));

GRANT SELECT ON TABLE "public"."platform_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_connections" TO "service_role";
