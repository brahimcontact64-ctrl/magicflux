import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Workflow #2 Phase D.4 -- direct unit coverage for gmail-send-adapter.ts's
 * own Message-ID metadata-fetch enrichment (previously only exercised
 * indirectly through fully-mocked callers). Verifies the degradation
 * semantics audited in Phase D.4's own report: a metadata-fetch failure
 * never fails the send, never blocks/duplicates it, and is now visible via
 * a structured, secret-free log line -- never the access token, never the
 * message body.
 */

const sendViaGmailApiMock = vi.fn();
vi.mock('@/lib/workflow-runtime/node-handlers/email', () => ({
  sendViaGmailApi: (...args: unknown[]) => sendViaGmailApiMock(...args),
}));

beforeEach(() => {
  vi.resetModules();
  sendViaGmailApiMock.mockReset();
});

const SEND_PARAMS = { accessToken: 'super-secret-access-token', to: 'lead@example.com', subject: 'Following up', body: 'Just checking in.' };

describe('gmailOutboundProviderClient.send -- Message-ID enrichment (Phase D.3/D.4)', () => {
  it('a successful send with a successful metadata fetch persists the real internet_message_id', async () => {
    sendViaGmailApiMock.mockResolvedValue({ ok: true, id: 'gmail-native-id', threadId: 'gmail-thread-id' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ payload: { headers: [{ name: 'Message-ID', value: '<real-id@mail.gmail.com>' }] } }),
    } as Response);

    const { gmailOutboundProviderClient } = await import('@/lib/runtime/inbound-reply/gmail-send-adapter');
    const result = await gmailOutboundProviderClient.send(SEND_PARAMS);

    expect(result).toEqual({ ok: true, providerMessageId: 'gmail-native-id', providerThreadId: 'gmail-thread-id', internetMessageId: '<real-id@mail.gmail.com>' });
    fetchSpy.mockRestore();
  });

  it('DEGRADATION: a metadata-fetch HTTP failure leaves internetMessageId null but the send still succeeds, and logs a secret-free warning', async () => {
    sendViaGmailApiMock.mockResolvedValue({ ok: true, id: 'gmail-native-id-2', threadId: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 } as Response);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { gmailOutboundProviderClient } = await import('@/lib/runtime/inbound-reply/gmail-send-adapter');
    const result = await gmailOutboundProviderClient.send(SEND_PARAMS);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.internetMessageId).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedArgs = warnSpy.mock.calls[0].map(String).join(' ');
    expect(loggedArgs).not.toContain(SEND_PARAMS.accessToken);
    expect(loggedArgs).not.toContain(SEND_PARAMS.body);
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('DEGRADATION: a metadata-fetch network exception leaves internetMessageId null but the send still succeeds, and logs a secret-free warning', async () => {
    sendViaGmailApiMock.mockResolvedValue({ ok: true, id: 'gmail-native-id-3', threadId: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { gmailOutboundProviderClient } = await import('@/lib/runtime/inbound-reply/gmail-send-adapter');
    const result = await gmailOutboundProviderClient.send(SEND_PARAMS);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.internetMessageId).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedArgs = warnSpy.mock.calls[0].map(String).join(' ');
    expect(loggedArgs).not.toContain(SEND_PARAMS.accessToken);
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('DEGRADATION: a missing/malformed Message-ID header in the metadata response leaves internetMessageId null and logs a warning', async () => {
    sendViaGmailApiMock.mockResolvedValue({ ok: true, id: 'gmail-native-id-4', threadId: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ payload: { headers: [] } }) } as Response);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { gmailOutboundProviderClient } = await import('@/lib/runtime/inbound-reply/gmail-send-adapter');
    const result = await gmailOutboundProviderClient.send(SEND_PARAMS);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.internetMessageId).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('a provider send failure never attempts the metadata fetch at all', async () => {
    sendViaGmailApiMock.mockResolvedValue({ ok: false, indeterminate: false, message: 'Gmail API returned 400' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { gmailOutboundProviderClient } = await import('@/lib/runtime/inbound-reply/gmail-send-adapter');
    const result = await gmailOutboundProviderClient.send(SEND_PARAMS);

    expect(result).toEqual({ ok: false, indeterminate: false, message: 'Gmail API returned 400' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('an indeterminate provider result never attempts the metadata fetch at all', async () => {
    sendViaGmailApiMock.mockResolvedValue({ ok: false, indeterminate: true, message: 'timed out' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { gmailOutboundProviderClient } = await import('@/lib/runtime/inbound-reply/gmail-send-adapter');
    const result = await gmailOutboundProviderClient.send(SEND_PARAMS);

    expect(result).toEqual({ ok: false, indeterminate: true, message: 'timed out' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('surrounding whitespace in the returned Message-ID header is canonicalized before being persisted', async () => {
    sendViaGmailApiMock.mockResolvedValue({ ok: true, id: 'gmail-native-id-5', threadId: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ payload: { headers: [{ name: 'Message-ID', value: '  <padded@mail.gmail.com>  ' }] } }),
    } as Response);

    const { gmailOutboundProviderClient } = await import('@/lib/runtime/inbound-reply/gmail-send-adapter');
    const result = await gmailOutboundProviderClient.send(SEND_PARAMS);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.internetMessageId).toBe('<padded@mail.gmail.com>');
    fetchSpy.mockRestore();
  });
});
