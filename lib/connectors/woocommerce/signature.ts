import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Phase 9.9.22 -- Part F: WooCommerce's documented signature scheme
 * (developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/): the
 * `X-WC-Webhook-Signature` header is a base64-encoded HMAC-SHA256 digest
 * of the RAW, unparsed request body, keyed by the secret set on the
 * webhook subscription. Verification MUST run against the raw body
 * string exactly as received -- never a re-serialized/parsed-then-
 * re-stringified version, which WooCommerce's own docs explicitly warn
 * can silently mismatch (whitespace/key-order differences).
 */
export function computeWooCommerceSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

function safeCompareBase64(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'base64');
    const bufB = Buffer.from(b, 'base64');
    if (bufA.length === 0 || bufB.length === 0) return false;
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export function verifyWooCommerceSignature(rawBody: string, providedSignature: string | null, secret: string): boolean {
  if (!providedSignature) return false;
  const expected = computeWooCommerceSignature(rawBody, secret);
  return safeCompareBase64(expected, providedSignature);
}
