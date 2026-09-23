import type { NormalizedEvent } from '../types';
import { isSupportedTopic } from './capabilities';

type WcBilling = { first_name?: string; last_name?: string; email?: string; phone?: string; company?: string };
type WcLineItem = { name?: string; quantity?: number; total?: string; sku?: string };
type WcOrder = {
  id?: number;
  status?: string;
  currency?: string;
  total?: string;
  date_created?: string;
  billing?: WcBilling;
  line_items?: WcLineItem[];
};
type WcCustomer = {
  id?: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  date_created?: string;
  billing?: WcBilling;
};

function fullName(first?: string, last?: string): string | undefined {
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name || undefined;
}

/**
 * Phase 9.9.22 -- Part I: deterministic, pure mapping from WooCommerce's
 * raw resource JSON (identical shape to the REST API response, per
 * WooCommerce's own webhook docs) into the canonical connector envelope.
 * No LLM, no heuristic guessing -- every field here is a fixed, named
 * lookup. Returns null for any topic outside the capability allowlist,
 * so a caller can fail closed rather than dispatch malformed data.
 */
export function normalizeWooCommerceEvent(params: {
  connectionId: string;
  topic: string;
  eventId: string;
  resourceRaw: string;
}): NormalizedEvent | null {
  if (!isSupportedTopic(params.topic)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(params.resourceRaw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const [resource] = params.topic.split('.');

  if (resource === 'order') {
    const order = parsed as WcOrder;
    const normalizedData: Record<string, unknown> = {
      order_id: order.id,
      status: order.status,
      currency: order.currency,
      total: order.total,
      email: order.billing?.email,
      name: fullName(order.billing?.first_name, order.billing?.last_name),
      phone: order.billing?.phone,
      company: order.billing?.company,
      line_items: Array.isArray(order.line_items)
        ? order.line_items.map((li) => ({ name: li.name, quantity: li.quantity, total: li.total, sku: li.sku }))
        : [],
    };
    return {
      platform: 'woocommerce',
      connectionId: params.connectionId,
      eventType: params.topic,
      eventId: params.eventId,
      occurredAt: order.date_created ?? new Date().toISOString(),
      resource: 'order',
      normalizedData,
      providerMetadata: { woocommerce_order_id: order.id, topic: params.topic },
    };
  }

  if (resource === 'customer') {
    const customer = parsed as WcCustomer;
    const normalizedData: Record<string, unknown> = {
      customer_id: customer.id,
      email: customer.email,
      name: fullName(customer.first_name, customer.last_name),
      phone: customer.billing?.phone,
      company: customer.billing?.company,
    };
    return {
      platform: 'woocommerce',
      connectionId: params.connectionId,
      eventType: params.topic,
      eventId: params.eventId,
      occurredAt: customer.date_created ?? new Date().toISOString(),
      resource: 'customer',
      normalizedData,
      providerMetadata: { woocommerce_customer_id: customer.id, topic: params.topic },
    };
  }

  return null;
}
