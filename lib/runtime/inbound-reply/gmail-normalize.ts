import { createHash } from 'node:crypto';
import type { InboundReplyEvent } from './types';

/**
 * Workflow #2 Phase A -- Gmail-specific normalizer. Translates a Gmail API
 * message resource (fetched with format=metadata -- headers only, never the
 * message body) into the provider-neutral InboundReplyEvent. This is the
 * ONLY file in the inbound-reply module that knows anything about Gmail's
 * wire format; everything else (correlate.ts, process-reply.ts,
 * send-guard.ts) is provider-agnostic by construction.
 */

export type GmailHeader = { name: string; value: string };
export type GmailMessageResource = {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
};

function findHeader(headers: GmailHeader[] | undefined, name: string): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  const found = headers.find((h) => h.name?.toLowerCase() === lower);
  return found?.value ?? null;
}

function extractSenderAddress(fromHeader: string | null): string | null {
  if (!fromHeader) return null;
  // "Display Name <address@example.com>" or a bare address.
  const angleMatch = fromHeader.match(/<([^<>]+)>/);
  const raw = angleMatch ? angleMatch[1] : fromHeader;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.includes('@') ? trimmed : null;
}

function hashSender(address: string): string {
  return createHash('sha256').update(address).digest('hex');
}

function senderDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at === -1 ? null : address.slice(at + 1);
}

/**
 * Normalizes one Gmail message resource. Never reads or persists the
 * message body -- only headers (In-Reply-To, References, From, Message-ID)
 * and the envelope-level id/threadId/internalDate. The Gmail-specific
 * message id is embedded in rawProviderMetadata for debugging only (never
 * anything sender/body-derived beyond what's already in the typed fields).
 */
export function normalizeGmailMessage(message: GmailMessageResource): InboundReplyEvent {
  const headers = message.payload?.headers;
  const fromAddress = extractSenderAddress(findHeader(headers, 'From'));
  const receivedAt = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : new Date().toISOString();

  return {
    provider: 'gmail',
    providerMessageId: message.id,
    providerThreadId: message.threadId || null,
    senderHash: fromAddress ? hashSender(fromAddress) : null,
    senderDomain: fromAddress ? senderDomain(fromAddress) : null,
    receivedAt,
    inReplyTo: findHeader(headers, 'In-Reply-To'),
    references: findHeader(headers, 'References'),
    rawProviderMetadata: { gmailMessageId: message.id, gmailThreadId: message.threadId },
  };
}
