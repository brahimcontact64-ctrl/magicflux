/**
 * Phase 9.9.2A — migration-content invariants for workflow_review_items.
 *
 * IMPORTANT HONESTY NOTE: this test suite has NO live Postgres instance to
 * run against (this codebase's entire test suite runs against mocked
 * Supabase clients, never a real database) -- it cannot literally attempt
 * a client-side INSERT/UPDATE/DELETE and observe Postgres reject it. What
 * it DOES verify is that the proposed migration file itself contains the
 * required RLS policy shape, the required explicit REVOKE/GRANT
 * statements, and the required CHECK constraints -- so a reviewer (or a
 * future edit to this migration) cannot silently regress back to a
 * permissive `FOR ALL` policy, a missing REVOKE, or a missing structural
 * constraint without this test failing. This is a design/content
 * assertion, not a live adversarial security test -- do not read it as
 * one. The actual RLS/grant behavior can only be verified once the
 * migration is applied to a real Supabase project (e.g. by attempting the
 * forgeries this suite documents, from a client authenticated as a normal
 * user, and confirming Postgres rejects them).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const MIGRATION_PATH = path.join(process.cwd(), 'supabase/migrations/20260913160000_phase9_9_2_human_review_capability.sql');
const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

describe('workflow_review_items RLS is SELECT-only for authenticated (no client-side mutation)', () => {
  it('does NOT define a permissive FOR ALL policy on workflow_review_items', () => {
    const forAllOnTable = /CREATE POLICY[^;]*ON workflow_review_items[^;]*FOR ALL/is;
    expect(sql).not.toMatch(forAllOnTable);
  });

  it('defines exactly one policy, scoped to SELECT, for the authenticated role, filtered by auth.uid() = user_id', () => {
    const selectPolicy = /CREATE POLICY[^;]*ON workflow_review_items\s+FOR SELECT\s+TO authenticated\s+USING \(auth\.uid\(\) = user_id\)/is;
    expect(sql).toMatch(selectPolicy);
  });

  it('does NOT define an INSERT, UPDATE, or DELETE policy on workflow_review_items for any role', () => {
    expect(sql).not.toMatch(/CREATE POLICY[^;]*ON workflow_review_items\s+FOR INSERT/is);
    expect(sql).not.toMatch(/CREATE POLICY[^;]*ON workflow_review_items\s+FOR UPDATE/is);
    expect(sql).not.toMatch(/CREATE POLICY[^;]*ON workflow_review_items\s+FOR DELETE/is);
  });

  it('enables row level security on the table', () => {
    expect(sql).toMatch(/ALTER TABLE workflow_review_items ENABLE ROW LEVEL SECURITY/i);
  });
});

describe('workflow_review_items grants are explicit, not assumed (does not rely on RLS alone)', () => {
  it('explicitly revokes INSERT, UPDATE, DELETE from authenticated', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE ON workflow_review_items FROM authenticated/i);
  });

  it('explicitly revokes all access from anon', () => {
    expect(sql).toMatch(/REVOKE ALL ON workflow_review_items FROM anon/i);
  });

  it('grants SELECT (not ALL) to authenticated', () => {
    expect(sql).toMatch(/GRANT SELECT ON workflow_review_items TO authenticated/i);
    expect(sql).not.toMatch(/GRANT ALL ON workflow_review_items TO authenticated/i);
  });
});

describe('workflow_review_items structural CHECK constraints', () => {
  it('rejects an empty allowed_outcomes array', () => {
    expect(sql).toMatch(/CHECK \(cardinality\(allowed_outcomes\) > 0\)/i);
  });

  it('requires decision_outcome (once set) to be one of the row\'s own allowed_outcomes', () => {
    expect(sql).toMatch(/decision_outcome IS NULL OR decision_outcome = ANY \(allowed_outcomes\)/i);
  });

  it('requires a pending row to carry no decision metadata, and a non-pending row to carry all of it', () => {
    expect(sql).toMatch(/status = 'pending' AND decision_outcome IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL/i);
    expect(sql).toMatch(/status <> 'pending' AND decision_outcome IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL/i);
  });

  it('status is constrained to the three lifecycle values only (never a decision-value string like \'approved\')', () => {
    expect(sql).toMatch(/status text NOT NULL DEFAULT 'pending' CHECK \(status IN \('pending', 'resume_pending', 'resumed'\)\)/i);
  });
});
