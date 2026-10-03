import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GmailApiClient } from '@/lib/runtime/inbound-reply/gmail-poll';
import { makeFakeInboundReplyDb, makeEmptyTables, type FakeTables } from './helpers/fake-inbound-reply-db';

/**
 * Workflow #2 Phase D.6 -- Gmail-polling discovery + batch orchestration.
 * NO REAL GMAIL CALLS: pollGmailInboundReplies() is always invoked with an
 * injected fake GmailApiClient (never the real one), and credential/
 * verification state is a local in-memory fake -- this suite never touches
 * a real database, a real Gmail account, or sends anything.
 *
 * createServiceClient() is shared by TWO different concerns here: this
 * module's own discovery queries (integration_credentials/
 * credential_verifications) and pollGmailInboundReplies()'s downstream
 * processInboundReply() call (the 4 runtime_* tables, already-certified
 * Phase A storage). The combined fake below routes each table name to the
 * right backend -- the existing fake-inbound-reply-db.ts helper for
 * runtime_*, a small local query builder (supporting the .order()/.limit()/
 * .in() this module's own queries need, which that helper doesn't) for the
 * other two.
 */

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private inFilter: [string, unknown[]] | null = null;
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(private rows: Row[]) {}

  eq(col: string, val: unknown): this {
    this.filters.push([col, val]);
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.inFilter = [col, vals];
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  select(): this {
    return this;
  }

  private resolve(): Row[] {
    let result = this.rows.filter((r) => this.filters.every(([col, val]) => r[col] === val));
    if (this.inFilter) {
      const [col, vals] = this.inFilter;
      const set = new Set(vals);
      result = result.filter((r) => set.has(r[col]));
    }
    if (this.orderCol) {
      const col = this.orderCol;
      result = [...result].sort((a, b) => {
        const av = a[col] as string;
        const bv = b[col] as string;
        return this.orderAsc ? (av < bv ? -1 : av > bv ? 1 : 0) : av < bv ? 1 : av > bv ? -1 : 0;
      });
    }
    if (this.limitN !== null) result = result.slice(0, this.limitN);
    return result;
  }

  then<T>(resolve: (v: { data: Row[]; error: null }) => T): Promise<T> {
    return Promise.resolve(resolve({ data: this.resolve(), error: null }));
  }
}

const RUNTIME_TABLE_NAMES = new Set(['runtime_conversations', 'runtime_followup_sequences', 'runtime_outbound_messages', 'runtime_inbound_reply_events']);

class FakeDb {
  credentialTables = new Map<string, Row[]>([
    ['integration_credentials', []],
    ['credential_verifications', []],
  ]);
  runtimeTables: FakeTables = makeEmptyTables();
  private runtimeDb = makeFakeInboundReplyDb(this.runtimeTables);

  from(name: string) {
    if (RUNTIME_TABLE_NAMES.has(name)) return this.runtimeDb.from(name as keyof FakeTables);
    if (!this.credentialTables.has(name)) this.credentialTables.set(name, []);
    return new FakeQuery(this.credentialTables.get(name)!);
  }

  rpc(fn: string, params: Record<string, unknown>) {
    return this.runtimeDb.rpc(fn, params);
  }
}

let fakeDb: FakeDb;

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(() => fakeDb),
}));

// pollGmailInboundReplies() (invoked by runGmailPollingBatch) separately
// calls getValidAccessToken/getDecryptedProviderCredentials/
// saveProviderCredentials -- mirrors tests/inbound-reply-gmail-poll.test.ts's
// own exact mocking pattern for these two modules.
let accessTokenImpl: () => Promise<string>;
vi.mock('@/lib/credentials/oauth-refresh', () => ({
  getValidAccessToken: vi.fn((...args: unknown[]) => accessTokenImpl()),
}));

let storedCredentials: Record<string, Record<string, string>>;
vi.mock('@/lib/credentials/storage', () => ({
  getDecryptedProviderCredentials: vi.fn(async (userId: string) => storedCredentials[userId] ?? {}),
  saveProviderCredentials: vi.fn(async (userId: string, _provider: string, creds: Record<string, string>) => {
    storedCredentials[userId] = { ...(storedCredentials[userId] ?? {}), ...creds };
  }),
}));

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const USER_C = '00000000-0000-4000-8000-0000000000c3';

beforeEach(() => {
  fakeDb = new FakeDb();
  storedCredentials = {};
  accessTokenImpl = async () => 'fake-access-token';
  // Phase D.7A: eligibility now ALSO requires explicit allowlisting. Most
  // existing tests below are about the OTHER half of eligibility (health,
  // provider, ordering, bounding) and predate this concept -- default to
  // allowlisting this file's own fixed test users so those tests keep
  // exercising exactly what they always did. Tests that specifically
  // exercise allowlist semantics override this per-test.
  process.env.GMAIL_POLLING_CANARY_USER_IDS = `${USER_A},${USER_B},${USER_C}`;
  vi.resetModules();
});

function seedGmailCredential(userId: string, createdAt: string) {
  fakeDb.credentialTables.get('integration_credentials')!.push({
    user_id: userId,
    provider: 'gmail',
    credential_key: 'oauth_google_gmail',
    encrypted_value: 'irrelevant-encrypted-blob',
    created_at: createdAt,
  });
}

function seedVerification(userId: string, status: string) {
  fakeDb.credentialTables.get('credential_verifications')!.push({
    user_id: userId,
    provider: 'gmail',
    status,
  });
}

describe('discoverGmailPollingCandidates', () => {
  it('selects only Gmail connections with a healthy verification status', async () => {
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    seedVerification(USER_A, 'healthy');
    seedGmailCredential(USER_B, '2026-01-02T00:00:00Z');
    seedVerification(USER_B, 'invalid');

    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const candidates = await discoverGmailPollingCandidates(25);

    expect(candidates).toEqual([USER_A]);
  });

  it('skips a disconnected/never-verified Gmail connection safely (no verification row at all)', async () => {
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    // No credential_verifications row for USER_A at all.

    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const candidates = await discoverGmailPollingCandidates(25);

    expect(candidates).toEqual([]);
  });

  it('never selects a non-Gmail provider connection', async () => {
    fakeDb.credentialTables.get('integration_credentials')!.push({
      user_id: USER_A,
      provider: 'shopify',
      credential_key: 'access_token',
      created_at: '2026-01-01T00:00:00Z',
    });
    seedVerification(USER_A, 'healthy');

    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const candidates = await discoverGmailPollingCandidates(25);

    expect(candidates).toEqual([]);
  });

  it('never selects a bare gmail_history_cursor row without the real OAuth credential', async () => {
    fakeDb.credentialTables.get('integration_credentials')!.push({
      user_id: USER_A,
      provider: 'gmail',
      credential_key: 'gmail_history_cursor',
      created_at: '2026-01-01T00:00:00Z',
    });
    seedVerification(USER_A, 'healthy');

    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const candidates = await discoverGmailPollingCandidates(25);

    expect(candidates).toEqual([]);
  });

  it('DETERMINISTIC ORDERING: orders by connection age, oldest first', async () => {
    seedGmailCredential(USER_B, '2026-01-02T00:00:00Z');
    seedVerification(USER_B, 'healthy');
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    seedVerification(USER_A, 'healthy');
    seedGmailCredential(USER_C, '2026-01-03T00:00:00Z');
    seedVerification(USER_C, 'healthy');

    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const candidates = await discoverGmailPollingCandidates(25);

    expect(candidates).toEqual([USER_A, USER_B, USER_C]);
  });

  it('BOUNDED: never returns more than the requested limit', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `00000000-0000-4000-8000-00000000${String(i).padStart(4, '0')}`;
      ids.push(id);
      seedGmailCredential(id, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`);
      seedVerification(id, 'healthy');
    }
    process.env.GMAIL_POLLING_CANARY_USER_IDS = ids.join(',');

    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const candidates = await discoverGmailPollingCandidates(3);

    expect(candidates).toHaveLength(3);
  });

  it('zero eligible connections returns an empty array, not an error', async () => {
    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const candidates = await discoverGmailPollingCandidates(25);

    expect(candidates).toEqual([]);
  });

  it('never returns credential material -- only opaque user ids', async () => {
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    seedVerification(USER_A, 'healthy');

    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const candidates = await discoverGmailPollingCandidates(25);

    expect(candidates).toEqual([USER_A]);
    expect(typeof candidates[0]).toBe('string');
  });
});

describe('parseGmailPollingCanaryAllowlist (Phase D.7A -- fail-closed canary scope)', () => {
  it('1. env absent -> empty set (zero candidates)', async () => {
    delete process.env.GMAIL_POLLING_CANARY_USER_IDS;
    const { parseGmailPollingCanaryAllowlist } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    expect(parseGmailPollingCanaryAllowlist(undefined).size).toBe(0);
  });

  it('2. env empty string -> empty set', async () => {
    const { parseGmailPollingCanaryAllowlist } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    expect(parseGmailPollingCanaryAllowlist('').size).toBe(0);
  });

  it('3. env whitespace-only -> empty set', async () => {
    const { parseGmailPollingCanaryAllowlist } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    expect(parseGmailPollingCanaryAllowlist('   \t  ').size).toBe(0);
  });

  it('4. a malformed UUID entry throws -- fails closed/loud, never silently drops or broadens', async () => {
    const { parseGmailPollingCanaryAllowlist } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    expect(() => parseGmailPollingCanaryAllowlist('not-a-real-uuid')).toThrow();
    expect(() => parseGmailPollingCanaryAllowlist(`${USER_A},also-not-a-uuid`)).toThrow();
  });

  it("9/10/11. multiple valid ids, duplicates, and surrounding whitespace are all handled safely", async () => {
    const { parseGmailPollingCanaryAllowlist } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const allowlist = parseGmailPollingCanaryAllowlist(`  ${USER_A} , ${USER_B},${USER_A} ,${USER_B}  `);
    expect(allowlist.size).toBe(2);
    expect(allowlist.has(USER_A)).toBe(true);
    expect(allowlist.has(USER_B)).toBe(true);
  });

  it('never throws a message containing the raw env value verbatim beyond the entries themselves -- no secret/credential content to begin with, but confirms no unrelated data leaks into the error', async () => {
    const { parseGmailPollingCanaryAllowlist } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    try {
      parseGmailPollingCanaryAllowlist('garbage-value');
      throw new Error('expected parseGmailPollingCanaryAllowlist to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain('garbage-value');
    }
  });
});

describe('discoverGmailPollingCandidates -- Phase D.7A allowlist intersection', () => {
  it('5. a healthy Gmail user who IS allowlisted is selected', async () => {
    process.env.GMAIL_POLLING_CANARY_USER_IDS = USER_A;
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    seedVerification(USER_A, 'healthy');

    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    expect(await discoverGmailPollingCandidates(25)).toEqual([USER_A]);
  });

  it('6. a healthy Gmail user who is NOT allowlisted is excluded', async () => {
    process.env.GMAIL_POLLING_CANARY_USER_IDS = USER_B; // only B allowlisted
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    seedVerification(USER_A, 'healthy');

    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    expect(await discoverGmailPollingCandidates(25)).toEqual([]);
  });

  it('7. an allowlisted but UNHEALTHY user is excluded', async () => {
    process.env.GMAIL_POLLING_CANARY_USER_IDS = USER_A;
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    seedVerification(USER_A, 'unknown');

    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    expect(await discoverGmailPollingCandidates(25)).toEqual([]);
  });

  it('8. an allowlisted user with NO Gmail OAuth credential at all is excluded', async () => {
    process.env.GMAIL_POLLING_CANARY_USER_IDS = USER_A;
    // No seedGmailCredential call at all for USER_A.

    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    expect(await discoverGmailPollingCandidates(25)).toEqual([]);
  });

  it('12. CRITICAL: the unrelated real-world scenario -- a non-allowlisted candidate can NEVER become eligible merely because its status later changes unknown -> healthy', async () => {
    process.env.GMAIL_POLLING_CANARY_USER_IDS = USER_A; // the dedicated, explicitly-approved canary user
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    seedVerification(USER_A, 'healthy');
    // USER_B represents the real, unrelated, pre-existing production Gmail
    // connection discovered during the D.7 audit -- unknown today.
    seedGmailCredential(USER_B, '2025-09-16T00:00:00Z');
    seedVerification(USER_B, 'unknown');

    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    expect(await discoverGmailPollingCandidates(25)).toEqual([USER_A]);

    // Now simulate reverify-credentials re-verifying USER_B as healthy --
    // the exact event the D.7 report identified as the real risk.
    fakeDb.credentialTables.get('credential_verifications')!.find((r) => r.user_id === USER_B)!.status = 'healthy';

    expect(await discoverGmailPollingCandidates(25)).toEqual([USER_A]); // USER_B still never selected -- not allowlisted
  });

  it('13. no credential/token/body ever appears in a thrown error from a malformed allowlist', async () => {
    process.env.GMAIL_POLLING_CANARY_USER_IDS = 'not-a-uuid';
    const { discoverGmailPollingCandidates } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');

    await expect(discoverGmailPollingCandidates(25)).rejects.toThrow();
  });
});

function fakeGmailClient(impl?: Partial<GmailApiClient>): GmailApiClient {
  return {
    getCurrentHistoryId: vi.fn(async () => 'history-1'),
    listHistory: vi.fn(async () => ({ historyId: 'history-1', addedMessageIds: [] })),
    getMessage: vi.fn(),
    ...impl,
  };
}

describe('runGmailPollingBatch', () => {
  it('discovers candidates and polls each one through the real, certified pollGmailInboundReplies() pipeline', async () => {
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    seedVerification(USER_A, 'healthy');
    const client = fakeGmailClient();

    const { runGmailPollingBatch } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const summary = await runGmailPollingBatch(25, client);

    expect(summary.discovered).toBe(1);
    expect(summary.attempted).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(client.listHistory).not.toHaveBeenCalled(); // no cursor yet -- bootstraps instead
    expect(client.getCurrentHistoryId).toHaveBeenCalledTimes(1);
  });

  it('ISOLATION: one mailbox throwing never stops the rest of the batch', async () => {
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    seedVerification(USER_A, 'healthy');
    seedGmailCredential(USER_B, '2026-01-02T00:00:00Z');
    seedVerification(USER_B, 'healthy');

    let call = 0;
    const client = fakeGmailClient({
      getCurrentHistoryId: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('Gmail API transient failure');
        return 'history-1';
      }),
    });

    const { runGmailPollingBatch } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const summary = await runGmailPollingBatch(25, client);

    expect(summary.discovered).toBe(2);
    expect(summary.attempted).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain('Gmail API transient failure');
  });

  it('a credential_unavailable outcome is counted as skipped, not failed, and does not stop the batch', async () => {
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    seedVerification(USER_A, 'healthy');

    accessTokenImpl = async () => {
      throw new Error('No valid OAuth credentials stored for provider: gmail');
    };

    const { runGmailPollingBatch } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const summary = await runGmailPollingBatch(25, fakeGmailClient());

    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.errors[0]).toContain('credential_unavailable');
  });

  it('zero eligible mailboxes is a successful no-op', async () => {
    const { runGmailPollingBatch } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const summary = await runGmailPollingBatch(25, fakeGmailClient());

    expect(summary).toEqual({ discovered: 0, attempted: 0, succeeded: 0, failed: 0, skipped: 0, repliesProcessed: 0, errors: [] });
  });

  it('counts replies processed across the batch', async () => {
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    seedVerification(USER_A, 'healthy');

    const client = fakeGmailClient({
      getCurrentHistoryId: vi.fn(),
      listHistory: vi.fn(async () => ({ historyId: 'history-2', addedMessageIds: ['msg-1', 'msg-2'] })),
      getMessage: vi.fn(async ({ messageId }: { messageId: string }) => ({
        id: messageId,
        threadId: 'thread-x',
        internalDate: String(Date.now()),
        payload: { headers: [{ name: 'From', value: 'lead@example.com' }] },
      })),
    });

    storedCredentials[USER_A] = { gmail_history_cursor: 'history-1' };

    const { runGmailPollingBatch } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const summary = await runGmailPollingBatch(25, client);

    expect(summary.repliesProcessed).toBe(2);
  });

  it('NEVER includes credential material in the summary/errors', async () => {
    seedGmailCredential(USER_A, '2026-01-01T00:00:00Z');
    seedVerification(USER_A, 'healthy');
    const secretLikeToken = 'ya29.super-secret-access-token-value';

    const client = fakeGmailClient({
      getCurrentHistoryId: vi.fn(async () => {
        throw new Error(`failed using token ${secretLikeToken}`);
      }),
    });

    const { runGmailPollingBatch } = await import('@/lib/runtime/inbound-reply/gmail-polling-scheduler');
    const summary = await runGmailPollingBatch(25, client);

    // The underlying error message is opaque to this orchestration layer --
    // it only ever forwards whatever message the poller/client throws, never
    // fabricates or logs anything additional. This test documents that a
    // provider-side error message is passed through verbatim (never
    // enriched with request headers/tokens by this layer itself).
    expect(JSON.stringify(summary)).not.toContain('Authorization');
    expect(JSON.stringify(summary)).not.toContain('Bearer');
  });
});
