/*
  # Durable AI Qualification Feedback / Analytics -- workflow_qualification_decisions (Phase 9.9.13)

  PROPOSED MIGRATION -- NOT YET APPLIED. Presented for approval per the
  standing migration-safety instruction; STOP before applying.

  ============================================================================
  WHAT THIS BACKS
  ============================================================================

  Answers, durably and tenant-scoped, exactly the questions Phase 9.9.13
  asks for -- nothing more:
    What did AI decide?               -> ai_classification
    How confident was it?             -> ai_confidence
    Why?                              -> ai_reason (short business reason,
                                          never chain-of-thought/prompt)
    Did a human override it?          -> overridden (generated column)
    What became the final answer?     -> final_classification
    How often does AI agree w/ humans?-> computed from human_review_occurred
                                          + overridden, at query time (Part F:
                                          this is "AI/Human Agreement", never
                                          labeled "AI Accuracy" anywhere)

  ============================================================================
  WHY A NEW TABLE (Part A finding)
  ============================================================================

  Read-only investigation before designing this found the classifier's full
  output (classification/confidence/ai_confidence/reason/positive_signals/
  negative_signals/contradictions/missing_required_fields/qualification_status)
  already survives, today, ONLY as an unstructured jsonb blob buried inside
  workflow_execution_steps.output_data (one append-only row per node per
  attempt -- see 20260509091500_execution_v2_tables.sql) merged with
  whatever raw upstream data happened to be flowing through the execution at
  that moment. That table has no notion of "the AI's original proposal vs.
  the human's final word" as distinct, queryable columns, is not deduped to
  one row per decision, and was never designed to be scanned for tenant-
  scoped aggregate metrics. workflow_review_items (Phase 9.9.2/9.9.2A) is a
  well-structured table, but for a DIFFERENT purpose -- the review's own
  resume LIFECYCLE (pending/resume_pending/resumed) -- and has no column
  for "what did the AI originally say", "was this an override", or
  aggregate-friendly classification/confidence data. Nothing durable and
  tenant-queryable already answers Phase 9.9.13's questions; this table is
  net-new, not a duplicate of existing persistence.

  ============================================================================
  HOW A ROW IS CREATED / UPDATED (see code for the actual implementation)
  ============================================================================

  1. lib/workflow-runtime/node-handlers/ai-classifier.ts inserts exactly one
     row per real (live-mode, non-test-mode, non-failed) classification,
     keyed by (execution_id, classifier_node_id) -- UNIQUE below makes a
     retried/duplicate node invocation idempotent (insert-then-tolerate-
     duplicate, exact precedent: workflow_review_items' own insert path).
     final_classification is initialized equal to ai_classification.
     The classifier's own new output field `_qualificationDecisionId`
     threads this row's id downstream through ordinary execution data flow
     (same threading pattern Phase 9.9.12A's challengeId used) so a LATER,
     separate Human Review node can find and update the SAME row.

  2. lib/workflow-runtime/node-handlers/human-review.ts, ONLY when its
     resumed input data carries `_qualificationDecisionId` (i.e. this
     specific Human Review node is reviewing THIS specific AI classification
     -- absent for any unrelated Human Review use, e.g. refund approval,
     which never touches this table at all), best-effort UPDATEs that one
     row: human_review_occurred=true, human_classification=<the human's
     decision>, final_classification=<the human's decision>,
     human_reviewed_by/human_reviewed_at copied from the review item's own
     already-recorded decision. Guarded by
     `WHERE human_review_occurred = false` -- a CAS that makes a duplicate
     resume of the same review item a safe no-op, never a double-count or a
     second feedback record (Part L).

  ai_classification is NEVER overwritten after insert (Part C: "never
  overwrite history so it appears AI originally chose Warm" -- the column
  simply has no UPDATE statement anywhere in the codebase that touches it
  after the initial INSERT). `overridden` is a STORED GENERATED column, not
  application-computed, so it can never drift from the two source columns it
  depends on.

  ============================================================================
  PRIVACY (Part H)
  ============================================================================

  Never stored: email, phone, full free-text project descriptions, webhook
  payloads, prompts, chain-of-thought. positive_signals/negative_signals are
  redacted before insert on TWO independent layers, never just one:
  qualification-policy.ts's own parser already drops any field name matching
  isDenylistedFieldName() from a policy's "allowedInputFields" before it can
  even be saved (so a credential-shaped field name should never reach this
  table structurally), AND qualification-decision-store.ts's own
  redactSignals() additionally re-checks each signal's own field name
  (isSensitiveKey()/isDenylistedFieldName()) and blanks its value if it ever
  matches, in case a future bug or a different call path bypasses the first
  layer. missing_required_fields stores
  ONLY field names (text[]), never values. contradictions stores only the
  already-capped (<=300 chars, <=10 entries) short plain-language strings
  ai-classifier.ts itself produces -- never raw model output.

  Phase 9.9.13A Part F -- field-name redaction alone cannot protect FREE
  TEXT a model generated from data that may itself contain PII: if a lead's
  email/phone was part of the evidence handed to the classifier, nothing
  stops the model from echoing it back verbatim into its own "reason" prose
  (there is no object key to redact by). ai_reason and every contradiction
  string are therefore additionally scanned, as raw text, by
  redactPiiPatterns() (lib/security/redact.ts) for email/phone SHAPES before
  insert -- independent of and in addition to every key-based protection
  above. Chain-of-thought/the raw prompt are never stored at all (there is
  no column for either); ai_reason is the model's own required one-sentence
  business justification, explicitly instructed to never mention prompts or
  internal reasoning.

  ============================================================================
  VERSIONING (Part K)
  ============================================================================

  classification_policy_hash is a sha256 hex digest computed at
  classification time over the exact classification-behavior-relevant node
  configuration (instruction, allowedLabels, confidenceThreshold,
  qualificationPolicy) -- NOT the deployment_version_id alone, because a
  redeploy can change unrelated downstream nodes without changing
  qualification rules at all, which would otherwise fragment "same policy"
  history across deployment versions for no real reason. Two decisions with
  the same hash are structurally guaranteed to have been produced by
  byte-identical classification rules; two different hashes prove the rules
  genuinely changed. deployment_version_id is ALSO retained (full lineage,
  matches workflow_review_items' own precedent) as the coarser-grained
  identity.

  ============================================================================
  OUTCOME-READY, NOT OUTCOME-INVENTING (Part G)
  ============================================================================

  outcome_status/outcome_revenue/outcome_recorded_by/outcome_recorded_at
  exist so a FUTURE CRM/business-outcome feature can attach real,
  human-supplied outcomes (contacted/qualified/won/lost/revenue) to a
  decision -- all four columns are nullable and NOTHING in this migration or
  Phase 9.9.13's code ever writes them. This phase does not become a CRM.

  ============================================================================
  RLS / GRANTS -- same pattern as workflow_review_items / workflow_acknowledgments
  ============================================================================

  authenticated: SELECT own rows only (auth.uid() = user_id). No INSERT/
  UPDATE/DELETE policy exists for authenticated at all -- absence of a
  policy for a command is a default DENY once RLS is enabled, not an
  oversight. Explicit REVOKE INSERT/UPDATE/DELETE FROM authenticated and
  REVOKE ALL FROM anon, belt-and-suspenders on top of policy absence (this
  project has been burned once before by relying on RLS alone -- see
  20260616000001_lock_down_retention_rpcs.sql). service_role bypasses RLS
  entirely (BYPASSRLS) and is the only writer, via the two handlers above.

  ============================================================================
  DATA RETENTION
  ============================================================================

  ON DELETE CASCADE from workflows/auth.users/workflow_executions_v2,
  matching workflow_review_items' and workflow_acknowledgments' own existing
  precedent: deleting a workflow or user account deletes its associated
  qualification history along with it. No separate retention job is
  introduced by this migration.
*/

CREATE TABLE IF NOT EXISTS "public"."workflow_qualification_decisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "execution_id" "uuid" NOT NULL,
    "classifier_node_id" "text" NOT NULL,
    "classifier_node_name" "text",
    "deployment_version_id" "uuid",
    "mode" "text" DEFAULT 'live'::"text" NOT NULL,

    "classification_policy_hash" "text" NOT NULL,

    "ai_classification" "text" NOT NULL,
    "ai_confidence" numeric NOT NULL,
    "ai_reason" "text",
    "positive_signals" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "negative_signals" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "missing_required_fields" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "contradictions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "qualification_status" "text",
    "needs_review" boolean NOT NULL,

    "human_review_occurred" boolean DEFAULT false NOT NULL,
    "human_review_node_id" "text",
    "human_classification" "text",
    "human_reviewed_by" "uuid",
    "human_reviewed_at" timestamp with time zone,

    "final_classification" "text" NOT NULL,
    "overridden" boolean GENERATED ALWAYS AS (
        ("human_classification" IS NOT NULL) AND ("human_classification" IS DISTINCT FROM "ai_classification")
    ) STORED,

    "outcome_status" "text",
    "outcome_revenue" numeric,
    "outcome_recorded_by" "uuid",
    "outcome_recorded_at" timestamp with time zone,

    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "workflow_qualification_decisions_mode_check" CHECK (("mode" = ANY (ARRAY['test'::"text", 'live'::"text"]))),
    CONSTRAINT "workflow_qualification_decisions_confidence_check" CHECK ((("ai_confidence" >= (0)::numeric) AND ("ai_confidence" <= (1)::numeric))),
    CONSTRAINT "workflow_qualification_decisions_status_check" CHECK (("qualification_status" IS NULL OR "qualification_status" = ANY (ARRAY['classified'::"text", 'needs_review'::"text", 'needs_information'::"text"]))),
    CONSTRAINT "workflow_qualification_decisions_human_shape_check" CHECK (
        (("human_review_occurred" = false) AND ("human_classification" IS NULL) AND ("human_reviewed_by" IS NULL) AND ("human_reviewed_at" IS NULL))
        OR
        (("human_review_occurred" = true) AND ("human_classification" IS NOT NULL) AND ("human_reviewed_by" IS NOT NULL) AND ("human_reviewed_at" IS NOT NULL))
    ),
    CONSTRAINT "workflow_qualification_decisions_outcome_shape_check" CHECK (
        (("outcome_status" IS NULL) AND ("outcome_recorded_by" IS NULL) AND ("outcome_recorded_at" IS NULL))
        OR
        (("outcome_status" IS NOT NULL) AND ("outcome_recorded_by" IS NOT NULL) AND ("outcome_recorded_at" IS NOT NULL))
    ),
    CONSTRAINT "workflow_qualification_decisions_outcome_status_check" CHECK (("outcome_status" IS NULL OR "outcome_status" = ANY (ARRAY['contacted'::"text", 'qualified'::"text", 'won'::"text", 'lost'::"text"])))
);

ALTER TABLE "public"."workflow_qualification_decisions" OWNER TO "postgres";

ALTER TABLE ONLY "public"."workflow_qualification_decisions"
    ADD CONSTRAINT "workflow_qualification_decisions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."workflow_qualification_decisions"
    ADD CONSTRAINT "workflow_qualification_decisions_execution_node_key" UNIQUE ("execution_id", "classifier_node_id");

ALTER TABLE ONLY "public"."workflow_qualification_decisions"
    ADD CONSTRAINT "workflow_qualification_decisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."workflow_qualification_decisions"
    ADD CONSTRAINT "workflow_qualification_decisions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."workflow_qualification_decisions"
    ADD CONSTRAINT "workflow_qualification_decisions_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions_v2"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."workflow_qualification_decisions"
    ADD CONSTRAINT "workflow_qualification_decisions_deployment_version_id_fkey" FOREIGN KEY ("deployment_version_id") REFERENCES "public"."deployment_versions"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."workflow_qualification_decisions"
    ADD CONSTRAINT "workflow_qualification_decisions_human_reviewed_by_fkey" FOREIGN KEY ("human_reviewed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."workflow_qualification_decisions"
    ADD CONSTRAINT "workflow_qualification_decisions_outcome_recorded_by_fkey" FOREIGN KEY ("outcome_recorded_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

CREATE INDEX "idx_workflow_qualification_decisions_user" ON "public"."workflow_qualification_decisions" USING "btree" ("user_id", "created_at" DESC);

CREATE INDEX "idx_workflow_qualification_decisions_workflow" ON "public"."workflow_qualification_decisions" USING "btree" ("workflow_id", "created_at" DESC);

CREATE INDEX "idx_workflow_qualification_decisions_execution" ON "public"."workflow_qualification_decisions" USING "btree" ("execution_id");

CREATE INDEX "idx_workflow_qualification_decisions_workflow_review" ON "public"."workflow_qualification_decisions" USING "btree" ("workflow_id", "human_review_occurred");

CREATE INDEX "idx_workflow_qualification_decisions_workflow_final" ON "public"."workflow_qualification_decisions" USING "btree" ("workflow_id", "final_classification");

CREATE INDEX "idx_workflow_qualification_decisions_policy_hash" ON "public"."workflow_qualification_decisions" USING "btree" ("workflow_id", "classification_policy_hash");

ALTER TABLE "public"."workflow_qualification_decisions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own qualification decisions" ON "public"."workflow_qualification_decisions" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));

REVOKE INSERT, UPDATE, DELETE ON "public"."workflow_qualification_decisions" FROM "authenticated";
REVOKE ALL ON "public"."workflow_qualification_decisions" FROM "anon";
GRANT SELECT ON "public"."workflow_qualification_decisions" TO "authenticated";
GRANT ALL ON "public"."workflow_qualification_decisions" TO "service_role";
