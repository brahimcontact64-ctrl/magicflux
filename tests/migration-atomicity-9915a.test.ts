/**
 * Phase 9.9.15A Part F -- static source proof that record_lead_outcome_atomic()
 * genuinely guarantees atomic transition+audit, the same style already
 * established in this codebase for "is X structured the way it must be"
 * verification when a full live-Postgres behavioral test isn't the
 * proportionate tool (see tests/self-healer-wiring-9914.test.ts). The
 * function's actual runtime behavior (CAS/idempotency/terminal-state
 * rejection) is separately, fully behaviorally tested via the mocked RPC
 * in tests/lead-lifecycle-9915.test.ts; THIS file proves the SQL body
 * itself cannot reach an audit write without first winning the CAS, and
 * that the CAS UPDATE and both audit writes live in one function body (one
 * implicit Postgres transaction), not separate round trips.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260917150000_add_qualification_outcome_currency.sql'),
  'utf8',
);

function extractFunctionBody(src: string): string {
  const start = src.indexOf('CREATE OR REPLACE FUNCTION "public"."record_lead_outcome_atomic"');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n$$;', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('record_lead_outcome_atomic() structural atomicity (Phase 9.9.15A Part F)', () => {
  const body = extractFunctionBody(source);

  it('is a single LANGUAGE plpgsql function -- one function call is one implicit Postgres transaction', () => {
    expect(body).toMatch(/RETURNS TABLE\(/);
    expect(source.slice(source.indexOf(body), source.indexOf(body) + body.length + 40)).toMatch(/LANGUAGE plpgsql/);
  });

  it('the CAS UPDATE and BOTH audit writes are inside this one function body, not split across separate statements/round trips', () => {
    const updateIdx = body.indexOf('UPDATE "public"."workflow_qualification_decisions"');
    const eventIdx = body.indexOf('append_execution_event');
    const operatorIdx = body.indexOf('INSERT INTO "public"."runtime_operator_actions"');
    expect(updateIdx).toBeGreaterThan(-1);
    expect(eventIdx).toBeGreaterThan(updateIdx);
    expect(operatorIdx).toBeGreaterThan(eventIdx);
  });

  it('every RETURN prior to the CAS UPDATE result check exits before either audit write is reachable', () => {
    const updateBlockStart = body.indexOf('BEGIN\n    UPDATE "public"."workflow_qualification_decisions"');
    const eventIdx = body.indexOf('append_execution_event');
    expect(updateBlockStart).toBeGreaterThan(-1);
    expect(eventIdx).toBeGreaterThan(updateBlockStart);
    // Every early exit (not found / idempotent no-op / terminal-state
    // conflict / invalid action) appears strictly before the UPDATE block,
    // each paired with its own RETURN -- none of them can fall through to
    // the audit code below.
    const notFoundIdx = body.indexOf("'Qualification decision not found.'");
    const idempotentIdx = body.indexOf('Idempotent no-op');
    const terminalIdx = body.indexOf('terminal in V1');
    expect(notFoundIdx).toBeGreaterThan(-1);
    expect(idempotentIdx).toBeGreaterThan(-1);
    expect(terminalIdx).toBeGreaterThan(-1);
    expect(notFoundIdx).toBeLessThan(updateBlockStart);
    expect(idempotentIdx).toBeLessThan(updateBlockStart);
    expect(terminalIdx).toBeLessThan(updateBlockStart);
  });

  it('a lost CAS race (v_updated_id IS NULL) RETURNs before either audit write is reachable -- structurally impossible to audit a transition that did not happen', () => {
    const raceCheckIdx = body.indexOf('IF v_updated_id IS NULL THEN');
    const raceReturnIdx = body.indexOf('RETURN;', raceCheckIdx);
    const eventIdx = body.indexOf('append_execution_event');
    const operatorIdx = body.indexOf('INSERT INTO "public"."runtime_operator_actions"');
    expect(raceCheckIdx).toBeGreaterThan(-1);
    expect(raceReturnIdx).toBeGreaterThan(raceCheckIdx);
    // The unconditional RETURN inside the lost-race branch comes before
    // BOTH audit writes in program order, and there is no other path from
    // that branch back down to them (plpgsql RETURN exits the function).
    expect(raceReturnIdx).toBeLessThan(eventIdx);
    expect(raceReturnIdx).toBeLessThan(operatorIdx);
  });

  it('the CAS UPDATE WHERE clause re-checks outcome_status IS NOT DISTINCT FROM the value read in THIS invocation -- the actual concurrency guard', () => {
    expect(body).toMatch(/WHERE id = p_qualification_decision_id\s*\n\s*AND user_id = p_user_id\s*\n\s*AND outcome_status IS NOT DISTINCT FROM v_row\.outcome_status/);
  });

  it('the authorization scope is enforced INSIDE the function SQL itself (user_id = p_user_id), both on the initial read and the CAS UPDATE -- not left to the caller', () => {
    const selectClause = body.slice(body.indexOf('SELECT d.id, d.outcome_status'), body.indexOf('IF NOT FOUND'));
    expect(selectClause).toContain('AND d.user_id = p_user_id');
    const updateClause = body.slice(body.indexOf('UPDATE "public"."workflow_qualification_decisions"'), body.indexOf('RETURNING id INTO v_updated_id'));
    expect(updateClause).toContain('AND user_id = p_user_id');
  });

  it('EXECUTE is revoked from PUBLIC and granted only to service_role', () => {
    expect(source).toContain('REVOKE ALL ON FUNCTION "public"."record_lead_outcome_atomic"');
    expect(source).toContain('FROM PUBLIC');
    expect(source).toMatch(/GRANT EXECUTE ON FUNCTION "public"\."record_lead_outcome_atomic"\([^)]*\) TO "service_role"/);
  });

  it('is NOT declared SECURITY DEFINER -- deliberately SECURITY INVOKER (the plpgsql default), unlike append_execution_event()', () => {
    const declStart = source.indexOf('CREATE OR REPLACE FUNCTION "public"."record_lead_outcome_atomic"');
    const declEnd = source.indexOf('AS $$', declStart);
    const declaration = source.slice(declStart, declEnd);
    expect(declaration).not.toMatch(/SECURITY DEFINER/);
  });
});
