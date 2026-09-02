/*
  Phase 9.3.2 — Stripe subscription billing schema.

  PROPOSED ONLY. This file is committed for review; it has not been run
  against production. Nothing here alters existing subscriptions rows or
  performs any data migration/cleanup — it is additive only (new nullable
  columns, one new table, indexes).

  Purpose: give lib/billing/apply-stripe-subscription.ts and
  app/api/billing/webhook/route.ts (Phase 9.3.2) somewhere durable to
  record Stripe provider identifiers and webhook-event idempotency,
  instead of hiding them in arbitrary JSON/profile fields.

  ── stripe_customer_id: intentionally NOT unique ──────────────────────────
  A prior draft of this migration proposed a unique index on
  stripe_customer_id. Per explicit review instruction, uniqueness must be
  provable from the existing subscription model, not assumed. It is not
  provable:
    - The only code path that writes stripe_customer_id
      (app/api/billing/checkout/route.ts) reuses an existing customer per
      user_id when one is on file, and otherwise lets Stripe create a new
      Customer keyed off customer_email — Stripe does NOT dedupe Customers
      by email in this flow, so under normal operation one user_id maps to
      at most one live stripe_customer_id, but nothing in the schema or
      Stripe's own model prevents a support/admin action, a future
      team-billing feature, or a manual Stripe Dashboard edit from
      legitimately pointing two different user_id rows at the same
      Customer (e.g. a team plan billed centrally). That is a real,
      plausible future shape, not a defect to constrain away today.
    - subscriptions has no historical stripe_customer_id data at all yet
      (the column doesn't exist before this migration), so there is no
      empirical evidence either way from production data.
  A non-unique, partial index is the correct, provable choice: it makes
  "find the subscription row(s) for this Stripe customer" fast (the
  webhook path this actually serves) without asserting an invariant this
  codebase cannot currently prove and might one day legitimately violate.

  ── stripe_subscription_id: unique ─────────────────────────────────────────
  A Stripe Subscription object, by Stripe's own model, belongs to exactly
  one Customer and is never shared. subscriptions is already a one-row-
  per-user table (upsert onConflict:'user_id' throughout upgradePlan()/
  ensureActiveSubscription()/apply-stripe-subscription.ts), so two
  different user_id rows ever legitimately sharing one
  stripe_subscription_id would itself be a data-integrity bug, not a
  supportable shape — the unique index is a correctness guard, not a
  business-rule guess.

  ── stripe_webhook_events: naming note ─────────────────────────────────────
  The app/api/billing/webhook/route.ts design inserts a row BEFORE
  processing an event (a claim/lock), then deletes it if processing
  throws (so Stripe's retry can reclaim it). A column literally named
  processed_at would be misleading — the row exists for the whole
  in-flight window, not only after successful processing. Renamed to
  created_at (when the claim was taken), which is what every caller
  actually needs for observability (age of the claim, stuck/never-deleted
  rows worth investigating) without adding a status column: this design
  has exactly two states — "row present" (claimed, and by the time a
  reader sees it via a 200 response, successfully processed) and "row
  absent" (never attempted, or attempted and failed-then-released) — a
  status enum would describe states this table is not designed to hold.
*/

-- ── subscriptions: Stripe provider columns ──────────────────────────────

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS stripe_price_id text,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_synced_at timestamptz;

-- One Stripe Subscription never legitimately belongs to more than one
-- subscriptions row (see note above) — enforced, not just indexed.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_subscription_id_key
  ON subscriptions (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- Non-unique: supports "look up this user's row by their Stripe customer"
-- without asserting an unproven one-customer-one-row invariant.
CREATE INDEX IF NOT EXISTS subscriptions_stripe_customer_id_idx
  ON subscriptions (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ── stripe_webhook_events: durable webhook idempotency ──────────────────

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- Deliberately no policies: RLS enabled with zero grants to anon/
-- authenticated means only the service-role key (which bypasses RLS
-- entirely, per Supabase's own model) can read or write this table —
-- exactly matching every other server-only bookkeeping table in this
-- schema, and this table is never read from client code anywhere.
