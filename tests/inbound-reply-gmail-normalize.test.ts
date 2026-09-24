import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { normalizeGmailMessage } from '@/lib/runtime/inbound-reply/gmail-normalize';

describe('normalizeGmailMessage', () => {
  it('extracts thread id, In-Reply-To, and References from a well-formed message', () => {
    const event = normalizeGmailMessage({
      id: 'gmail-msg-1',
      threadId: 'gmail-thread-1',
      internalDate: '1700000000000',
      payload: {
        headers: [
          { name: 'From', value: 'Jane Prospect <jane@customer-example.com>' },
          { name: 'In-Reply-To', value: '<out-1@magicflux.mail>' },
          { name: 'References', value: '<out-0@magicflux.mail> <out-1@magicflux.mail>' },
        ],
      },
    });

    expect(event.provider).toBe('gmail');
    expect(event.providerMessageId).toBe('gmail-msg-1');
    expect(event.providerThreadId).toBe('gmail-thread-1');
    expect(event.inReplyTo).toBe('<out-1@magicflux.mail>');
    expect(event.references).toBe('<out-0@magicflux.mail> <out-1@magicflux.mail>');
    expect(event.receivedAt).toBe(new Date(1700000000000).toISOString());
  });

  it('never includes the plaintext sender address -- only a domain and a one-way hash', () => {
    const event = normalizeGmailMessage({
      id: 'gmail-msg-2',
      threadId: 'gmail-thread-2',
      payload: { headers: [{ name: 'From', value: 'jane@customer-example.com' }] },
    });

    expect(event.senderDomain).toBe('customer-example.com');
    expect(event.senderHash).toBe(createHash('sha256').update('jane@customer-example.com').digest('hex'));
    expect(JSON.stringify(event)).not.toContain('jane@customer-example.com');
  });

  it('handles a MALFORMED/incomplete payload safely -- missing headers never throw, resolve to null fields', () => {
    const event = normalizeGmailMessage({ id: 'gmail-msg-3', threadId: '' });

    expect(event.providerMessageId).toBe('gmail-msg-3');
    expect(event.providerThreadId).toBeNull();
    expect(event.inReplyTo).toBeNull();
    expect(event.references).toBeNull();
    expect(event.senderHash).toBeNull();
    expect(event.senderDomain).toBeNull();
  });

  it('never persists or exposes the message body -- the normalizer has no body field to leak in the first place', () => {
    const event = normalizeGmailMessage({
      id: 'gmail-msg-4',
      threadId: 'gmail-thread-4',
      payload: { headers: [{ name: 'From', value: 'jane@customer-example.com' }] },
    });

    expect(Object.keys(event)).not.toContain('body');
    expect(Object.keys(event)).not.toContain('snippet');
  });

  it('a From header with no "@" is treated as unparseable, not a crash', () => {
    const event = normalizeGmailMessage({
      id: 'gmail-msg-5',
      threadId: 'gmail-thread-5',
      payload: { headers: [{ name: 'From', value: 'not-an-email-address' }] },
    });

    expect(event.senderHash).toBeNull();
    expect(event.senderDomain).toBeNull();
  });
});
