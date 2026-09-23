-- Phase 9.9.22 -- Native Connector Framework + WooCommerce Direct Connector.
-- Phase 9.9.22A -- reviewed, hardened, and applied to production.
--
-- ── Why a new table, not an existing one (audited before writing this) ──
--
-- integration_credentials (per user, per provider, per credential_key,
-- AES-256-GCM encrypted, unique on (user_id, provider, credential_key))
-- already correctly represents "the keys MagicFlux needs to call OUT to
-- WooCommerce's REST API" -- store_url, consumer_key, consumer_secret.
-- Those are added to THAT existing table via lib/credentials/
-- provider-registry.ts's 'woocommerce' entry; this migration does not
-- touch integration_credentials at all, and stores no plaintext secret of
-- its own (webhook_secret_encrypted is AES-256-GCM, same envelope format
-- as every other encrypted value in this codebase).
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
-- platform_connections is therefore the smallest new table that
-- correctly represents "this workflow has an inbound connection to this
-- external platform, with this provider-side subscription, verified with
-- this generated secret" -- built to be REUSED by future Shopify/Framer/
-- Webflow/Wix connectors via the same `platform` discriminator column
-- (CHECK constraint widened per connector, same pattern already
-- established for workflow_integrations.provider), never a
-- WooCommerce-only table.
--
-- ── Phase 9.9.22A review findings, fixed before this was ever applied ──
--
-- 1. No FK linked a connection to the integration_credentials rows it
--    actually depends on -- disconnecting WooCommerce credentials via the
--    existing Settings > Integrations flow (deleteProviderCredentials())
--    would silently orphan the connection row instead of cleanly removing
--    it. Fixed: `credential_id` FK -> integration_credentials(id) ON
--    DELETE CASCADE, populated at connect time with the connection's
--    consumer_secret row (the representative credential row for this
--    provider+user; all of a provider's key rows are always deleted
--    together by deleteProviderCredentials(), so any one row is an
--    equally valid CASCADE anchor).
-- 2. Nothing at the DB level prevented a buggy (or malicious, if ever
--    reachable other than via service_role) write from binding a
--    connection's user_id to a DIFFERENT tenant's workflow_id or
--    credential_id -- RLS structurally blocks this from an
--    authenticated-role client (no INSERT/UPDATE policy exists at all;
--    see below), but that provides no defense against an application-code
--    bug in a service-role-executed query. Fixed: a BEFORE INSERT/UPDATE
--    trigger (platform_connections_enforce_owner()) verifies the row's
--    user_id actually owns both the referenced workflow and (when set)
--    the referenced credential, raising an exception otherwise. Runs as
--    the invoking role (service_role, which already has full read access
--    to both referenced tables) -- deliberately NOT SECURITY DEFINER,
--    since no privilege escalation is needed and least-privilege says not
--    to add one. search_path is pinned explicitly regardless, as
--    defense-in-depth against search-path-hijacking.
-- 3. workflow_id's ON DELETE CASCADE was reconsidered against ON DELETE
--    RESTRICT (forcing an explicit disconnect, which cleanly unsubscribes
--    the WooCommerce-side webhook, before a workflow could be deleted).
--    RESTRICT was rejected: workflows.user_id already CASCADEs to
--    auth.users (confirmed live via pg_constraint before writing this),
--    so deleting a user cascades through their workflows -- a RESTRICT
--    here would make user deletion fail with a foreign-key violation
--    whenever any workflow still had a connection, an inconsistent and
--    surprising failure mode. CASCADE is kept, matching the SAME
--    established, pre-existing risk this codebase already accepts for
--    every other workflow-scoped child table (workflow_integrations,
--    deployment_versions, etc. -- confirmed live: DELETE /api/workflows/
--    [id] performs a single raw table delete and relies entirely on FK
--    CASCADE for every child row, with no external-resource cleanup for
--    ANY provider, not just WooCommerce). The real gap this surfaces --
--    an external WooCommerce webhook subscription can be orphaned if a
--    workflow is deleted without an explicit prior disconnect -- is a
--    pre-existing class of limitation across this codebase (Gmail/Slack/
--    Airtable tokens are never revoked externally on workflow/account
--    deletion either), not a new one introduced here, and fixing it
--    holistically is out of this migration-review phase's scope.
-- 4. "Same store connected to multiple DIFFERENT workflows" was reviewed
--    and is INTENTIONALLY allowed (e.g. one store's order.created feeding
--    workflow A while customer.created feeds workflow B) -- no uniqueness
--    constraint on store_url. "Same store connected TWICE to the SAME
--    workflow" remains prevented by the existing UNIQUE(workflow_id,
--    platform) constraint (one row per workflow+platform, unchanged from
--    the original draft).

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

    -- Phase 9.9.22A -- links this connection to the integration_credentials
    -- row set it depends on, so disconnecting those credentials (the
    -- existing Settings > Integrations flow) cleanly cascades this
    -- connection away instead of silently orphaning it. Nullable only so
    -- a future connector platform that has no credential concept at all
    -- (unlikely, but never assume) isn't forced to fabricate one.
    "credential_id" "uuid",

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

ALTER TABLE ONLY "public"."platform_connections"
    ADD CONSTRAINT "platform_connections_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "public"."integration_credentials"("id") ON DELETE CASCADE;

CREATE INDEX "idx_platform_connections_user" ON "public"."platform_connections" USING "btree" ("user_id");
CREATE INDEX "idx_platform_connections_workflow" ON "public"."platform_connections" USING "btree" ("workflow_id");
CREATE INDEX "idx_platform_connections_credential" ON "public"."platform_connections" USING "btree" ("credential_id");
CREATE INDEX "idx_platform_connections_status" ON "public"."platform_connections" USING "btree" ("status");

-- Phase 9.9.22A -- Part 3 hardening: DB-level defense against a
-- cross-tenant bind, independent of and in addition to RLS/application
-- checks. Deliberately NOT SECURITY DEFINER (see header note above) --
-- runs as whichever role executes the INSERT/UPDATE (always service_role
-- in practice, per the RLS policy below), which already has full read
-- access to both referenced tables, so no privilege escalation is needed
-- or added.
CREATE OR REPLACE FUNCTION "public"."platform_connections_enforce_owner"()
RETURNS "trigger"
LANGUAGE "plpgsql"
SET "search_path" TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."workflows"
    WHERE "id" = NEW."workflow_id" AND "user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'platform_connections.user_id (%) does not own workflow_id (%)', NEW."user_id", NEW."workflow_id";
  END IF;

  IF NEW."credential_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "public"."integration_credentials"
    WHERE "id" = NEW."credential_id" AND "user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'platform_connections.user_id (%) does not own credential_id (%)', NEW."user_id", NEW."credential_id";
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."platform_connections_enforce_owner"() OWNER TO "postgres";
-- Phase 9.9.22A -- REVOKE ALL FROM PUBLIC alone was verified (live) to be
-- insufficient: this project's schema-level default privileges grant
-- EXECUTE on new functions directly to anon/authenticated (not via the
-- PUBLIC pseudo-role), so both are revoked from explicitly, by name, too.
-- Confirmed empirically harmless even before this explicit revoke --
-- Postgres refuses to invoke a RETURNS trigger function outside an actual
-- trigger context ("trigger functions can only be called as triggers")
-- regardless of EXECUTE grants -- but explicit is safer than relying on
-- that structural accident if this function is ever refactored.
REVOKE ALL ON FUNCTION "public"."platform_connections_enforce_owner"() FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."platform_connections_enforce_owner"() TO "service_role";

CREATE TRIGGER "platform_connections_enforce_owner_trigger"
    BEFORE INSERT OR UPDATE OF "user_id", "workflow_id", "credential_id" ON "public"."platform_connections"
    FOR EACH ROW EXECUTE FUNCTION "public"."platform_connections_enforce_owner"();

ALTER TABLE "public"."platform_connections" ENABLE ROW LEVEL SECURITY;

-- Same posture as workflow_acknowledgments/workflow_side_effects (Phase
-- 9.9.11A/9.9.12 precedent): authenticated users get SELECT ONLY, for
-- read-only dashboard visibility into their own connections. Every write
-- (connect, disconnect, subscription create/replace, inbound-event
-- bookkeeping) goes through the service role exclusively -- SSRF
-- validation, provider-API calls, and signature verification are all
-- server-side-only operations that must never be reachable via the
-- user's own session/anon key. No INSERT/UPDATE/DELETE policy exists for
-- authenticated at all -- RLS structurally denies those regardless of any
-- broader table-level grant this project's own default-privileges may
-- still apply. anon has no GRANT at all (denied by absence, not merely by
-- policy). Verified live post-apply (Phase 9.9.22A Part 10).
CREATE POLICY "Users can view own platform connections" ON "public"."platform_connections" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));

GRANT SELECT ON TABLE "public"."platform_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_connections" TO "service_role";
