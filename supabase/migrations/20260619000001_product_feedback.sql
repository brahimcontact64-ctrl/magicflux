/*
  Phase 9.6 Section 3 — Product feedback.

  PROPOSED, NOT YET APPLIED. Per the explicit instruction to "STOP before
  applying it and present the exact migration," this file is written but
  has not been run against production. It must be reviewed and applied
  deliberately (e.g. via `supabase db push` or the Supabase dashboard SQL
  editor) before app/api/feedback and the admin inbox at /admin/feedback
  become live — both already degrade gracefully today (an honest "not
  configured yet" response / a dashboard note) if this table doesn't exist,
  confirmed by tests/beta-metrics.test.ts and tests/product-feedback*.test.ts.

  Design:
    - One row per feedback submission. `user_id` is set from the verified
      JWT server-side (never client-supplied) and nullable only so a row
      is never orphaned/deleted if the account is later removed
      (ON DELETE SET NULL) -- feedback content itself is not
      personally-identifying beyond whatever the user chose to type.
    - `category` is a closed enum matching the four types the product asks
      for (general/bug/feature_request are exact; a 1-5 rating can
      accompany any category, and none of them require a written comment).
    - No workflow_json, prompt, credential, or authorization-header field
      exists on this table at all -- the API route (app/api/feedback)
      enforces that only safe operational context (user id, path, app
      version, timestamp) is ever attached automatically, and workflow
      content is included only if the user explicitly opts in by pasting
      it into the free-text `comment` field themselves.
    - RLS: a user may INSERT only a row with their own auth.uid() as
      user_id, and may SELECT only their own rows (so a future "my
      feedback history" view is possible without a new policy). There is
      no client-reachable UPDATE/DELETE policy at all -- status changes
      (new -> reviewed -> resolved -> archived) happen only through the
      admin inbox API route, which uses the service-role client and its
      own isAdminUser() check (the same pattern every other admin route in
      this codebase already uses), not an RLS admin policy.
*/

CREATE TABLE IF NOT EXISTS product_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('general', 'bug', 'feature_request')),
  rating smallint CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  comment text,
  page_path text,
  app_version text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'resolved', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_feedback_created_at_idx ON product_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS product_feedback_user_id_idx ON product_feedback (user_id);
CREATE INDEX IF NOT EXISTS product_feedback_status_idx ON product_feedback (status);

ALTER TABLE product_feedback ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'product_feedback' AND policyname = 'product_feedback_insert_own'
  ) THEN
    CREATE POLICY product_feedback_insert_own ON product_feedback
      FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'product_feedback' AND policyname = 'product_feedback_select_own'
  ) THEN
    CREATE POLICY product_feedback_select_own ON product_feedback
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- No UPDATE/DELETE policy for the authenticated role at all -- intentional.
-- Status transitions happen only via the service-role admin inbox route.
