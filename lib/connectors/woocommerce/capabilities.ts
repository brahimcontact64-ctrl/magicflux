/**
 * Phase 9.9.22 -- Part H: explicit capability allowlist. WooCommerce
 * defines many more topics (coupon.*, product.*, etc. -- see
 * developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/), but this
 * connector only claims the ones it has a real, tested normalizer for.
 * Anything else is rejected (fail closed), never silently accepted and
 * mis-mapped -- see normalize.ts's default case.
 */
export const WOOCOMMERCE_SUPPORTED_TOPICS = [
  'order.created',
  'order.updated',
  'customer.created',
  'customer.updated',
] as const;

export type WooCommerceTopic = (typeof WOOCOMMERCE_SUPPORTED_TOPICS)[number];

export function isSupportedTopic(topic: string): topic is WooCommerceTopic {
  return (WOOCOMMERCE_SUPPORTED_TOPICS as readonly string[]).includes(topic);
}
