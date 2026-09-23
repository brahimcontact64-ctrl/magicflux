/**
 * Phase 9.9.22 -- the platform-independent connector interface every
 * adapter (WooCommerce today; Shopify/Framer/Webflow/Wix later) implements
 * identically, so the receiver route, the runtime dispatch boundary, and
 * the future Connect UI never need platform-specific branching.
 *
 * Hard invariant this interface enforces by construction: no adapter
 * implements a workflow runtime, a queue, or execution semantics of its
 * own. Every adapter's job ends at normalize() -- the receiver route
 * takes a NormalizedEvent, maps it onto the target workflow's own trigger
 * contract, and hands off to the EXISTING, unmodified
 * dispatchProductionExecution() (lib/runtime/execution-dispatch.ts). If a
 * future adapter's implementation ever imports from lib/runtime/engine or
 * lib/workflow-runtime directly, that is a design violation of this
 * boundary.
 */

export type ConnectionStatus = 'connecting' | 'connected' | 'needs_attention' | 'disconnected';

/** A persisted platform_connections row, as read back from storage -- never includes decrypted secret material by default. */
export type ConnectionRecord = {
  id: string;
  userId: string;
  workflowId: string;
  platform: string;
  status: ConnectionStatus;
  storeUrl: string;
  providerSubscriptions: Record<string, string>; // topic -> provider-side subscription id
  topics: string[];
  lastVerifiedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  errorCategory: string | null;
};

/**
 * Not force-fitted to OAuth (Part B) -- most connectors in this family
 * (WooCommerce, and likely Framer/Webflow's simplest paths) authenticate
 * with a static API key/secret pair, not a token exchange. `requiresOAuth`
 * simply tells the (future) Connect UI which form to render; adapters that
 * don't need it never implement an OAuth flow at all.
 */
export type ConnectorCapabilities = {
  /** Canonical, allowlisted event types this connector will ever normalize. Anything else fails closed (Part H). */
  topics: readonly string[];
  supportsSubscriptionManagement: boolean;
  requiresOAuth: boolean;
};

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

export type IdentifiedEvent = {
  /** Stable, provider-issued delivery/event id -- the idempotency key source. Never derived from a body hash when a real id exists. */
  eventId: string;
  eventIdSource: 'provider_delivery_id' | 'payload_hash';
  topic: string;
  /** true for a provider's own connectivity ping (e.g. WooCommerce's activation ping) -- ack, never normalize/dispatch. */
  isPing: boolean;
};

export type NormalizedEvent = {
  platform: string;
  connectionId: string;
  eventType: string;
  eventId: string;
  occurredAt: string;
  resource: string;
  normalizedData: Record<string, unknown>;
  providerMetadata: Record<string, unknown>;
};

export type TestConnectionResult =
  | { stage: 'store_unreachable'; detail: string }
  | { stage: 'credentials_invalid'; detail: string }
  | { stage: 'permissions_insufficient'; detail: string }
  | { stage: 'subscription_invalid'; detail: string }
  | { stage: 'ready'; detail: string };

export type SubscribeResult =
  | { ok: true; providerSubscriptions: Record<string, string> }
  | { ok: false; reason: string; partialSubscriptions?: Record<string, string> };

export type ConnectCredentials = {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
};

export interface PlatformConnector {
  readonly platform: string;
  readonly capabilities: ConnectorCapabilities;

  /** Validates raw inbound signature material against the connection's own generated secret. Never parses/mutates the body first (Part F). */
  verify(params: { rawBody: string; headers: { get(name: string): string | null }; connection: ConnectionRecord; webhookSecret: string }): VerifyResult;

  /** Extracts a stable event identity from headers/body WITHOUT trusting it for authentication -- identity only, never a substitute for verify(). */
  identifyEvent(params: { rawBody: string; headers: { get(name: string): string | null } }): IdentifiedEvent | null;

  /** Maps a verified, identified event into the canonical envelope. Deterministic, no LLM involvement (Part I). Returns null for anything outside `capabilities.topics` -- callers must fail closed, never guess. */
  normalize(params: { rawBody: string; headers: { get(name: string): string | null }; connection: ConnectionRecord; identity: IdentifiedEvent }): NormalizedEvent | null;

  /** Full test-connection pipeline: store reachable -> credentials valid -> permissions sufficient -> subscription valid -> ready. Never triggers a real workflow execution. */
  testConnection(params: { connection: ConnectionRecord; credentials: ConnectCredentials }): Promise<TestConnectionResult>;

  /** Creates the provider-side subscription(s) for `topics`. Idempotent: safe to call again for a connection that already has some subscriptions (Part K -- partial-failure recovery). */
  subscribe(params: { credentials: ConnectCredentials; webhookUrl: string; webhookSecret: string; topics: readonly string[]; existing?: Record<string, string> }): Promise<SubscribeResult>;

  /** Removes the provider-side subscription(s). Never throws for a subscription the provider has already deleted externally (Part K). */
  unsubscribe(params: { credentials: ConnectCredentials; providerSubscriptions: Record<string, string> }): Promise<void>;
}
