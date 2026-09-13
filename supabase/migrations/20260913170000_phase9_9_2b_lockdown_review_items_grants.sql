/*
  # Phase 9.9.2B follow-up -- close a residual grant gap on workflow_review_items

  Found during LIVE adversarial grant inspection immediately after applying
  20260913160000_phase9_9_2_human_review_capability.sql (querying
  information_schema.role_table_grants against the real production
  database, exactly as the hardening review required -- not assumed from
  source alone).

  That migration's REVOKE INSERT, UPDATE, DELETE ON workflow_review_items
  FROM authenticated correctly removed those three privileges, but this
  project's default per-table grants (set up at project bootstrap, not in
  any tracked migration -- the same class of issue already fixed once for
  RPC EXECUTE grants in 20260616000001_lock_down_retention_rpcs.sql) also
  extend TRUNCATE, REFERENCES, and TRIGGER to `authenticated` on every
  public table. TRUNCATE is the dangerous one: it is NOT row-scoped and is
  NOT subject to RLS at all -- any authenticated user holding it could
  execute TRUNCATE workflow_review_items and destroy every tenant's review
  records in one statement, regardless of any RLS policy on this table.
  REFERENCES/TRIGGER are lower-risk (creating a stray FK or trigger against
  this table) but are still broader than an authenticated client has any
  legitimate reason to hold on a server-authoritative table.

  This migration only touches grants -- no table, column, constraint,
  index, or policy is created, dropped, or altered. Idempotent (REVOKE on
  a privilege not held is a no-op).
*/

REVOKE TRUNCATE, REFERENCES, TRIGGER ON workflow_review_items FROM authenticated;
