/**
 * Phase 9.9.15/9.9.15A -- lib/runtime/lead-lifecycle.ts: the business
 * OUTCOME dimension for a qualification decision ("lead"), deliberately
 * separate from AI classification (immutable) and SLA/acknowledgment
 * history (never touched here).
 *
 * Phase 9.9.15A Part F -- the CAS transition and its audit trail are now
 * performed by ONE atomic Postgres function, record_lead_outcome_atomic()
 * (see the migration's own doc comment). This file proves the TS layer:
 *   - validates revenue/currency BEFORE ever calling the RPC
 *   - makes EXACTLY ONE round trip (the RPC call) to accomplish a
 *     transition -- never a separate update + separate audit insert from
 *     application code, which is the structural proof that nothing in the
 *     TypeScript layer can observe a "transitioned but unaudited" state
 *   - correctly interprets every shape the RPC can return (ok/already-in-
 *     state/terminal-conflict/race-loss/not-found)
 * The RPC's OWN atomicity (a single Postgres function invocation is one
 * transaction) is a property of the SQL itself, verified separately in
 * migration-atomicity-9915a.test.ts via structural inspection of the
 * function body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rpcMock = vi.fn();
const fromMock = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => ({ rpc: (...args: unknown[]) => rpcMock(...args), from: (...args: unknown[]) => fromMock(...args) })),
}));

const DECISION_ID = 'decision-1';
const OWNER_ID = 'user-owner';

function rpcResult(overrides: Partial<{
  ok: boolean; already_in_state: boolean; previous_status: string | null; new_status: string;
  current_status: string | null; execution_id: string | null; workflow_id: string | null; reason: string | null;
}> = {}) {
  return {
    ok: true, already_in_state: false, previous_status: null, new_status: 'contacted',
    current_status: null, execution_id: 'exec-1', workflow_id: 'wf-1', reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  rpcMock.mockReset();
  fromMock.mockReset();
});

describe('recordLeadOutcome -- single atomic RPC call, no separate table writes (Part F structural proof)', () => {
  it('a successful transition makes EXACTLY ONE call to the database (the RPC) -- never a separate update + separate audit insert', async () => {
    rpcMock.mockResolvedValue({ data: [rpcResult()], error: null });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'contacted' });

    expect(result.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('record_lead_outcome_atomic', expect.objectContaining({
      p_qualification_decision_id: DECISION_ID,
      p_user_id: OWNER_ID,
      p_actor_id: OWNER_ID,
      p_action: 'contacted',
    }));
    // No direct table access at all for this operation -- the RPC is the
    // ONLY database interaction, which is what makes "transitioned but
    // unaudited" structurally impossible from the TS layer's perspective.
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('interprets a successful Won-with-revenue RPC response correctly', async () => {
    rpcMock.mockResolvedValue({ data: [rpcResult({ new_status: 'won', execution_id: 'exec-1', workflow_id: 'wf-1' })], error: null });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'won', revenue: '5000.00', currency: 'USD' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newStatus).toBe('won');
    expect(result.executionId).toBe('exec-1');
    expect(rpcMock).toHaveBeenCalledWith('record_lead_outcome_atomic', expect.objectContaining({ p_revenue: 5000, p_currency: 'USD' }));
  });

  it('interprets an idempotent no-op response correctly', async () => {
    rpcMock.mockResolvedValue({ data: [rpcResult({ already_in_state: true, previous_status: 'contacted', new_status: 'contacted' })], error: null });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'contacted' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyInState).toBe(true);
  });

  it('interprets a terminal-state conflict response correctly', async () => {
    rpcMock.mockResolvedValue({ data: [{ ok: false, already_in_state: false, previous_status: null, new_status: 'lost', current_status: 'won', execution_id: null, workflow_id: null, reason: 'Outcome already recorded as "won" -- terminal in V1, cannot change to "lost".' }], error: null });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'lost' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.currentStatus).toBe('won');
  });

  it('interprets a "not found" response correctly (also covers cross-tenant: the RPC\'s own SQL scopes by user_id)', async () => {
    rpcMock.mockResolvedValue({ data: [{ ok: false, already_in_state: false, previous_status: null, new_status: 'won', current_status: null, execution_id: null, workflow_id: null, reason: 'Qualification decision not found.' }], error: null });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: 'attacker', actorId: 'attacker', action: 'won' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('Qualification decision not found.');
  });

  // Phase 9.9.15A Part H -- knowing the decision/execution/workflow id must
  // NEVER authorize a mutation on its own. This is enforced inside the RPC's
  // own SQL (WHERE d.user_id = p_user_id on both the read and the CAS
  // UPDATE -- see migration-atomicity-9915a.test.ts), but this test proves
  // the TS layer passes the AUTHENTICATED caller's own id as p_user_id --
  // never anything derived from the (attacker-controllable) decision id
  // itself -- so an attacker who merely learns a real decision id gets
  // exactly the same "not found" outcome as a nonexistent one, never a
  // successful mutation.
  it('Part H: an attacker who knows a real decision/execution/workflow id but is not its owner still gets "not found", never a successful mutation', async () => {
    rpcMock.mockResolvedValue({ data: [{ ok: false, already_in_state: false, previous_status: null, new_status: 'won', current_status: null, execution_id: null, workflow_id: null, reason: 'Qualification decision not found.' }], error: null });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: 'attacker-tenant', actorId: 'attacker-tenant', action: 'won', revenue: '999', currency: 'USD' });
    expect(result.ok).toBe(false);
    // The caller's own authenticated id is what gets sent -- there is no
    // code path in this module that widens the scope based on the id being
    // mutated rather than the id making the request.
    expect(rpcMock).toHaveBeenCalledWith('record_lead_outcome_atomic', expect.objectContaining({ p_user_id: 'attacker-tenant', p_actor_id: 'attacker-tenant' }));
  });

  it('a genuine database error (RPC call itself fails) is reported cleanly, never silently ignored', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'contacted' });
    expect(result.ok).toBe(false);
  });
});

describe('recordLeadOutcome -- revenue/currency validation happens BEFORE any RPC call (Part G)', () => {
  it('revenue with currency succeeds and passes a Number to the RPC only after validating the string shape', async () => {
    rpcMock.mockResolvedValue({ data: [rpcResult({ new_status: 'won' })], error: null });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'won', revenue: '2500.50', currency: 'EUR' });
    expect(rpcMock).toHaveBeenCalledWith('record_lead_outcome_atomic', expect.objectContaining({ p_revenue: 2500.5, p_currency: 'EUR' }));
  });

  it('invalid revenue (negative sign) is rejected before ANY database call', async () => {
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'won', revenue: '-100', currency: 'USD' });
    expect(result.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('invalid revenue (scientific notation / non-decimal) is rejected before any database call', async () => {
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'won', revenue: '1e10', currency: 'USD' });
    expect(result.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('revenue exceeding the 12-digit bound is rejected', async () => {
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'won', revenue: '1234567890123', currency: 'USD' });
    expect(result.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('missing currency with revenue provided is rejected -- never assumes USD', async () => {
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'won', revenue: '500' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/currency/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('currency without revenue is rejected', async () => {
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'won', currency: 'USD' });
    expect(result.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('a malformed currency code is rejected', async () => {
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'won', revenue: '500', currency: 'dollars' });
    expect(result.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('a lowercase currency code is rejected (must already be canonical uppercase -- no silent normalization of a malformed value)', async () => {
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'won', revenue: '500', currency: 'usd' });
    expect(result.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('revenue on Lost is rejected before any database call (Part D: only Won carries revenue)', async () => {
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'lost', revenue: '500', currency: 'USD' });
    expect(result.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('high-precision monetary input survives the string->number boundary exactly (no float corruption)', async () => {
    rpcMock.mockResolvedValue({ data: [rpcResult({ new_status: 'won' })], error: null });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'won', revenue: '999999999999.99', currency: 'USD' });
    const call = rpcMock.mock.calls[0][1] as { p_revenue: number };
    expect(call.p_revenue).toBe(999999999999.99);
    expect(String(call.p_revenue)).toBe('999999999999.99'); // exact round trip, not e.g. ...998 or ...00000001
  });

  it('a currency with correct 3-letter format but non-USD (DZD) is accepted -- never assumes/forces USD', async () => {
    rpcMock.mockResolvedValue({ data: [rpcResult({ new_status: 'won' })], error: null });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'won', revenue: '125000', currency: 'DZD' });
    expect(result.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith('record_lead_outcome_atomic', expect.objectContaining({ p_currency: 'DZD' }));
  });
});

describe('recordLeadOutcome -- V1 "qualified" cannot be created (Part C)', () => {
  it('rejects "qualified" as an action -- V1 only exposes contacted/won/lost', async () => {
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    // @ts-expect-error -- 'qualified' is intentionally not a member of LeadLifecycleAction.
    const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'qualified' });
    expect(result.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('recordLeadOutcome -- note redaction (Part I)', () => {
  it('scrubs a credential-shaped string from the note before it ever reaches the database', async () => {
    rpcMock.mockResolvedValue({ data: [rpcResult()], error: null });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'contacted', note: 'api_key=sk-live-abcdef1234567890 called them' });
    const call = rpcMock.mock.calls[0][1] as { p_note: string };
    expect(call.p_note).not.toContain('sk-live-abcdef1234567890');
  });

  it('scrubs an email/phone shape from the note', async () => {
    rpcMock.mockResolvedValue({ data: [rpcResult()], error: null });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'lost', note: 'Reached them at jane@example.com, budget too low' });
    const call = rpcMock.mock.calls[0][1] as { p_note: string };
    expect(call.p_note).not.toContain('jane@example.com');
  });

  it('bounds an excessively long note', async () => {
    rpcMock.mockResolvedValue({ data: [rpcResult()], error: null });
    const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
    await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'contacted', note: 'x'.repeat(5000) });
    const call = rpcMock.mock.calls[0][1] as { p_note: string };
    expect(call.p_note.length).toBeLessThanOrEqual(300);
  });
});

describe('recordLeadOutcome -- zero provider calls, zero workflow replay (Part M/N)', () => {
  it('never imports a provider dispatch/workflow execution/fetch primitive -- a lifecycle mutation cannot side-effect or replay a workflow', () => {
    const source = readFileSync(resolve(__dirname, '../lib/runtime/lead-lifecycle.ts'), 'utf8');
    expect(source).not.toMatch(/dispatchNode/);
    expect(source).not.toMatch(/runWorkflowExecution/);
    expect(source).not.toMatch(/fetch\(/);
    // The RPC call and the two `.from(...)` reads (getLeadLifecycleHistory)
    // are the ONLY database interactions this module performs at all.
    expect(source).toMatch(/\.rpc\(/);
  });

  it('a successful transition never touches global fetch -- confirms the structural claim behaviorally, not just by source grep', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('recordLeadOutcome must never call fetch()');
    });
    try {
      rpcMock.mockResolvedValue({ data: [rpcResult({ new_status: 'won' })], error: null });
      const { recordLeadOutcome } = await import('../lib/runtime/lead-lifecycle');
      const result = await recordLeadOutcome({ qualificationDecisionId: DECISION_ID, userId: OWNER_ID, actorId: OWNER_ID, action: 'won', revenue: '100', currency: 'USD' });
      expect(result.ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('getLeadLifecycleHistory', () => {
  type Row = Record<string, unknown>;
  class FakeQuery {
    private filters: Array<[string, unknown]> = [];
    constructor(private rows: Row[]) {}
    eq(col: string, val: unknown): this { this.filters.push([col, val]); return this; }
    select(): this { return this; }
    order(): this { return this; }
    limit(): this { return this; }
    then<T>(resolve: (v: { data: Row[] }) => T): Promise<T> {
      return Promise.resolve(resolve({ data: this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)) }));
    }
  }

  it('reads back the lifecycle audit trail scoped to this decision id, ignoring other decisions\' events on the same execution', async () => {
    fromMock.mockImplementation((name: string) => {
      if (name === 'runtime_execution_events') {
        return new FakeQuery([
          { execution_id: 'exec-1', event_type: 'lead_lifecycle_changed', payload: { qualification_decision_id: DECISION_ID, previous_status: null, new_status: 'contacted', note: null, revenue: null, currency: null, actor_id: OWNER_ID }, created_at: '2026-01-01T00:00:00.000Z' },
          { execution_id: 'exec-1', event_type: 'lead_lifecycle_changed', payload: { qualification_decision_id: 'other-decision', previous_status: null, new_status: 'lost', note: null, revenue: null, currency: null, actor_id: OWNER_ID }, created_at: '2026-01-02T00:00:00.000Z' },
        ]);
      }
      return new FakeQuery([]);
    });
    const { getLeadLifecycleHistory } = await import('../lib/runtime/lead-lifecycle');
    const history = await getLeadLifecycleHistory({ qualificationDecisionId: DECISION_ID, executionId: 'exec-1' });
    expect(history).toHaveLength(1);
    expect(history[0].newStatus).toBe('contacted');
  });
});
