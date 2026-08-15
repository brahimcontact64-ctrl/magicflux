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

  it('create: POSTs the input data as fields and returns the new record id', async () => {
    const { airtableHandler } = await import('../lib/workflow-runtime/node-handlers/airtable');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'recNEW' }));

    const ctx = baseContext({ integrations: [integration('airtable', creds)] });
    const result = await airtableHandler(node('create'), { name: 'Ada' }, ctx);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.airtable.com/v0/appXYZ/tblABC');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).fields.name).toBe('Ada');
    expect((result.outputData as Record<string, unknown>).airtable_id).toBe('recNEW');
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
