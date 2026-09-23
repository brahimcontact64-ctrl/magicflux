import { createHash } from 'node:crypto';
import type {
  IdentifiedEvent,
  NormalizedEvent,
  PlatformConnector,
  SubscribeResult,
  TestConnectionResult,
  VerifyResult,
} from '../types';
import { verifyWooCommerceSignature } from './signature';
import { normalizeWooCommerceEvent } from './normalize';
import { WOOCOMMERCE_SUPPORTED_TOPICS, isSupportedTopic } from './capabilities';
import { validateStoreUrlReachable, listWebhooks, createWebhook, deleteWebhook } from './client';

/** WooCommerce's own activation/connectivity ping: delivered through the same mechanism as a real event, but its body is exactly `{"webhook_id": <id>}` and carries no real resource -- must be acknowledged, never normalized/dispatched. */
function looksLikePing(rawBody: string): boolean {
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed);
    return keys.length === 1 && keys[0] === 'webhook_id';
  } catch {
    return false;
  }
}

export const woocommerceConnector: PlatformConnector = {
  platform: 'woocommerce',
  capabilities: {
    topics: WOOCOMMERCE_SUPPORTED_TOPICS,
    supportsSubscriptionManagement: true,
    requiresOAuth: false,
  },

  verify({ rawBody, headers, webhookSecret }): VerifyResult {
    const signature = headers.get('x-wc-webhook-signature');
    if (verifyWooCommerceSignature(rawBody, signature, webhookSecret)) {
      return { ok: true };
    }
    return { ok: false, reason: 'INVALID_WOOCOMMERCE_SIGNATURE' };
  },

  identifyEvent({ rawBody, headers }): IdentifiedEvent | null {
    const isPing = looksLikePing(rawBody);
    const topic = headers.get('x-wc-webhook-topic') ?? '';
    const deliveryId = headers.get('x-wc-webhook-delivery-id');

    // Part G: prefer WooCommerce's own stable per-delivery id. It is not
    // documented as guaranteed-present on every WooCommerce version, so a
    // deterministic fallback (scoped to verified, immutable request data --
    // the raw body itself, which has ALREADY passed signature verification
    // by the time identifyEvent() is consulted for dispatch) covers that gap
    // rather than ever skipping idempotency.
    if (deliveryId && deliveryId.trim()) {
      return { eventId: deliveryId.trim(), eventIdSource: 'provider_delivery_id', topic, isPing };
    }

    const hash = createHash('sha256').update(rawBody).digest('hex');
    return { eventId: hash, eventIdSource: 'payload_hash', topic, isPing };
  },

  normalize({ rawBody, connection, identity }): NormalizedEvent | null {
    if (identity.isPing) return null;
    if (!isSupportedTopic(identity.topic)) return null;
    return normalizeWooCommerceEvent({
      connectionId: connection.id,
      topic: identity.topic,
      eventId: identity.eventId,
      resourceRaw: rawBody,
    });
  },

  async testConnection({ connection, credentials }): Promise<TestConnectionResult> {
    const reachable = await validateStoreUrlReachable(connection.storeUrl);
    if (!reachable.ok) {
      return { stage: 'store_unreachable', detail: reachable.reason };
    }

    const listed = await listWebhooks(reachable.storeUrl, credentials);
    if (!listed.ok) {
      return { stage: 'credentials_invalid', detail: listed.reason };
    }

    const subscriptionIds = Object.values(connection.providerSubscriptions);
    if (subscriptionIds.length === 0) {
      return { stage: 'subscription_invalid', detail: 'No WooCommerce webhook subscription has been created for this connection yet.' };
    }

    const stillPresent = subscriptionIds.every((id) => listed.webhooks.some((w) => String(w.id) === String(id) && w.status === 'active'));
    if (!stillPresent) {
      return { stage: 'subscription_invalid', detail: 'One or more WooCommerce webhook subscriptions are missing or inactive. They may have been deleted or disabled directly in WooCommerce.' };
    }

    return { stage: 'ready', detail: 'WooCommerce is connected and the webhook subscription is active.' };
  },

  async subscribe({ credentials, webhookUrl, webhookSecret, topics, existing }): Promise<SubscribeResult> {
    const result: Record<string, string> = { ...(existing ?? {}) };

    // Part K: repeated Connect clicks / partial-failure retries must never
    // accumulate duplicate provider-side subscriptions. Before creating
    // anything for a topic, check what WooCommerce ALREADY has for this
    // exact delivery URL + topic and adopt its id instead -- this is the
    // authoritative de-dup check (queries the store directly), more
    // reliable than trusting our own possibly-stale `existing` map alone
    // (e.g. after a crash between "WooCommerce confirmed creation" and "we
    // persisted the id").
    const listed = await listWebhooks(credentials.storeUrl, credentials);
    const alreadyOnStore = listed.ok ? listed.webhooks : [];

    for (const topic of topics) {
      if (result[topic]) continue; // already subscribed (from a prior successful attempt)

      const matching = alreadyOnStore.find((w) => w.topic === topic && w.delivery_url === webhookUrl && w.status !== 'disabled');
      if (matching) {
        result[topic] = String(matching.id);
        continue;
      }

      const created = await createWebhook(credentials.storeUrl, credentials, {
        name: `MagicFlux - ${topic}`,
        topic,
        deliveryUrl: webhookUrl,
        secret: webhookSecret,
      });

      if (!created.ok) {
        return { ok: false, reason: created.reason, partialSubscriptions: result };
      }
      result[topic] = String(created.webhook.id);
    }

    return { ok: true, providerSubscriptions: result };
  },

  async unsubscribe({ credentials, providerSubscriptions }): Promise<void> {
    for (const id of Object.values(providerSubscriptions)) {
      // Never throws for an id WooCommerce has already removed externally --
      // deleteWebhook() treats 404 as a successful end-state (Part K).
      await deleteWebhook(credentials.storeUrl, credentials, id).catch(() => {});
    }
  },
};
