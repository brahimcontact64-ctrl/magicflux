/**
 * Phase 9.9.22 -- pure-function coverage for the WooCommerce connector's
 * signature verification, event identification, and normalization. No
 * mocking needed: these are deterministic, side-effect-free functions.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { computeWooCommerceSignature, verifyWooCommerceSignature } from '@/lib/connectors/woocommerce/signature';
import { normalizeWooCommerceEvent } from '@/lib/connectors/woocommerce/normalize';
import { isSupportedTopic, WOOCOMMERCE_SUPPORTED_TOPICS } from '@/lib/connectors/woocommerce/capabilities';
import { woocommerceConnector } from '@/lib/connectors/woocommerce/connector';
import type { ConnectionRecord } from '@/lib/connectors/types';

const SECRET = 'test-secret-value';

function headersFrom(map: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

describe('WooCommerce signature verification', () => {
  it('accepts a correctly computed signature', () => {
    const body = JSON.stringify({ id: 1 });
    const sig = computeWooCommerceSignature(body, SECRET);
    expect(verifyWooCommerceSignature(body, sig, SECRET)).toBe(true);
  });

  it('rejects a tampered body (signature computed on the ORIGINAL body)', () => {
    const original = JSON.stringify({ id: 1, total: '10.00' });
    const tampered = JSON.stringify({ id: 1, total: '999999.00' });
    const sig = computeWooCommerceSignature(original, SECRET);
    expect(verifyWooCommerceSignature(tampered, sig, SECRET)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const body = JSON.stringify({ id: 1 });
    const sig = computeWooCommerceSignature(body, 'wrong-secret');
    expect(verifyWooCommerceSignature(body, sig, SECRET)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyWooCommerceSignature('{}', null, SECRET)).toBe(false);
  });

  it('rejects a garbage/non-base64 signature without throwing', () => {
    expect(verifyWooCommerceSignature('{}', 'not-valid-base64!!!', SECRET)).toBe(false);
  });

  it('rejects an empty-string signature', () => {
    expect(verifyWooCommerceSignature('{}', '', SECRET)).toBe(false);
  });
});

describe('WooCommerce capabilities allowlist', () => {
  it('supports exactly the documented, tested topics', () => {
    expect(WOOCOMMERCE_SUPPORTED_TOPICS).toEqual(['order.created', 'order.updated', 'customer.created', 'customer.updated']);
  });

  it('rejects an unsupported/unknown topic', () => {
    expect(isSupportedTopic('product.created')).toBe(false);
    expect(isSupportedTopic('coupon.created')).toBe(false);
    expect(isSupportedTopic('order.deleted')).toBe(false);
  });
});

describe('normalizeWooCommerceEvent()', () => {
  it('maps an order.created payload to the canonical envelope', () => {
    const order = {
      id: 42,
      status: 'processing',
      currency: 'USD',
      total: '150.00',
      date_created: '2026-09-23T10:00:00',
      billing: { first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', phone: '+1-555-0100' },
      line_items: [{ name: 'Widget', quantity: 2, total: '100.00', sku: 'W-1' }],
    };
    const result = normalizeWooCommerceEvent({ connectionId: 'conn-1', topic: 'order.created', eventId: 'evt-1', resourceRaw: JSON.stringify(order) });

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('order.created');
    expect(result!.resource).toBe('order');
    expect(result!.normalizedData.email).toBe('jane@example.com');
    expect(result!.normalizedData.name).toBe('Jane Doe');
    expect(result!.normalizedData.order_id).toBe(42);
  });

  it('maps a customer.created payload to the canonical envelope', () => {
    const customer = { id: 7, email: 'sam@example.com', first_name: 'Sam', last_name: 'Lee', date_created: '2026-09-23T10:00:00' };
    const result = normalizeWooCommerceEvent({ connectionId: 'conn-1', topic: 'customer.created', eventId: 'evt-2', resourceRaw: JSON.stringify(customer) });

    expect(result!.resource).toBe('customer');
    expect(result!.normalizedData.email).toBe('sam@example.com');
    expect(result!.normalizedData.name).toBe('Sam Lee');
  });

  it('returns null for an unsupported topic -- fails closed rather than guessing a mapping', () => {
    const result = normalizeWooCommerceEvent({ connectionId: 'conn-1', topic: 'product.created', eventId: 'evt-3', resourceRaw: JSON.stringify({ id: 1 }) });
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    const result = normalizeWooCommerceEvent({ connectionId: 'conn-1', topic: 'order.created', eventId: 'evt-4', resourceRaw: '{not valid json' });
    expect(result).toBeNull();
  });

  it('returns null for a non-object JSON body (e.g. a bare array or number)', () => {
    expect(normalizeWooCommerceEvent({ connectionId: 'c', topic: 'order.created', eventId: 'e', resourceRaw: '[1,2,3]' })).toBeNull();
    expect(normalizeWooCommerceEvent({ connectionId: 'c', topic: 'order.created', eventId: 'e', resourceRaw: '42' })).toBeNull();
  });
});

const CONNECTION: ConnectionRecord = {
  id: 'conn-1',
  userId: 'user-1',
  workflowId: 'wf-1',
  platform: 'woocommerce',
  status: 'connected',
  storeUrl: 'https://store.example.com',
  providerSubscriptions: { 'order.created': '10' },
  topics: ['order.created'],
  lastVerifiedAt: null,
  lastEventAt: null,
  lastError: null,
  errorCategory: null,
};

describe('woocommerceConnector.identifyEvent()', () => {
  it('prefers the provider delivery id when present', () => {
    const headers = headersFrom({ 'X-WC-Webhook-Delivery-ID': 'delivery-123', 'X-WC-Webhook-Topic': 'order.created' });
    const identity = woocommerceConnector.identifyEvent({ rawBody: '{}', headers });
    expect(identity).toEqual({ eventId: 'delivery-123', eventIdSource: 'provider_delivery_id', topic: 'order.created', isPing: false });
  });

  it('falls back to a deterministic payload hash when no delivery id is present', () => {
    const headers = headersFrom({ 'X-WC-Webhook-Topic': 'order.created' });
    const body = JSON.stringify({ id: 1 });
    const a = woocommerceConnector.identifyEvent({ rawBody: body, headers });
    const b = woocommerceConnector.identifyEvent({ rawBody: body, headers });
    expect(a!.eventIdSource).toBe('payload_hash');
    expect(a!.eventId).toBe(b!.eventId); // same body -> same fallback id, deterministically
  });

  it('detects a WooCommerce connectivity ping ({"webhook_id": N}) and marks isPing true', () => {
    const headers = headersFrom({});
    const identity = woocommerceConnector.identifyEvent({ rawBody: JSON.stringify({ webhook_id: 99 }), headers });
    expect(identity!.isPing).toBe(true);
  });

  it('does not mistake a real order payload that happens to contain a webhook_id-shaped field for a ping', () => {
    const headers = headersFrom({ 'X-WC-Webhook-Topic': 'order.created' });
    const identity = woocommerceConnector.identifyEvent({ rawBody: JSON.stringify({ id: 1, webhook_id: 99, status: 'processing' }), headers });
    expect(identity!.isPing).toBe(false);
  });
});

describe('woocommerceConnector.normalize() end-to-end with a real connection record', () => {
  it('returns null for a ping identity regardless of topic', () => {
    const identity = { eventId: 'x', eventIdSource: 'payload_hash' as const, topic: 'order.created', isPing: true };
    const result = woocommerceConnector.normalize({ rawBody: JSON.stringify({ webhook_id: 1 }), headers: headersFrom({}), connection: CONNECTION, identity });
    expect(result).toBeNull();
  });

  it('normalizes a genuine, non-ping, supported event', () => {
    const order = { id: 1, billing: { email: 'a@b.com', first_name: 'A', last_name: 'B' } };
    const identity = { eventId: 'evt-1', eventIdSource: 'provider_delivery_id' as const, topic: 'order.created', isPing: false };
    const result = woocommerceConnector.normalize({ rawBody: JSON.stringify(order), headers: headersFrom({}), connection: CONNECTION, identity });
    expect(result?.normalizedData.email).toBe('a@b.com');
  });
});

describe('Phase 9.9.22B -- Live Certification Failure #2: verify() diagnostics never leak sensitive material', () => {
  it('a rejected signature attaches safe diagnostic metadata (delivery id, topic, body length, signature-present, algorithm)', () => {
    const headers = headersFrom({ 'X-WC-Webhook-Signature': 'aW52YWxpZA==', 'X-WC-Webhook-Delivery-ID': 'delivery-xyz', 'X-WC-Webhook-Topic': 'order.created' });
    const body = JSON.stringify({ id: 1 });
    const result = woocommerceConnector.verify({ rawBody: body, headers, connection: CONNECTION, webhookSecret: SECRET });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.diagnostics).toEqual({
      signaturePresent: true,
      bodyByteLength: Buffer.byteLength(body, 'utf8'),
      algorithm: 'hmac-sha256-base64',
      deliveryId: 'delivery-xyz',
      topic: 'order.created',
    });
  });

  it('reports signaturePresent:false when the header is entirely missing, distinguishing "wrong" from "absent"', () => {
    const headers = headersFrom({ 'X-WC-Webhook-Delivery-ID': 'delivery-abc' });
    const result = woocommerceConnector.verify({ rawBody: '{}', headers, connection: CONNECTION, webhookSecret: SECRET });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.diagnostics?.signaturePresent).toBe(false);
  });

  it('diagnostics never contain the signature value, the secret, or any body content', () => {
    const realisticSecret = 'f'.repeat(64);
    const body = JSON.stringify({ id: 1, billing: { email: 'super-secret-customer@example.com' } });
    const headers = headersFrom({ 'X-WC-Webhook-Signature': 'd0hhdGV2ZXI=', 'X-WC-Webhook-Topic': 'order.created' });
    const result = woocommerceConnector.verify({ rawBody: body, headers, connection: CONNECTION, webhookSecret: realisticSecret });
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(realisticSecret);
    expect(serialized).not.toContain('d0hhdGV2ZXI=');
    expect(serialized).not.toContain('super-secret-customer@example.com');
  });

  it('accepts a correctly signed, REALISTIC full-size order.created payload (nested line_items, tax_lines, meta_data, non-ASCII billing name) -- rules out a raw-body-fidelity issue at real-world scale/content', () => {
    const realisticSecret = randomHex64();
    const realisticOrder = buildRealisticOrderPayload();
    const rawBody = JSON.stringify(realisticOrder);
    const signature = computeWooCommerceSignature(rawBody, realisticSecret);
    const headers = headersFrom({ 'X-WC-Webhook-Signature': signature, 'X-WC-Webhook-Topic': 'order.created', 'X-WC-Webhook-Delivery-ID': 'delivery-realistic-1' });

    const result = woocommerceConnector.verify({ rawBody, headers, connection: CONNECTION, webhookSecret: realisticSecret });
    expect(result.ok).toBe(true);

    // And it normalizes correctly end-to-end from the same raw bytes.
    const identity = woocommerceConnector.identifyEvent({ rawBody, headers })!;
    const normalized = woocommerceConnector.normalize({ rawBody, headers, connection: CONNECTION, identity });
    expect(normalized?.normalizedData.email).toBe(realisticOrder.billing.email);
    expect(normalized?.normalizedData.name).toBe(`${realisticOrder.billing.first_name} ${realisticOrder.billing.last_name}`);
  });

  it('a single-byte mutation anywhere in a large realistic payload is detected (proves comparison is over the FULL body, not a prefix/truncated form)', () => {
    const realisticSecret = randomHex64();
    const realisticOrder = buildRealisticOrderPayload();
    const rawBody = JSON.stringify(realisticOrder);
    const signature = computeWooCommerceSignature(rawBody, realisticSecret);
    const headers = headersFrom({ 'X-WC-Webhook-Signature': signature, 'X-WC-Webhook-Topic': 'order.created' });

    // Flip one character deep inside the payload (well past any reasonable prefix-only comparison bug).
    const tamperedBody = rawBody.slice(0, -50) + (rawBody.slice(-50) === 'x' ? 'y' : 'x') + rawBody.slice(-49);
    const result = woocommerceConnector.verify({ rawBody: tamperedBody, headers, connection: CONNECTION, webhookSecret: realisticSecret });
    expect(result.ok).toBe(false);
  });
});

function randomHex64(): string {
  return randomBytes(32).toString('hex');
}

/** Shaped closely after a real WooCommerce order.created payload -- nested line_items/tax_lines/meta_data, decimal price strings, and a non-ASCII billing name, to stress-test raw-body byte fidelity beyond the tiny stub payloads used elsewhere in this suite. */
function buildRealisticOrderPayload() {
  return {
    id: 4821,
    status: 'processing',
    currency: 'EUR',
    total: '129.99',
    date_created: '2026-09-23T14:20:11',
    billing: {
      first_name: 'Frédéric',
      last_name: 'Müller-O\'Connell',
      email: 'frederic.test@example.com',
      phone: '+33 6 12 34 56 78',
      address_1: 'Rue de l\'Église 12, Apt. "B"',
      city: 'Québec',
      postcode: 'G1V 0A6',
      country: 'CA',
    },
    line_items: [
      { id: 1, name: 'Café en grains — 1kg', quantity: 2, total: '39.98', sku: 'CAFE-1KG', meta_data: [{ key: '_roast', value: 'medium' }] },
      { id: 2, name: 'Théière en fonte (noir)', quantity: 1, total: '90.01', sku: 'THEIERE-BLK', meta_data: [] },
    ],
    tax_lines: [{ id: 10, rate_code: 'CA-QC-TVQ-1', label: 'TVQ', tax_total: '6.48' }],
    shipping_lines: [{ id: 20, method_title: 'Livraison standard', total: '8.50' }],
    meta_data: [
      { key: '_customer_note', value: 'Livrer entre 9h et 17h, merci !' },
      { key: '_special_chars_test', value: '€ ¥ £ © ® ™ — “quoted” <tag> & "escaped"' },
    ],
  };
}
