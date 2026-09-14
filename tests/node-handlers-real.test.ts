/**
 * Real (live-mode) node handler tests — Slack, Airtable, Gmail, HTTP.
 *
 * These handlers are what actually executes when a workflow runs in live
 * mode (lib/workflow-runtime/node-handlers/*.ts). Every external call is
 * mocked — no real network requests are made. Test-mode behavior is also
 * verified for each handler to guarantee it never reaches the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NodeHandlerContext, EngineNode } from '../lib/workflow-runtime/types';
import type { UserIntegration } from '../lib/user-integrations';

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(),
  },
}));

// These tests exercise HTTP handler mechanics (methods, headers, retries,
// credential injection) against fake hostnames like api.example.com that
// don't resolve — real SSRF-guard DNS lookups would block every one of them
// regardless of intent. SSRF *policy* is covered exhaustively in its own
// dedicated tests/ssrf-guard.test.ts (pure functions + mocked dns.lookup);
// the couple of SSRF-specific cases below override this mock per-test.
vi.mock('../lib/workflow-runtime/node-handlers/ssrf-guard', () => ({
  checkUrlSafe: vi.fn().mockResolvedValue({ allowed: true }),
  checkHostnameSafe: vi.fn().mockResolvedValue({ allowed: true }),
  isBlockedAddress: vi.fn().mockReturnValue(false),
}));

// httpHandler's SSRF-guarded fetch path reads bodies via res.body.getReader()
// (readBodyWithLimit), not res.json()/res.text() — the fixtures below back
// both so they work regardless of how the handler consumes the response.
function bodyStreamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  const text = JSON.stringify(body);
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(text),
    body: bodyStreamOf(text),
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      entries: () => Object.entries({ 'content-type': 'application/json' })[Symbol.iterator](),
    },
  } as unknown as Response;
}

function textResponse(body: string, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(body),
    body: bodyStreamOf(body),
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/plain' : null),
      entries: () => Object.entries({ 'content-type': 'text/plain' })[Symbol.iterator](),
    },
  } as unknown as Response;
}

function baseContext(overrides: Partial<NodeHandlerContext> = {}): NodeHandlerContext {
  return {
    mode: 'live',
    integrations: [],
    sampleData: {},
    previews: { emails: [], slackMessages: [], airtableRecords: [] },
    ...overrides,
  };
}

function integration(provider: string, credentials: Record<string, string>): UserIntegration {
  return { provider: provider as UserIntegration['provider'], credentials, status: 'connected' };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── Slack ─────────────────────────────────────────────────────────────────────

describe('slackHandler', () => {
  const node: EngineNode = { id: 'n1', name: 'Notify', type: 'n8n-nodes-base.slack', parameters: { channel: '#alerts', text: 'hello' } };

  it('test mode never calls the network and records a preview', async () => {
    const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
    const ctx = baseContext({ mode: 'test' });

    const result = await slackHandler(node, {}, ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('simulated_success');
    expect(ctx.previews?.slackMessages).toHaveLength(1);
  });

  it('sends via Slack Web API chat.postMessage with the bot token', async () => {
    const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, ts: '123.456' }));

    const ctx = baseContext({ integrations: [integration('slack', { bot_token: 'xoxb-test' })] });
    const result = await slackHandler(node, {}, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer xoxb-test');
    expect(JSON.parse(init.body)).toEqual({ channel: '#alerts', text: 'hello' });

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).ts).toBe('123.456');
  });

  it('falls back to a legacy incoming webhook when no bot token is present', async () => {
    const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
    fetchMock.mockResolvedValue(jsonResponse({}, { ok: true }));

    const ctx = baseContext({ integrations: [integration('slack', { webhook_url: 'https://hooks.slack.com/services/T/B/X' })] });
    const result = await slackHandler(node, {}, ctx);

    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.com/services/T/B/X', expect.objectContaining({ method: 'POST' }));
    expect(result.status).toBe('success');
  });

  it('fails when no Slack integration is connected', async () => {
    const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
    const result = await slackHandler(node, {}, baseContext());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Slack integration not configured');
  });

  it('fails when credentials have neither a bot token nor a webhook URL', async () => {
    const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
    const ctx = baseContext({ integrations: [integration('slack', {})] });
    const result = await slackHandler(node, {}, ctx);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Slack credentials incomplete');
  });

  it('surfaces a Slack API-level error (ok: false in the JSON body)', async () => {
    const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'channel_not_found' }));

    const ctx = baseContext({ integrations: [integration('slack', { bot_token: 'xoxb-test' })] });
    const result = await slackHandler(node, {}, ctx);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('channel_not_found');
  });

  it('surfaces a transport-level HTTP failure', async () => {
    const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
    fetchMock.mockResolvedValue(jsonResponse({}, { ok: false, status: 500 }));

    const ctx = baseContext({ integrations: [integration('slack', { bot_token: 'xoxb-test' })] });
    const result = await slackHandler(node, {}, ctx);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('500');
  });

  describe('Phase 9.9.4A -- embedded template interpolation', () => {
    it('interpolates an embedded {{$json["field"]}} reference in "text" before sending', async () => {
      const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
      fetchMock.mockResolvedValue(jsonResponse({ ok: true, ts: '1' }));
      const templated: EngineNode = { id: 'n2', name: 'Notify', type: 'n8n-nodes-base.slack', parameters: { channel: '#leads', text: 'New Hot lead: {{$json["name"]}}' } };

      const ctx = baseContext({ integrations: [integration('slack', { bot_token: 'xoxb-test' })] });
      const result = await slackHandler(templated, { name: 'Brahim' }, ctx);

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toBe('New Hot lead: Brahim');
      expect(result.status).toBe('success');
    });

    it('fails closed when the embedded reference names a field missing from the input -- never sends literal "undefined" text', async () => {
      const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
      const templated: EngineNode = { id: 'n3', name: 'Notify', type: 'n8n-nodes-base.slack', parameters: { channel: '#leads', text: 'Hello {{$json["missing"]}}' } };

      const ctx = baseContext({ integrations: [integration('slack', { bot_token: 'xoxb-test' })] });
      const result = await slackHandler(templated, { name: 'Brahim' }, ctx);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/missing/i);
    });

    it('a plain literal "text" with no template syntax still works unchanged', async () => {
      const { slackHandler } = await import('../lib/workflow-runtime/node-handlers/slack');
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

      const ctx = baseContext({ integrations: [integration('slack', { bot_token: 'xoxb-test' })] });
      const result = await slackHandler(node, {}, ctx);

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toBe('hello');
      expect(result.status).toBe('success');
    });
  });
});

// ─── Airtable ──────────────────────────────────────────────────────────────────

describe('airtableHandler', () => {
  const creds = { personal_access_token: 'pat-test', base_id: 'appXYZ' };

  function node(operation: string, extra: Record<string, unknown> = {}): EngineNode {
    return { id: 'n1', name: 'Records', type: 'n8n-nodes-base.airtable', parameters: { operation, tableId: 'tblABC', ...extra } };
  }

  it('test mode never calls the network and records a preview', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const ctx = baseContext({ mode: 'test' });

    const result = await airtableHandler(node('create'), { name: 'Ada' }, ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('simulated_success');
    expect(ctx.previews?.airtableRecords).toHaveLength(1);
  });

  it('list: queries the table and returns records', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({ records: [{ id: 'rec1' }, { id: 'rec2' }] }));

    const ctx = baseContext({ integrations: [integration('airtable', creds)] });
    const result = await airtableHandler(node('list', { filterFormula: "{Status}='Done'" }), {}, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('https://api.airtable.com/v0/appXYZ/tblABC');
    expect(String(url)).toContain('filterByFormula');
    expect(init.headers.Authorization).toBe('Bearer pat-test');
    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).airtable_records).toHaveLength(2);
  });

  it('get: fetches a single record by ID', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'rec1', fields: { Name: 'Ada' } }));

    const ctx = baseContext({ integrations: [integration('airtable', creds)] });
    const result = await airtableHandler(node('get', { recordId: 'rec1' }), {}, ctx);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.airtable.com/v0/appXYZ/tblABC/rec1',
      expect.objectContaining({ headers: { Authorization: 'Bearer pat-test' } }),
    );
    expect(result.status).toBe('success');
  });

  it('get/update/delete fail fast without a record ID', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const ctx = baseContext({ integrations: [integration('airtable', creds)] });

    const result = await airtableHandler(node('get'), {}, ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Airtable record ID missing');
  });

  it('create: POSTs strictly the configured "fields" mapping (Phase 9.9.4A), not raw upstream data', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW' }));

    const ctx = baseContext({ integrations: [integration('airtable', creds)] });
    const result = await airtableHandler(
      node('create', { fields: { Name: '={{$json["name"]}}' } }),
      { name: 'Ada', budget: 5000, internal_secret: 'nope' },
      ctx,
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.airtable.com/v0/appXYZ/tblABC');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).fields).toEqual({ Name: 'Ada' });
    expect((result.outputData as Record<string, unknown>).airtable_id).toBe('recNEW');
  });

  it('create with no "fields" configured at all sends an empty record -- never falls back to raw upstream data', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW' }));

    const ctx = baseContext({ integrations: [integration('airtable', creds)] });
    await airtableHandler(node('create'), { name: 'Ada' }, ctx);

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).fields).toEqual({});
  });

  it('update: PATCHes the given record', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'rec1' }));

    const ctx = baseContext({ integrations: [integration('airtable', creds)] });
    await airtableHandler(node('update', { recordId: 'rec1' }), { name: 'Ada 2' }, ctx);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.airtable.com/v0/appXYZ/tblABC/rec1');
    expect(init.method).toBe('PATCH');
  });

  it('delete: DELETEs the given record', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({}));

    const ctx = baseContext({ integrations: [integration('airtable', creds)] });
    const result = await airtableHandler(node('delete', { recordId: 'rec1' }), {}, ctx);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.airtable.com/v0/appXYZ/tblABC/rec1');
    expect(init.method).toBe('DELETE');
    expect((result.outputData as Record<string, unknown>).airtable_deleted_id).toBe('rec1');
  });

  it('falls back to the legacy airtable_token credential field', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW' }));

    const ctx = baseContext({ integrations: [integration('airtable', { airtable_token: 'legacy-key', base_id: 'appXYZ' })] });
    await airtableHandler(node('create'), { name: 'Ada' }, ctx);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer legacy-key');
  });

  it('fails when the Airtable integration is not connected', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    const result = await airtableHandler(node('create'), {}, baseContext());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Airtable integration not configured');
  });

  it('surfaces an Airtable API error', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(textResponse('INVALID_REQUEST', { ok: false, status: 422 }));

    const ctx = baseContext({ integrations: [integration('airtable', creds)] });
    const result = await airtableHandler(node('create'), {}, ctx);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('422');
  });

  // ─── Phase 9.9.3: canonical baseId/tableId, alias normalization, no
  //     account-wide override, cross-tenant credential isolation ─────────

  it('canonical node parameter generation: reads baseId/tableId directly (no credential fallback needed)', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW' }));

    const ctx = baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat-test', base_id: 'appACCOUNTWIDE00' })] });
    const result = await airtableHandler(
      { id: 'n2', name: 'Save', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', baseId: 'appPERWORKFLOW00', tableId: 'tblREAL0000000000' } },
      { name: 'Ada' },
      ctx,
    );

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/appPERWORKFLOW00/tblREAL0000000000');
    expect(result.status).toBe('success');
  });

  it('no account-wide single-base fallback overrides an explicitly configured per-workflow base', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW' }));

    // The connected account has its own base_id, but this node explicitly
    // configured a DIFFERENT one -- the explicit per-workflow value must win.
    const ctx = baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat-test', base_id: 'appACCOUNTWIDE00' })] });
    await airtableHandler(
      { id: 'n3', name: 'Save', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', baseId: 'appEXPLICIT000000', tableId: 'tblREAL0000000000' } },
      { name: 'Ada' },
      ctx,
    );

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/appEXPLICIT000000/');
    expect(String(url)).not.toContain('appACCOUNTWIDE00');
  });

  it('account-wide base_id is still used as a fallback when no per-workflow baseId is configured at all', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW' }));

    const ctx = baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat-test', base_id: 'appACCOUNTWIDE00' })] });
    await airtableHandler(
      { id: 'n4', name: 'Save', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', tableId: 'tblREAL0000000000' } },
      { name: 'Ada' },
      ctx,
    );

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/appACCOUNTWIDE00/');
  });

  it('no invented placeholder ids: a dead "application"/"applicationId" key from a pre-Phase-9.9.3 workflow is still read as a base id alias', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW' }));

    const ctx = baseContext({ integrations: [integration('airtable', { personal_access_token: 'pat-test' })] });
    await airtableHandler(
      { id: 'n5', name: 'Save', type: 'n8n-nodes-base.airtable', parameters: { operation: 'create', application: 'appLEGACYALIAS00', tableId: 'tblREAL0000000000' } },
      { name: 'Ada' },
      ctx,
    );

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/appLEGACYALIAS00/');
  });

  it('cross-tenant credential isolation: one user\'s airtableHandler call only ever uses THEIR OWN connected integration, never another tenant\'s', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW' }));

    // context.integrations is already scoped, per-request, to the calling
    // user (resolved upstream by resolveWorkflowIntegrations/getUserIntegrations)
    // -- this test locks in that the handler itself never reaches outside
    // the integrations array it was given, e.g. via a shared/global cache.
    const tenantAContext = baseContext({ integrations: [integration('airtable', { personal_access_token: 'tenant-a-token', base_id: 'appTENANTA000000' })] });
    const tenantBContext = baseContext({ integrations: [integration('airtable', { personal_access_token: 'tenant-b-token', base_id: 'appTENANTB000000' })] });

    await airtableHandler(node('create'), { name: 'A' }, tenantAContext);
    await airtableHandler(node('create'), { name: 'B' }, tenantBContext);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tenant-a-token');
    expect(String(fetchMock.mock.calls[0][0])).toContain('appTENANTA000000');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer tenant-b-token');
    expect(String(fetchMock.mock.calls[1][0])).toContain('appTENANTB000000');
  });
});

// ─── Gmail (email.ts) ────────────────────────────────────────────────────────

describe('emailHandler', () => {
  const node: EngineNode = { id: 'n1', name: 'Send', type: 'n8n-nodes-base.gmail', parameters: { to: 'user@example.com', subject: 'Hi', text: 'Body text' } };

  it('test mode never calls the network and records a preview', async () => {
    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const ctx = baseContext({ mode: 'test' });

    const result = await emailHandler(node, {}, ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('simulated_success');
    expect(ctx.previews?.emails).toHaveLength(1);
  });

  it('sends via the Gmail API using the OAuth access token, with a correctly-encoded MIME payload', async () => {
    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'msg-1' }));

    const ctx = baseContext({ integrations: [integration('gmail', { access_token: 'ya29.token' })] });
    const result = await emailHandler(node, {}, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(init.headers.Authorization).toBe('Bearer ya29.token');

    const raw = JSON.parse(init.body).raw as string;
    const mime = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(mime).toContain('To: user@example.com');
    expect(mime).toContain('Subject: Hi');
    expect(mime).toContain('Body text');

    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).messageId).toBe('msg-1');
  });

  it('surfaces a Gmail API error', async () => {
    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    fetchMock.mockResolvedValue(textResponse('invalid_grant', { ok: false, status: 401 }));

    const ctx = baseContext({ integrations: [integration('gmail', { access_token: 'expired' })] });
    const result = await emailHandler(node, {}, ctx);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('401');
  });

  it('fails when no Gmail or legacy email integration is connected', async () => {
    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const result = await emailHandler(node, {}, baseContext());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Email integration not configured');
  });

  it('falls back to legacy SMTP delivery when no Gmail OAuth token is present', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'smtp-1' });
    const nodemailer = (await import('nodemailer')).default;
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const ctx = baseContext({
      integrations: [integration('email', { smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })],
    });

    const result = await emailHandler(node, {}, ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledOnce();
    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).messageId).toBe('smtp-1');
  });

  // Phase 9.8.5 -- lib/user-integrations.ts's getUserIntegrations() now
  // canonicalizes a stored 'email' row to provider 'gmail' at load time (so
  // Builder readiness and runtime resolution both recognize it as
  // satisfying a required 'gmail'), so this same legacy SMTP credential can
  // arrive here labeled 'gmail' instead of 'email'. The handler must still
  // use it via SMTP -- distinguishing by credential shape (smtp_host vs
  // access_token), not by provider label alone.
  it('sends via legacy SMTP delivery even when that same credential is labeled "gmail" (post-canonicalization)', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'smtp-2' });
    const nodemailer = (await import('nodemailer')).default;
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

    const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
    const ctx = baseContext({
      integrations: [integration('gmail', { smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })],
    });

    const result = await emailHandler(node, {}, ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledOnce();
    expect(result.status).toBe('success');
    expect((result.outputData as Record<string, unknown>).messageId).toBe('smtp-2');
  });

  // Phase 9.8.7 -- production incident: a real live execution's generic
  // trigger sample data ({name:'Test User', email:'test@example.com', ...})
  // never influenced the actual send, because static node parameters
  // already won -- these tests pin that precedence as an explicit,
  // permanent regression guarantee (requirement #5/#6/#7 of Phase 9.8.7).
  describe('static node parameters remain authoritative over runtime trigger input', () => {
    it('#6: an unrelated/malicious trigger payload cannot override a static recipient', async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: 'static-1' });
      const nodemailer = (await import('nodemailer')).default;
      vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

      const staticNode: EngineNode = {
        id: 'n1', name: 'Send Email', type: 'n8n-nodes-base.gmail',
        parameters: { to: 'nssmpro@gmail.com', subject: 'MagicFlux Real Workflow Test', message: 'Hello Nassim!' },
      };
      const ctx = baseContext({ integrations: [integration('email', { smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })] });

      const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
      const result = await emailHandler(staticNode, { email: 'attacker@evil.com', name: 'Attacker' }, ctx);

      expect((result.outputData as Record<string, unknown>).sent_to).toBe('nssmpro@gmail.com');
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'nssmpro@gmail.com' }));
    });

    it('#7: the exact production scenario -- generic sample data ({name, email, message}) cannot alter static recipient/subject/body', async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: 'static-2' });
      const nodemailer = (await import('nodemailer')).default;
      vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

      const staticNode: EngineNode = {
        id: 'n1', name: 'Send Email', type: 'n8n-nodes-base.gmail',
        parameters: { to: 'nssmpro@gmail.com', subject: 'MagicFlux Real Workflow Test', message: 'Hello Nassim! This email was sent automatically by MagicFlux' },
      };
      const genericSampleData = { name: 'Test User', email: 'test@example.com', message: 'This is a test event' };
      const ctx = baseContext({ integrations: [integration('email', { smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })] });

      const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
      const result = await emailHandler(staticNode, genericSampleData, ctx);
      const output = result.outputData as Record<string, unknown>;

      expect(output.sent_to).toBe('nssmpro@gmail.com');
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
        to: 'nssmpro@gmail.com',
        subject: 'MagicFlux Real Workflow Test',
        text: 'Hello Nassim! This email was sent automatically by MagicFlux',
      }));
    });
  });

  // Phase 9.8.7 -- narrow ={{$json["field"]}} expression support, mirroring
  // condition.ts's existing (Phase 9.8.2) narrow resolver exactly (shared
  // module: lib/workflow-runtime/node-handlers/json-field-reference.ts).
  describe('narrow ={{$json["field"]}} expression support (Phase 9.8.7)', () => {
    it('a node explicitly using the narrow expression syntax resolves against trigger data', async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: 'expr-1' });
      const nodemailer = (await import('nodemailer')).default;
      vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

      const exprNode: EngineNode = {
        id: 'n1', name: 'Send Email', type: 'n8n-nodes-base.gmail',
        parameters: { to: '={{$json["email"]}}', subject: '={{$json.subject}}', message: 'Static body' },
      };
      const ctx = baseContext({ integrations: [integration('email', { smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })] });

      const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
      const result = await emailHandler(exprNode, { email: 'dynamic-recipient@example.org', subject: 'Dynamic Subject' }, ctx);
      const output = result.outputData as Record<string, unknown>;

      expect(output.sent_to).toBe('dynamic-recipient@example.org');
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'dynamic-recipient@example.org', subject: 'Dynamic Subject', text: 'Static body' }));
    });

    it('a static literal is never affected by the expression resolver (does not accidentally match)', async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: 'expr-2' });
      const nodemailer = (await import('nodemailer')).default;
      vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

      const staticNode: EngineNode = {
        id: 'n1', name: 'Send Email', type: 'n8n-nodes-base.gmail',
        parameters: { to: 'nssmpro@gmail.com', subject: 'MagicFlux Real Workflow Test', message: 'Hello Nassim!' },
      };
      const ctx = baseContext({ integrations: [integration('email', { smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })] });

      const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
      const result = await emailHandler(staticNode, { email: 'someone-else@example.org' }, ctx);
      expect((result.outputData as Record<string, unknown>).sent_to).toBe('nssmpro@gmail.com');
    });
  });

  describe('Phase 9.9.4A -- embedded template interpolation (subject/body)', () => {
    function smtpCtx() {
      return baseContext({ integrations: [integration('email', { smtp_host: 'smtp.test.com', smtp_port: '587', smtp_user: 'u', smtp_pass: 'p', from_email: 'from@test.com' })] });
    }

    it('interpolates an embedded reference in the subject', async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: 'tpl-1' });
      const nodemailer = (await import('nodemailer')).default;
      vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

      const templated: EngineNode = { id: 'n9', name: 'Send', type: 'n8n-nodes-base.gmail', parameters: { to: 'b@example.com', subject: 'New {{$json["classification"]}} Lead', text: 'x' } };
      const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
      await emailHandler(templated, { classification: 'Hot' }, smtpCtx());

      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'New Hot Lead' }));
    });

    it('interpolates one or more embedded references in the body', async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: 'tpl-2' });
      const nodemailer = (await import('nodemailer')).default;
      vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

      const templated: EngineNode = {
        id: 'n10', name: 'Send', type: 'n8n-nodes-base.gmail',
        parameters: { to: 'b@example.com', subject: 'x', text: 'We have a new {{$json["classification"]}} lead: {{$json["name"]}}' },
      };
      const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
      await emailHandler(templated, { classification: 'Warm', name: 'Ada' }, smtpCtx());

      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: 'We have a new Warm lead: Ada' }));
    });

    it('a whole-value expression subject still resolves to its native-type string form', async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: 'tpl-3' });
      const nodemailer = (await import('nodemailer')).default;
      vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

      const templated: EngineNode = { id: 'n11', name: 'Send', type: 'n8n-nodes-base.gmail', parameters: { to: 'b@example.com', subject: '={{$json["subjectLine"]}}', text: 'x' } };
      const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
      await emailHandler(templated, { subjectLine: 'Exact Subject' }, smtpCtx());

      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Exact Subject' }));
    });

    it('fails closed (never sends) when a subject reference is missing from the input', async () => {
      const sendMail = vi.fn();
      const nodemailer = (await import('nodemailer')).default;
      vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

      const templated: EngineNode = { id: 'n12', name: 'Send', type: 'n8n-nodes-base.gmail', parameters: { to: 'b@example.com', subject: 'Re: {{$json["missing"]}}', text: 'x' } };
      const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
      const result = await emailHandler(templated, {}, smtpCtx());

      expect(sendMail).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/missing/i);
    });

    it('recipient ("to") resolution is unchanged -- still whole-value only, not embedded-template', async () => {
      const sendMail = vi.fn().mockResolvedValue({ messageId: 'tpl-4' });
      const nodemailer = (await import('nodemailer')).default;
      vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as never);

      // An embedded-style "to" is NOT a supported recipient shape (recipient
      // behavior is explicitly unchanged) -- it is used as a literal string.
      const templated: EngineNode = { id: 'n13', name: 'Send', type: 'n8n-nodes-base.gmail', parameters: { to: 'Contact: {{$json["email"]}}', subject: 'x', text: 'x' } };
      const { emailHandler } = await import('../lib/workflow-runtime/node-handlers/email');
      await emailHandler(templated, { email: 'ignored@example.com' }, smtpCtx());

      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'Contact: {{$json["email"]}}' }));
    });
  });
});

// ─── Shopify ───────────────────────────────────────────────────────────────────

describe('shopifyHandler', () => {
  // node.type must contain "order" — that substring is what routes shopifyHandler
  // to the real fetch() call internally (see lib/workflow-runtime/node-handlers/shopify.ts).
  const node: EngineNode = { id: 'n1', name: 'Get Order', type: 'n8n-nodes-base.shopifyOrder', parameters: { orderId: '123' } };

  it('test mode never calls the network', async () => {
    const { shopifyHandler } = await import('../lib/workflow-runtime/node-handlers/shopify');
    const result = await shopifyHandler(node, {}, baseContext({ mode: 'test' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('simulated_success');
  });

  it('reads the access_token field used by lib/credentials/provider-registry.ts', async () => {
    const { shopifyHandler } = await import('../lib/workflow-runtime/node-handlers/shopify');
    fetchMock.mockResolvedValue(jsonResponse({ order: { id: '123' } }));

    const ctx = baseContext({ integrations: [integration('shopify', { shop_domain: 'store.myshopify.com', access_token: 'shpat_new' })] });
    const result = await shopifyHandler(node, { order_id: '123' }, ctx);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('store.myshopify.com');
    expect(init.headers['X-Shopify-Access-Token']).toBe('shpat_new');
    expect(result.status).toBe('success');
  });

  it('falls back to the legacy admin_access_token field', async () => {
    const { shopifyHandler } = await import('../lib/workflow-runtime/node-handlers/shopify');
    fetchMock.mockResolvedValue(jsonResponse({ order: { id: '123' } }));

    const ctx = baseContext({ integrations: [integration('shopify', { shop_domain: 'store.myshopify.com', admin_access_token: 'shpat_legacy' })] });
    await shopifyHandler(node, { order_id: '123' }, ctx);

    expect(fetchMock.mock.calls[0][1].headers['X-Shopify-Access-Token']).toBe('shpat_legacy');
  });

  it('fails when Shopify credentials are incomplete', async () => {
    const { shopifyHandler } = await import('../lib/workflow-runtime/node-handlers/shopify');
    const ctx = baseContext({ integrations: [integration('shopify', { shop_domain: 'store.myshopify.com' })] });
    const result = await shopifyHandler(node, {}, ctx);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
  });
});

// ─── HTTP ──────────────────────────────────────────────────────────────────────

describe('httpHandler', () => {
  function node(overrides: Record<string, unknown> = {}): EngineNode {
    return { id: 'n1', name: 'Call API', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://api.example.com/data', method: 'GET', ...overrides } };
  }

  it('test mode never calls the network', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    const result = await httpHandler(node(), {}, baseContext({ mode: 'test' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('simulated_success');
  });

  it('GET: issues a request with no body', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    const result = await httpHandler(node(), {}, baseContext());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/data');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(result.status).toBe('success');
  });

  it('POST: sends a JSON body with a default Content-Type header', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(jsonResponse({ created: true }, { status: 201 }));

    await httpHandler(node({ method: 'POST', body: { name: 'Ada' } }), {}, baseContext());

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'Ada' });
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('PUT: sends a JSON body', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(jsonResponse({}));

    await httpHandler(node({ method: 'PUT', body: { name: 'Ada 2' } }), {}, baseContext());

    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
  });

  it('DELETE: issues a request with no body by default', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(jsonResponse({}));

    await httpHandler(node({ method: 'DELETE' }), {}, baseContext());

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('DELETE');
  });

  it('passes through custom headers', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(jsonResponse({}));

    await httpHandler(node({ headers: { 'X-Api-Key': 'secret' } }), {}, baseContext());

    expect(fetchMock.mock.calls[0][1].headers['X-Api-Key']).toBe('secret');
  });

  it('parses a JSON response body', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(jsonResponse({ hello: 'world' }));

    const result = await httpHandler(node(), {}, baseContext());
    expect((result.outputData as Record<string, unknown>).body).toEqual({ hello: 'world' });
  });

  it('parses a text response body', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(textResponse('plain text body'));

    const result = await httpHandler(node(), {}, baseContext());
    expect((result.outputData as Record<string, unknown>).body).toBe('plain text body');
  });

  it('retries a 503 and succeeds on the next attempt', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await httpHandler(node(), {}, baseContext());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('success');
  }, 10000);

  it('retries on a network error and succeeds on the next attempt', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await httpHandler(node(), {}, baseContext());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('success');
  }, 10000);

  it('does not retry a plain 404', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(jsonResponse({ error: 'not found' }, { ok: false, status: 404 }));

    const result = await httpHandler(node(), {}, baseContext());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('404');
  });

  it('fails after exhausting all retry attempts', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(jsonResponse({}, { ok: false, status: 500 }));

    const result = await httpHandler(node(), {}, baseContext());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('500');
  }, 10000);

  it('reports a timeout as an AbortError with a descriptive message', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const result = await httpHandler(node({ timeout: 100 }), {}, baseContext());

    expect(result.status).toBe('failed');
    expect(result.error).toContain('timed out');
  }, 10000);

  it('blocks the request and never calls fetch when the SSRF guard rejects the target', async () => {
    const { checkUrlSafe } = await import('../lib/workflow-runtime/node-handlers/ssrf-guard');
    vi.mocked(checkUrlSafe).mockResolvedValueOnce({ allowed: false, reason: 'Host resolves to 169.254.169.254, which is in a blocked private/internal address range' });

    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    const result = await httpHandler(node({ url: 'http://metadata.internal/latest/meta-data' }), {}, baseContext());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Blocked by SSRF protection');
    expect(result.error).toContain('169.254.169.254');
  });

  it('fails immediately when no url is provided', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    const result = await httpHandler(node({ url: '' }), {}, baseContext());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.error).toBe('url is required');
  });

  // ── Generic/custom API-key credential injection ──────────────────────────

  it('injects a connected custom credential into the configured header, with prefix', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(jsonResponse({}));

    const ctx = baseContext({
      integrations: [integration('custom', { name: 'Internal API', header_name: 'Authorization', prefix: 'Bearer', api_key: 'secret-token-123' })],
    });
    await httpHandler(node(), {}, ctx);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer secret-token-123');
  });

  it('injects a custom credential without a prefix as the raw value', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(jsonResponse({}));

    const ctx = baseContext({
      integrations: [integration('custom', { name: 'Internal API', header_name: 'X-API-Key', api_key: 'raw-key-value' })],
    });
    await httpHandler(node(), {}, ctx);

    expect(fetchMock.mock.calls[0][1].headers['X-API-Key']).toBe('raw-key-value');
  });

  it('does not override a header the node already set explicitly', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(jsonResponse({}));

    const ctx = baseContext({
      integrations: [integration('custom', { name: 'Internal API', header_name: 'Authorization', prefix: 'Bearer', api_key: 'secret-token-123' })],
    });
    await httpHandler(node({ headers: { Authorization: 'Basic manual-override' } }), {}, ctx);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Basic manual-override');
  });

  it('works with manually-entered headers when no custom credential is connected (backward compatible)', async () => {
    const { httpHandler } = await import('../lib/workflow-runtime/node-handlers/http');
    fetchMock.mockResolvedValue(jsonResponse({}));

    const result = await httpHandler(node({ headers: { 'X-Manual': 'value' } }), {}, baseContext());

    expect(fetchMock.mock.calls[0][1].headers['X-Manual']).toBe('value');
    expect(result.status).toBe('success');
  });
});
