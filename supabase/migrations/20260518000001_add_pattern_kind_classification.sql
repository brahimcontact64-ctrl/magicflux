-- ============================================================================
-- Add kind + classification to automation_patterns and skill_packs.
--
-- PatternKind (three tiers)
-- ─────────────────────────
--   'provider_specific' — provider identity IS the workflow's meaning.
--                         Swapping the provider changes what the workflow does.
--                         Examples: "Telegram Reply Agent",
--                                   "Shopify Order Sync",
--                                   "Gmail Inbox Processor"
--
--   'domain_template'   — domain is strongly detected; provider is still
--                         enrichable.  The workflow shape makes sense for any
--                         provider that serves the domain.
--                         Examples: "Order Checkout Handler" (ecommerce domain,
--                                   could be Shopify / WooCommerce / Magento),
--                                   "Email Inbox Processor" (email domain,
--                                   could be Gmail / Outlook / SMTP)
--
--   'abstract_template' — fully generic workflow shape.  No domain or provider
--                         detected; providers are discovered from the prompt.
--                         Examples: "Summarize content",
--                                   "Notify user on event",
--                                   "Route message to handler"
--
-- PatternClassification (structured graph — not a flat enum)
-- ──────────────────────────────────────────────────────────
--   {
--     "kind":       PatternKind,
--     "providers":  string[],   -- provider names detected in the workflow name
--     "domains":    string[],   -- domains inferred from entity nouns + implied
--                               -- provider→domain mapping
--     "confidence": integer     -- 30–95
--   }
--
--   Example: "Telegram Ecommerce Order Agent"
--     → { "kind":"provider_specific", "providers":["telegram"],
--          "domains":["ecommerce","messaging"], "confidence":92 }
--
-- Default for new rows: kind = 'abstract_template',
--   classification = '{"kind":"abstract_template","providers":[],"domains":[],"confidence":30}'
--
-- Classification rule
-- ───────────────────
--   Two independent scores are computed:
--
--   provider_score — presence of an explicit provider name
--     +50  provider name at word boundary in workflow NAME
--     +15  provider name in DESCRIPTION (supplementary)
--
--   domain_score  — presence of domain-specific entity / role nouns
--     +15 each  domain entity noun in NAME        (cap: 3 signals = 45)
--     +10       trigger-role noun in NAME          (first match)
--     +10       action-role  noun in NAME          (first match)
--     +5  each  domain entity noun in DESCRIPTION (cap: 2 signals = 10)
--
--   Thresholds:
--     provider_score >= 40  →  'provider_specific'
--     domain_score   >= 15  →  'domain_template'
--     otherwise             →  'abstract_template'  (default kept)
--
--   Domain entities are intentionally NOT counted toward provider_score.
-- ============================================================================

ALTER TABLE automation_patterns
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'abstract_template'
  CONSTRAINT automation_patterns_kind_check
    CHECK (kind IN ('provider_specific', 'domain_template', 'abstract_template'));

ALTER TABLE automation_patterns
  ADD COLUMN IF NOT EXISTS classification jsonb NOT NULL
  DEFAULT '{"kind":"abstract_template","providers":[],"domains":[],"confidence":30,"origin":"db","identityLocked":false,"lockReason":null,"lockEvidence":[]}'::jsonb;

ALTER TABLE skill_packs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'abstract_template'
  CONSTRAINT skill_packs_kind_check
    CHECK (kind IN ('provider_specific', 'domain_template', 'abstract_template'));

ALTER TABLE skill_packs
  ADD COLUMN IF NOT EXISTS classification jsonb NOT NULL
  DEFAULT '{"kind":"abstract_template","providers":[],"domains":[],"confidence":30,"origin":"db","identityLocked":false,"lockReason":null,"lockEvidence":[]}'::jsonb;

-- ============================================================================
-- build_pattern_classification(name, description) → jsonb
-- Returns { kind, providers[], domains[], confidence }
-- ============================================================================

CREATE OR REPLACE FUNCTION build_pattern_classification(
  p_name        text,
  p_description text
) RETURNS jsonb AS $$
DECLARE
  provider_score     integer := 0;
  domain_score       integer := 0;
  entity_count       bigint;
  kind_result        text;
  confidence_val     integer;
  detected_providers text[];
  detected_domains   text[];
  evidence_arr       jsonb;

  -- Explicit provider / integration brand names.
  provider_re text :=
    '\m(telegram|whatsapp|shopify|gmail|slack|stripe|hubspot|salesforce|'
    || 'facebook|twitter|instagram|linkedin|reddit|youtube|notion|airtable|'
    || 'coinmarketcap|zendesk|intercom|twilio|deepgram|elevenlabs|supabase|'
    || 'canva|cloudflare|discord|mailchimp|sendgrid|paypal|jira|confluence|'
    || 'dropbox|figma|zoom|calendly|typeform|webflow|squarespace|woocommerce'
    || ')\M';

  -- Domain entity nouns with their parallel domain labels.
  entity_names  text[] := ARRAY[
    -- e-commerce (10)
    'checkout','cart','invoice','inventory','fulfillment','shipment',
    'storefront','catalog','refund','order',
    -- email / inbox (5)
    'email','inbox','mailbox','newsletter','attachment',
    -- messaging (3)
    'conversation','chatroom','dm',
    -- CRM / sales (4)
    'lead','deal','pipeline','prospect',
    -- voice (2)
    'transcript','voicemail',
    -- finance (4)
    'payment','transaction','subscription','billing',
    -- documents (2)
    'contract','receipt'
  ];
  entity_domains text[] := ARRAY[
    'ecommerce','ecommerce','ecommerce','ecommerce','ecommerce','ecommerce',
    'ecommerce','ecommerce','ecommerce','ecommerce',
    'email','email','email','email','email',
    'messaging','messaging','messaging',
    'crm','crm','crm','crm',
    'voice','voice',
    'finance','finance','finance','finance',
    'documents','documents'
  ];

  -- Provider→domain implied mapping (presence of provider implies its domain).
  provider_domain_keys text[] := ARRAY[
    'telegram','whatsapp','discord','slack',
    'gmail',
    'shopify','woocommerce',
    'stripe','paypal','coinmarketcap',
    'hubspot','salesforce'
  ];
  provider_domain_vals text[] := ARRAY[
    'messaging','messaging','messaging','messaging',
    'email',
    'ecommerce','ecommerce',
    'finance','finance','finance',
    'crm','crm'
  ];

  trigger_re text := '\m(webhook|trigger|listener|watcher|ingestor)\M';
  action_re  text :=
    '\m(processor|handler|responder|router|dispatcher|syncer|sender|notifier)\M';

BEGIN
  -- ── provider_score ────────────────────────────────────────────────────────

  IF p_name ~* provider_re THEN
    provider_score := provider_score + 50;
  END IF;
  IF p_description ~* provider_re THEN
    provider_score := provider_score + 15;
  END IF;

  -- ── domain_score ─────────────────────────────────────────────────────────

  -- +15 each (cap 3): domain entity nouns in NAME
  SELECT COUNT(DISTINCT entity)
  INTO entity_count
  FROM unnest(entity_names) AS entity
  WHERE lower(p_name) ~ ('\m' || entity || '\M');

  domain_score := domain_score + LEAST(entity_count, 3)::integer * 15;

  -- +10: trigger-role noun in NAME (first match counts)
  IF lower(p_name) ~ trigger_re THEN
    domain_score := domain_score + 10;
  END IF;

  -- +10: action-role noun in NAME (first match counts)
  IF lower(p_name) ~ action_re THEN
    domain_score := domain_score + 10;
  END IF;

  -- +5 each (cap 2): domain entity nouns in DESCRIPTION
  SELECT COUNT(DISTINCT entity)
  INTO entity_count
  FROM unnest(entity_names) AS entity
  WHERE lower(p_description) ~ ('\m' || entity || '\M');

  domain_score := domain_score + LEAST(entity_count, 2)::integer * 5;

  -- ── classify ─────────────────────────────────────────────────────────────

  IF provider_score >= 40 THEN
    kind_result := 'provider_specific';
  ELSIF domain_score >= 15 THEN
    kind_result := 'domain_template';
  ELSE
    kind_result := 'abstract_template';
  END IF;

  -- ── detected_providers ───────────────────────────────────────────────────
  -- Extract all distinct provider names that appear at word boundaries in NAME.

  SELECT COALESCE(array_agg(DISTINCT m[1]), ARRAY[]::text[])
  INTO detected_providers
  FROM regexp_matches(lower(COALESCE(p_name, '')), provider_re, 'g') AS m;

  -- ── detected_domains ─────────────────────────────────────────────────────
  -- Union of: domain entity noun → domain label (from NAME)
  --           detected provider  → implied domain label

  SELECT COALESCE(array_agg(DISTINCT sub.ed), ARRAY[]::text[])
  INTO detected_domains
  FROM (
    SELECT ed
    FROM unnest(entity_names, entity_domains) AS t(en, ed)
    WHERE lower(p_name) ~ ('\m' || en || '\M')
    UNION
    SELECT pd
    FROM unnest(provider_domain_keys, provider_domain_vals) AS t(pk, pd)
    WHERE lower(p_name) ~ ('\m' || pk || '\M')
  ) sub(ed);

  -- ── lock evidence ────────────────────────────────────────────────────────
  -- One evidence item per matched provider: signal=name, method=word_boundary_match.

  IF kind_result = 'provider_specific' THEN
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'signal',     p,
          'source',     'name',
          'method',     'word_boundary_match',
          'confidence', 95
        )
      ),
      '[]'::jsonb
    )
    INTO evidence_arr
    FROM unnest(COALESCE(detected_providers, ARRAY[]::text[])) AS p;
  ELSE
    evidence_arr := '[]'::jsonb;
  END IF;

  -- ── confidence ───────────────────────────────────────────────────────────

  IF kind_result = 'provider_specific' THEN
    confidence_val := LEAST(95,
      72
      + COALESCE(array_length(detected_providers, 1), 0) * 8
      + COALESCE(array_length(detected_domains,   1), 0) * 5
    );
  ELSIF kind_result = 'domain_template' THEN
    confidence_val := LEAST(80, 45 + domain_score / 2);
  ELSE
    confidence_val := 30;
  END IF;

  RETURN jsonb_build_object(
    'kind',           kind_result,
    'providers',      to_jsonb(COALESCE(detected_providers, ARRAY[]::text[])),
    'domains',        to_jsonb(COALESCE(detected_domains,   ARRAY[]::text[])),
    'confidence',     confidence_val,
    'origin',         'db',
    'identityLocked', kind_result = 'provider_specific',
    'lockReason',   CASE WHEN kind_result = 'provider_specific'
                      THEN 'provider_name_match'
                      ELSE NULL
                    END,
    'lockEvidence', evidence_arr
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ── Apply classification ──────────────────────────────────────────────────

WITH bc AS (
  SELECT id, build_pattern_classification(name, description) AS c
  FROM automation_patterns
)
UPDATE automation_patterns ap
  SET
    classification = bc.c,
    kind           = bc.c ->> 'kind'
  FROM bc
  WHERE ap.id = bc.id;

WITH bc AS (
  SELECT id, build_pattern_classification(name, description) AS c
  FROM skill_packs
)
UPDATE skill_packs sp
  SET
    classification = bc.c,
    kind           = bc.c ->> 'kind'
  FROM bc
  WHERE sp.id = bc.id;

-- Drop the helper — it is only needed during this migration.
DROP FUNCTION IF EXISTS build_pattern_classification(text, text);

CREATE INDEX IF NOT EXISTS automation_patterns_kind_idx ON automation_patterns (kind);
CREATE INDEX IF NOT EXISTS skill_packs_kind_idx          ON skill_packs (kind);
