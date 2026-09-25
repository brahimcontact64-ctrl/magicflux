import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.stubEnv('MAGICFLUX_ENABLE_FOLLOWUP_SEND_STAGING_CERTIFICATION', '');
  vi.stubEnv('VERCEL_ENV', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('production-guard', () => {
  it('1. PRODUCTION-TARGET GUARD: refuses a URL matching the known production project ref', async () => {
    const { assertLocalSupabaseTarget, ProductionTargetError, PRODUCTION_PROJECT_REF } = await import('../scripts/phase-d/production-guard');
    expect(() => assertLocalSupabaseTarget(`https://${PRODUCTION_PROJECT_REF}.supabase.co`)).toThrow(ProductionTargetError);
  });

  it('refuses an unrecognized non-local host just as strictly (fail-closed, not a deny-list of one known bad value)', async () => {
    const { assertLocalSupabaseTarget, ProductionTargetError } = await import('../scripts/phase-d/production-guard');
    expect(() => assertLocalSupabaseTarget('https://some-other-cloud-project.supabase.co')).toThrow(ProductionTargetError);
  });

  it('refuses an empty/missing URL', async () => {
    const { assertLocalSupabaseTarget, ProductionTargetError } = await import('../scripts/phase-d/production-guard');
    expect(() => assertLocalSupabaseTarget(undefined)).toThrow(ProductionTargetError);
  });

  it('2. LOCAL TARGET ACCEPTED: a real local Supabase URL (127.0.0.1) passes', async () => {
    const { assertLocalSupabaseTarget } = await import('../scripts/phase-d/production-guard');
    expect(() => assertLocalSupabaseTarget('http://127.0.0.1:54321')).not.toThrow();
    expect(() => assertLocalSupabaseTarget('http://localhost:54321')).not.toThrow();
  });
});

describe('follow-up-send staging node availability', () => {
  it('3. DEFAULT BLOCKED: with no flag set, followUpSend remains blocked', async () => {
    vi.resetModules();
    const { checkNodeCapability, FOLLOW_UP_SEND_NODE_TYPE } = await import('@/lib/workflow-runtime/node-capabilities');
    const result = checkNodeCapability({ type: FOLLOW_UP_SEND_NODE_TYPE });
    expect(result.capable).toBe(false);
  });

  it('4. EXPLICIT LOCAL CERTIFICATION FLAG ENABLES: flag=true and no production markers -> capable', async () => {
    vi.resetModules();
    vi.stubEnv('MAGICFLUX_ENABLE_FOLLOWUP_SEND_STAGING_CERTIFICATION', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    const { checkNodeCapability, FOLLOW_UP_SEND_NODE_TYPE } = await import('@/lib/workflow-runtime/node-capabilities');
    const result = checkNodeCapability({ type: FOLLOW_UP_SEND_NODE_TYPE });
    expect(result.capable).toBe(true);
  });

  it('5a. PRODUCTION CANNOT ENABLE (NODE_ENV): flag=true but NODE_ENV=production -> still blocked', async () => {
    vi.resetModules();
    vi.stubEnv('MAGICFLUX_ENABLE_FOLLOWUP_SEND_STAGING_CERTIFICATION', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    const { checkNodeCapability, FOLLOW_UP_SEND_NODE_TYPE } = await import('@/lib/workflow-runtime/node-capabilities');
    const result = checkNodeCapability({ type: FOLLOW_UP_SEND_NODE_TYPE });
    expect(result.capable).toBe(false);
  });

  it('5b. PRODUCTION CANNOT ENABLE (VERCEL_ENV): flag=true but VERCEL_ENV=production -> still blocked', async () => {
    vi.resetModules();
    vi.stubEnv('MAGICFLUX_ENABLE_FOLLOWUP_SEND_STAGING_CERTIFICATION', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL_ENV', 'production');
    const { checkNodeCapability, FOLLOW_UP_SEND_NODE_TYPE } = await import('@/lib/workflow-runtime/node-capabilities');
    const result = checkNodeCapability({ type: FOLLOW_UP_SEND_NODE_TYPE });
    expect(result.capable).toBe(false);
  });

  it('NODE_ENV=development ALONE (no explicit flag) never enables the node -- the explicit flag is mandatory', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'development');
    const { checkNodeCapability, FOLLOW_UP_SEND_NODE_TYPE } = await import('@/lib/workflow-runtime/node-capabilities');
    const result = checkNodeCapability({ type: FOLLOW_UP_SEND_NODE_TYPE });
    expect(result.capable).toBe(false);
  });

  it('capability metadata remains truthful: the bypass is scoped to exactly one rule, every other blocklist entry is unaffected', async () => {
    vi.resetModules();
    vi.stubEnv('MAGICFLUX_ENABLE_FOLLOWUP_SEND_STAGING_CERTIFICATION', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    const { checkNodeCapability } = await import('@/lib/workflow-runtime/node-capabilities');
    // HubSpot/Twilio/Google Sheets/code-execution remain blocked regardless of this unrelated flag.
    expect(checkNodeCapability({ type: 'n8n-nodes-base.hubspot' }).capable).toBe(false);
    expect(checkNodeCapability({ type: 'n8n-nodes-base.twilio' }).capable).toBe(false);
    expect(checkNodeCapability({ type: 'n8n-nodes-base.code' }).capable).toBe(false);
  });
});

// ── Fake DB for seed-staging-data.ts (workflows + runtime_* tables + auth.admin) ──

type Row = Record<string, unknown>;
function makeSeedFakeDb() {
  const tables: Record<string, Row[]> = { workflows: [], runtime_conversations: [], runtime_followup_sequences: [] };
  const authUsers: Row[] = [];

  function builder(table: string) {
    const rows = tables[table];
    let mode: 'select' | 'insert' = 'select';
    let insertPayload: Row | null = null;
    const filters: Array<[string, unknown]> = [];
    const api: Record<string, unknown> = {
      select() { return api; },
      insert(payload: Row) { mode = 'insert'; insertPayload = payload; return api; },
      eq(col: string, val: unknown) { filters.push([col, val]); return api; },
      maybeSingle: async () => {
        if (mode === 'insert' && insertPayload) {
          const row = { id: `row-${rows.length + 1}`, ...insertPayload };
          rows.push(row);
          return { data: row, error: null };
        }
        const found = rows.find((r) => filters.every(([c, v]) => r[c] === v));
        return { data: found ?? null, error: null };
      },
      single: async () => {
        if (mode === 'insert' && insertPayload) {
          const row = { id: `row-${rows.length + 1}`, ...insertPayload };
          rows.push(row);
          return { data: row, error: null };
        }
        return { data: null, error: { message: 'not found' } };
      },
    };
    return api;
  }

  return {
    from: (table: string) => builder(table),
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: authUsers as Array<{ id: string; email: string }> }, error: null }),
        createUser: async (params: { email: string }) => {
          const user = { id: `user-${authUsers.length + 1}`, email: params.email };
          authUsers.push(user);
          return { data: { user }, error: null };
        },
      },
    },
    __tables: tables,
    __authUsers: authUsers,
  };
}

describe('staging data seed', () => {
  it('6. LOCAL SEED ISOLATION: creates a distinctly-marked synthetic user/workflow/conversation/sequence', async () => {
    const { seedPhaseDStagingData, PHASE_D_STAGING_MARKER } = await import('../scripts/phase-d/seed-staging-data');
    const db = makeSeedFakeDb();

    const result = await seedPhaseDStagingData(db as never);

    expect(result.userId).toBeTruthy();
    expect(result.sequenceId).toBeTruthy();
    const workflow = db.__tables.workflows[0];
    expect(String(workflow.name)).toContain(PHASE_D_STAGING_MARKER);
    const conversation = db.__tables.runtime_conversations[0];
    expect(String(conversation.entity_reference)).toBe(PHASE_D_STAGING_MARKER);
  });

  it('7. NO WORKFLOW #1 IDENTIFIERS: the seed never references Sigma Plus or any hard-coded production workflow id', async () => {
    const { seedPhaseDStagingData } = await import('../scripts/phase-d/seed-staging-data');
    const db = makeSeedFakeDb();

    const result = await seedPhaseDStagingData(db as never);

    const serialized = JSON.stringify({ result, tables: db.__tables });
    expect(serialized.toLowerCase()).not.toContain('sigma');
    expect(serialized).not.toContain('d64074c8-c28c-42db-bed6-2ac32b60295e');
  });

  it('10. DUPLICATE STAGING SEED IS IDEMPOTENT: running the seed twice against the same DB reuses the existing fixture, no duplicate rows', async () => {
    const { seedPhaseDStagingData } = await import('../scripts/phase-d/seed-staging-data');
    const db = makeSeedFakeDb();

    const first = await seedPhaseDStagingData(db as never);
    const second = await seedPhaseDStagingData(db as never);

    expect(second).toEqual(first);
    expect(db.__tables.workflows.length).toBe(1);
    expect(db.__tables.runtime_conversations.length).toBe(1);
    expect(db.__tables.runtime_followup_sequences.length).toBe(1);
    expect(db.__authUsers.length).toBe(1);
  });
});

describe('certification harness -- safety properties', () => {
  it('8. HARNESS REDACTS SECRETS: the send stage never logs an access token', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.doMock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn() }));
    vi.doMock('@/lib/runtime/inbound-reply/send-followup', () => ({
      sendFollowupMessage: vi.fn(async () => ({ outcome: 'sent', outboundMessageId: 'out-1', providerMessageId: 'msg-1', providerThreadId: 'thread-1', sentDuringRaceWindow: false })),
    }));
    vi.doMock('@/lib/runtime/inbound-reply/storage', () => ({ getFollowupSequenceForOwner: vi.fn(async () => null) }));
    vi.resetModules();

    const secretToken = 'ya29.SUPER_SECRET_ACCESS_TOKEN_do_not_log';
    const { runSendStage } = await import('../scripts/phase-d/certification-harness');

    await runSendStage({
      supabaseUrl: 'http://127.0.0.1:54321',
      sequenceId: 'seq-1',
      userId: 'user-1',
      executionId: 'exec-1',
      conversationId: 'conv-1',
      to: 'test@example.com',
      provider: { provider: 'gmail', send: vi.fn() },
      getAccessToken: async () => secretToken,
    });

    const allLoggedText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLoggedText).not.toContain(secretToken);
    logSpy.mockRestore();
    vi.doUnmock('@/lib/supabase-server');
    vi.doUnmock('@/lib/runtime/inbound-reply/send-followup');
    vi.doUnmock('@/lib/runtime/inbound-reply/storage');
  });

  it('9. HARNESS DOES NOT LOG MESSAGE BODY: the send stage never logs the certification email body text', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let capturedBody: string | null = null;
    vi.doMock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn() }));
    vi.doMock('@/lib/runtime/inbound-reply/send-followup', () => ({
      sendFollowupMessage: vi.fn(async (request: { body: string }) => {
        capturedBody = request.body;
        return { outcome: 'sent', outboundMessageId: 'out-1', providerMessageId: 'msg-1', providerThreadId: 'thread-1', sentDuringRaceWindow: false };
      }),
    }));
    vi.doMock('@/lib/runtime/inbound-reply/storage', () => ({ getFollowupSequenceForOwner: vi.fn(async () => null) }));
    vi.resetModules();

    const { runSendStage } = await import('../scripts/phase-d/certification-harness');
    await runSendStage({
      supabaseUrl: 'http://127.0.0.1:54321',
      sequenceId: 'seq-1',
      userId: 'user-1',
      executionId: 'exec-1',
      conversationId: 'conv-1',
      to: 'test@example.com',
      provider: { provider: 'gmail', send: vi.fn() },
      getAccessToken: async () => 'token',
    });

    expect(capturedBody).toBeTruthy();
    const allLoggedText = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLoggedText).not.toContain(String(capturedBody));
    logSpy.mockRestore();
    vi.doUnmock('@/lib/supabase-server');
    vi.doUnmock('@/lib/runtime/inbound-reply/send-followup');
    vi.doUnmock('@/lib/runtime/inbound-reply/storage');
  });

  it('11. HARNESS PAUSES SAFELY: the reply-check stage returns "awaiting_reply" (not an error, not a hang) when nothing has arrived yet', async () => {
    vi.doMock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn() }));
    vi.doMock('@/lib/runtime/inbound-reply/gmail-poll', () => ({
      pollGmailInboundReplies: vi.fn(async () => ({ outcome: 'processed', messageResults: [] })),
    }));
    vi.doMock('@/lib/runtime/inbound-reply/storage', () => ({ getFollowupSequenceForOwner: vi.fn(async () => null) }));
    vi.resetModules();

    const { runReplyCheckStage } = await import('../scripts/phase-d/certification-harness');
    const result = await runReplyCheckStage({
      supabaseUrl: 'http://127.0.0.1:54321',
      userId: 'user-1',
      executionId: 'exec-1',
      sequenceId: 'seq-1',
      conversationId: 'conv-1',
      gmailClient: { getCurrentHistoryId: vi.fn(), listHistory: vi.fn(), getMessage: vi.fn() },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe('awaiting_reply');
    vi.doUnmock('@/lib/supabase-server');
    vi.doUnmock('@/lib/runtime/inbound-reply/gmail-poll');
    vi.doUnmock('@/lib/runtime/inbound-reply/storage');
  });

  it('12. NO REAL GMAIL CALLS: the certification harness itself never imports a concrete Gmail/provider client -- every stage takes one as an explicit parameter', async () => {
    // Structural guarantee on the HARNESS's own source (not this test
    // file's prose, which legitimately names these symbols in comments):
    // certification-harness.ts must depend-inject its provider/Gmail
    // client via function parameters, never import a concrete
    // implementation (realGmailApiClient / gmailOutboundProviderClient) to
    // call directly itself.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const harnessPath = path.resolve(__dirname, '../scripts/phase-d/certification-harness.ts');
    const source = fs.readFileSync(harnessPath, 'utf8');
    const concreteImportPattern = /import\s*\{[^}]*\b(realGmailApiClient|gmailOutboundProviderClient)\b[^}]*\}\s*from/;
    expect(concreteImportPattern.test(source)).toBe(false);
  });
});
