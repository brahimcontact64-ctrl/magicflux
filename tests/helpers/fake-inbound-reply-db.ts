import { randomUUID } from 'node:crypto';

/**
 * A minimal, in-memory fake of the exact Supabase query shapes
 * lib/runtime/inbound-reply/*.ts uses, mirroring the same pattern already
 * established in tests/connectors-woocommerce-lifecycle.test.ts's
 * makeFakeDb() -- real filtering/insert/update/RPC-CAS semantics, no real
 * network or database. The migration this module targets is drafted but
 * not applied, so this is the only way to test the storage/correlation/
 * transition logic locally this phase.
 */

export type Row = Record<string, unknown>;

export type FakeTables = {
  runtime_conversations: Row[];
  runtime_followup_sequences: Row[];
  runtime_outbound_messages: Row[];
  runtime_inbound_reply_events: Row[];
};

export function makeEmptyTables(): FakeTables {
  return {
    runtime_conversations: [],
    runtime_followup_sequences: [],
    runtime_outbound_messages: [],
    runtime_inbound_reply_events: [],
  };
}

const UNIQUE_KEYS: Record<string, string[][]> = {
  runtime_conversations: [['workflow_id', 'provider', 'provider_thread_id']],
  // attempt_key is its own single-column unique constraint (Phase B) --
  // Postgres treats multiple NULLs as non-conflicting for a UNIQUE
  // constraint, mirrored below by skipping any key whose candidate value
  // is null/undefined.
  runtime_outbound_messages: [['provider', 'provider_message_id'], ['attempt_key']],
  runtime_inbound_reply_events: [['provider', 'provider_message_id']],
};

function violatesUnique(table: string, rows: Row[], candidate: Row): boolean {
  const uniqueSets = UNIQUE_KEYS[table] ?? [];
  return uniqueSets.some((keys) => {
    if (keys.some((k) => candidate[k] === null || candidate[k] === undefined)) return false;
    return rows.some((r) => keys.every((k) => r[k] === candidate[k]));
  });
}

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([col, val]) => row[col] === val);
}

function builder(tables: FakeTables, table: keyof FakeTables) {
  const rows = tables[table];
  let mode: 'select' | 'insert' | 'update' = 'select';
  let insertPayload: Row | null = null;
  let updatePatch: Row = {};
  const filters: Array<[string, unknown]> = [];

  const api: Record<string, unknown> = {
    select() {
      return api;
    },
    insert(payload: Row) {
      mode = 'insert';
      insertPayload = payload;
      return api;
    },
    update(patch: Row) {
      mode = 'update';
      updatePatch = patch;
      return api;
    },
    eq(col: string, val: unknown) {
      filters.push([col, val]);
      return api;
    },
    single: async () => {
      if (mode !== 'insert' || !insertPayload) return { data: null, error: { message: 'single() only supported after insert() in this fake', code: 'FAKE' } };
      if (violatesUnique(table, rows, insertPayload)) {
        return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
      }
      const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...insertPayload };
      rows.push(row);
      return { data: row, error: null };
    },
    maybeSingle: async () => {
      const found = rows.find((r) => matches(r, filters));
      if (mode === 'update' && found) {
        Object.assign(found, updatePatch, { updated_at: new Date().toISOString() });
      }
      return { data: found ? { ...found } : null, error: null };
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown) {
      if (mode === 'update') {
        const found = rows.filter((r) => matches(r, filters));
        found.forEach((r) => Object.assign(r, updatePatch, { updated_at: new Date().toISOString() }));
        return Promise.resolve(resolve({ data: found, error: null }));
      }
      const found = rows.filter((r) => matches(r, filters));
      return Promise.resolve(resolve({ data: found.map((r) => ({ ...r })), error: null }));
    },
  };
  return api;
}

/**
 * Implements transition_followup_sequence_atomic()'s exact CAS semantics in
 * JS, against the same in-memory `runtime_followup_sequences` array the
 * fake db's query builder reads/writes -- mirrors the migration's own SQL
 * function line for line (see its header comment) so behavior stays
 * provably identical rather than drifting between the two.
 */
function fakeTransitionRpc(tables: FakeTables, params: Record<string, unknown>) {
  const sequenceId = params.p_sequence_id as string;
  const userId = params.p_user_id as string;
  const targetStatus = params.p_target_status as string;
  const reason = params.p_reason as string | null;

  if (!['replied', 'cancelled', 'completed'].includes(targetStatus)) {
    return { data: [{ ok: false, already_in_state: false, previous_status: null, new_status: targetStatus, current_status: null, execution_id: null, workflow_id: null, reason: 'target_status must be replied, cancelled, or completed.' }], error: null };
  }

  const row = tables.runtime_followup_sequences.find((r) => r.id === sequenceId && r.user_id === userId);
  if (!row) {
    return { data: [{ ok: false, already_in_state: false, previous_status: null, new_status: targetStatus, current_status: null, execution_id: null, workflow_id: null, reason: 'Follow-up sequence not found.' }], error: null };
  }

  const currentStatus = row.status as string;

  if (currentStatus === targetStatus) {
    return { data: [{ ok: true, already_in_state: true, previous_status: currentStatus, new_status: targetStatus, current_status: currentStatus, execution_id: row.execution_id, workflow_id: row.workflow_id, reason: null }], error: null };
  }

  if (currentStatus !== 'active') {
    return { data: [{ ok: false, already_in_state: false, previous_status: currentStatus, new_status: targetStatus, current_status: currentStatus, execution_id: row.execution_id, workflow_id: row.workflow_id, reason: `Sequence already in terminal state "${currentStatus}" -- cannot transition to "${targetStatus}".` }], error: null };
  }

  row.status = targetStatus;
  row.updated_at = new Date().toISOString();
  row.last_transition_reason = reason;
  if (targetStatus === 'replied') row.replied_at = new Date().toISOString();
  if (targetStatus === 'cancelled') row.cancelled_at = new Date().toISOString();
  if (targetStatus === 'completed') row.completed_at = new Date().toISOString();

  return { data: [{ ok: true, already_in_state: false, previous_status: currentStatus, new_status: targetStatus, current_status: targetStatus, execution_id: row.execution_id, workflow_id: row.workflow_id, reason: null }], error: null };
}

/**
 * Implements acquire_followup_send_lock_atomic()'s exact CAS semantics --
 * only succeeds if 'active' AND no unexpired lease is held.
 */
function fakeAcquireSendLockRpc(tables: FakeTables, params: Record<string, unknown>) {
  const sequenceId = params.p_sequence_id as string;
  const userId = params.p_user_id as string;
  const lockToken = params.p_lock_token as string;
  const leaseSeconds = params.p_lease_seconds as number;

  const row = tables.runtime_followup_sequences.find((r) => r.id === sequenceId && r.user_id === userId);
  if (!row) {
    return { data: [{ ok: false, reason: 'Follow-up sequence not found.', current_status: null }], error: null };
  }

  const status = row.status as string;
  if (status !== 'active') {
    return { data: [{ ok: false, reason: `Sequence is "${status}", not active.`, current_status: status }], error: null };
  }

  const existingToken = row.send_lock_token as string | null | undefined;
  const existingExpiry = row.send_lock_expires_at as string | null | undefined;
  const leaseHeld = existingToken != null && existingExpiry != null && new Date(existingExpiry).getTime() > Date.now();

  if (leaseHeld) {
    return { data: [{ ok: false, reason: "Another send attempt currently holds this sequence's send lock.", current_status: status }], error: null };
  }

  row.send_lock_token = lockToken;
  row.send_lock_expires_at = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  row.updated_at = new Date().toISOString();

  return { data: [{ ok: true, reason: null, current_status: 'active' }], error: null };
}

function fakeReleaseSendLockRpc(tables: FakeTables, params: Record<string, unknown>) {
  const sequenceId = params.p_sequence_id as string;
  const userId = params.p_user_id as string;
  const lockToken = params.p_lock_token as string;

  const row = tables.runtime_followup_sequences.find((r) => r.id === sequenceId && r.user_id === userId);
  if (row && row.send_lock_token === lockToken) {
    row.send_lock_token = null;
    row.send_lock_expires_at = null;
    row.updated_at = new Date().toISOString();
  }
  return { data: null, error: null };
}

/**
 * A test file uses this like:
 *
 *   let tables: FakeTables;
 *   vi.mock('@/lib/supabase-server', () => ({
 *     createServiceClient: vi.fn(() => makeFakeInboundReplyDb(tables)),
 *   }));
 *   beforeEach(() => { tables = makeEmptyTables(); });
 *
 * -- mirroring tests/connectors-woocommerce-lifecycle.test.ts's own
 * makeFakeDb() pattern exactly: the mock factory closes over the outer
 * `tables` binding, so reassigning it in beforeEach is visible to every
 * createServiceClient() call made afterwards, without needing vi.doMock's
 * dynamic-import dance.
 */
export function makeFakeInboundReplyDb(tables: FakeTables) {
  return {
    from: (table: string) => builder(tables, table as keyof FakeTables),
    rpc: async (fn: string, params: Record<string, unknown>) => {
      if (fn === 'transition_followup_sequence_atomic') return fakeTransitionRpc(tables, params);
      if (fn === 'acquire_followup_send_lock_atomic') return fakeAcquireSendLockRpc(tables, params);
      if (fn === 'release_followup_send_lock_atomic') return fakeReleaseSendLockRpc(tables, params);
      throw new Error(`Unhandled fake RPC: ${fn}`);
    },
  };
}
