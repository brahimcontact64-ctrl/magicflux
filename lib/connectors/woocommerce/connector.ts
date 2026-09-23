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
import { diagnoseWooCommerceConnection, listWebhooks, createWebhook, deleteWebhook } from './client';

/** Phase 9.9.22B -- Live Certification Failure #3: coarse, safe classification only -- never persists/logs the raw User-Agent string. */
function classifyUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'absent';
  const ua = userAgent.toLowerCase();
  if (ua.includes('wordpress') || ua.includes('woocommerce')) return 'wordpress';
  if (/(bot|crawl|spider|curl|wget|python-requests|go-http-client|scan|monitor|uptime|probe)/.test(ua)) return 'bot_or_script';
  return 'other';
}

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
    // Phase 9.9.22B -- Live Certification Failure #3: a request with NO
    // signature header at all is a structurally different fact than one
    // with a signature that fails to verify -- the former usually means
    // "this request did not come from WooCommerce's webhook delivery
    // system in the first place" (a scanner/bot/unrelated hit reusing this
    // URL), the latter means "something is wrong with the crypto/secret
    // for a request that at least claims to be a real delivery." Reporting
    // both as the same INVALID_WOOCOMMERCE_SIGNATURE previously sent a
    // real investigation down the wrong path (auditing HMAC correctness)
    // when the actual, distinguishable fact -- no X-WC-Webhook-Signature
    // header present at all -- would have pointed at request provenance
    // immediately.
    //
    // Safe-only diagnostic metadata attached to every rejection, so a real
    // failed delivery can be root-caused from connection-health/logs alone,
    // without ever needing to see or reproduce the signature, secret, or
    // payload.
    return {
      ok: false,
      reason: signature ? 'INVALID_WOOCOMMERCE_SIGNATURE' : 'MISSING_WOOCOMMERCE_SIGNATURE',
      diagnostics: {
        signaturePresent: Boolean(signature),
        bodyByteLength: Buffer.byteLength(rawBody, 'utf8'),
        algorithm: 'hmac-sha256-base64',
        deliveryId: headers.get('x-wc-webhook-delivery-id'),
        topic: headers.get('x-wc-webhook-topic'),
        userAgentClass: classifyUserAgent(headers.get('user-agent')),
      },
    };
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
    // Phase 9.9.22B -- full staged diagnosis (store -> WordPress REST ->
    // WooCommerce namespace -> credentials -> webhooks endpoint), with the
    // pretty-permalink/rest_route compatibility fallback applied
    // transparently at every step. Never collapses a real distinction into
    // a misleading "credentials invalid" message.
    const diagnosis = await diagnoseWooCommerceConnection(connection.storeUrl, credentials);
    if (diagnosis.stage !== 'ready') {
      return diagnosis;
    }

    const listed = await listWebhooks(diagnosis.storeUrl ?? connection.storeUrl, credentials);
    if (!listed.ok) {
      return { stage: 'authentication_failed', detail: listed.reason };
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
