export type IntegrationProvider = 'shopify' | 'slack' | 'airtable' | 'gmail' | 'google_drive' | 'email' | 'openai' | 'custom';

export type IntegrationRecord = {
  provider: IntegrationProvider;
  credentials: Record<string, string>;
};

// ─── Single source of truth: exact node-type allowlist ───────────────────────
//
// PROVIDER_NODE_ALLOWLIST is the authoritative record of which n8n node types
// are eligible for provider integration. Three systems derive their eligibility
// rules from it:
//
//   1. requiredProvidersFromWorkflow() — reports which integrations a workflow needs
//   2. injectCredentialsIntoWorkflow() — injects credentials into eligible nodes
//   3. lib/workflow-runtime/node-handlers/index.ts:HANDLER_NODE_ALLOWLIST —
//      routes eligible types to credential-using execution handlers
//
// All three systems therefore agree: a node type that is not in this map will
// not require credentials, not receive credentials, and not execute a provider
// handler. Any crafted type such as 'shopifyFakeHttp', 'company.shopifyProxy',
// or 'custom.slackNotifier' is absent from this map and is treated as ineligible
// by all three systems simultaneously.
//
// Entries are stored in lowercase. Callers lowercase the incoming type string
// before lookup so case variants (e.g. N8N-NODES-BASE.SHOPIFY) still match
// the legitimate entry.
//
// To add a new integration node: add its lowercase type here, add the matching
// entry to HANDLER_NODE_ALLOWLIST in node-handlers/index.ts, and add a
// type-specific injection block in injectCredentialsIntoWorkflow() if needed.
export const PROVIDER_NODE_ALLOWLIST: ReadonlyMap<IntegrationProvider, ReadonlySet<string>> = new Map([
  ['shopify', new Set([
    'n8n-nodes-base.shopify',
    'n8n-nodes-base.shopifytrigger',
  ])],
  ['slack', new Set([
    'n8n-nodes-base.slack',
    'n8n-nodes-base.slacktrigger',
  ])],
  ['airtable', new Set([
    'n8n-nodes-base.airtable',
    'n8n-nodes-base.airtabletrigger',
  ])],
  ['gmail', new Set([
    'n8n-nodes-base.emailsend',
    'n8n-nodes-base.emailreadimap',
    'n8n-nodes-base.gmail',
    'n8n-nodes-base.gmailtrigger',
  ])],
  // 'email' is an alias for 'gmail' — both keys map to the same node-type set.
  // injectCredentialsIntoWorkflow() looks up credentials by both keys.
  // requiredProvidersFromWorkflow() suppresses 'email' and returns only 'gmail'
  // so callers receive one canonical name.
  ['email', new Set([
    'n8n-nodes-base.emailsend',
    'n8n-nodes-base.emailreadimap',
    'n8n-nodes-base.gmail',
    'n8n-nodes-base.gmailtrigger',
  ])],
  ['google_drive', new Set([
    'n8n-nodes-base.googledrive',
    'n8n-nodes-base.googledrivetrigger',
  ])],
  // OpenAI: credentials resolved at runtime from integration_credentials (new table).
  // Listed here so HANDLER_NODE_ALLOWLIST consistency tests pass.
  ['openai', new Set([
    'n8n-nodes-base.openai',
  ])],
]);

// Returns the set of providers whose credentials this node type is entitled to
// receive. Returns an empty set for any type not in PROVIDER_NODE_ALLOWLIST —
// including crafted types that would previously pass substring checks.
export function matchedProvidersForNode(nodeType: string): Set<IntegrationProvider> {
  const lc = nodeType.toLowerCase();
  const matched = new Set<IntegrationProvider>();
  for (const [provider, allowedTypes] of PROVIDER_NODE_ALLOWLIST) {
    if (allowedTypes.has(lc)) matched.add(provider);
  }
  return matched;
}

// Returns the integration providers required by a workflow, derived exclusively
// from PROVIDER_NODE_ALLOWLIST via matchedProvidersForNode().
//
// This is fully consistent with injectCredentialsIntoWorkflow() and with the
// runtime handler routing: a node type that does not appear in
// PROVIDER_NODE_ALLOWLIST will not be flagged as requiring any integration,
// will not receive any injected credentials, and will not be dispatched to a
// credential-using handler.
//
// 'email' is an alias of 'gmail' — only 'gmail' is included in the returned
// array so callers check one canonical provider name.
export function requiredProvidersFromWorkflow(workflow: unknown): IntegrationProvider[] {
  const nodes = ((workflow as { nodes?: Array<{ type?: string }> } | null)?.nodes ?? []);
  const required = new Set<IntegrationProvider>();

  for (const node of nodes) {
    for (const provider of matchedProvidersForNode(node.type ?? '')) {
      if (provider === 'email') continue; // alias — 'gmail' is the canonical form
      required.add(provider);
    }
  }

  return Array.from(required);
}

function replaceEnvTokens(raw: string, integrations: Record<IntegrationProvider, Record<string, string> | undefined>): string {
  const shopify = integrations.shopify;
  const slack = integrations.slack;
  const airtable = integrations.airtable;
  const email = integrations.gmail ?? integrations.email;

  return raw
    .replace(/\{\{\s*\$env\.SHOPIFY_ACCESS_TOKEN\s*\}\}/g, shopify?.access_token ?? shopify?.admin_access_token ?? shopify?.api_key ?? '')
    .replace(/\{\{\s*\$env\.SHOPIFY_API_KEY\s*\}\}/g, shopify?.access_token ?? shopify?.admin_access_token ?? shopify?.api_key ?? '')
    .replace(/\{\{\s*\$env\.SHOPIFY_STORE_URL\s*\}\}/g, shopify?.shop_domain ?? shopify?.store_url ?? '')
    .replace(/\{\{\s*\$env\.SLACK_WEBHOOK_URL\s*\}\}/g, slack?.webhook_url ?? '')
    .replace(/\{\{\s*\$env\.AIRTABLE_API_KEY\s*\}\}/g, airtable?.airtable_token ?? airtable?.api_key ?? '')
    .replace(/\{\{\s*\$env\.AIRTABLE_BASE_ID\s*\}\}/g, airtable?.base_id ?? '')
    // Also support user.* placeholders generated by templates/prompts.
    .replace(/\{\{\s*user\.shopify\.api[_-]?key\s*\}\}/gi, shopify?.access_token ?? shopify?.admin_access_token ?? shopify?.api_key ?? '')
    .replace(/\{\{\s*user\.shopify\.token\s*\}\}/gi, shopify?.access_token ?? shopify?.admin_access_token ?? shopify?.api_key ?? '')
    .replace(/\{\{\s*user\.shopify\.store[_-]?url\s*\}\}/gi, shopify?.shop_domain ?? shopify?.store_url ?? '')
    .replace(/\{\{\s*user\.slack\.webhook\s*\}\}/gi, slack?.webhook_url ?? '')
    .replace(/\{\{\s*user\.slack\.webhook[_-]?url\s*\}\}/gi, slack?.webhook_url ?? '')
    .replace(/\{\{\s*user\.airtable\.api[_-]?key\s*\}\}/gi, airtable?.airtable_token ?? airtable?.api_key ?? '')
    .replace(/\{\{\s*user\.airtable\.base[_-]?id\s*\}\}/gi, airtable?.base_id ?? '')
    .replace(/\{\{\s*\$env\.SMTP_HOST\s*\}\}/g, email?.smtp_host ?? '')
    .replace(/\{\{\s*\$env\.SMTP_PORT\s*\}\}/g, email?.smtp_port ?? '')
    .replace(/\{\{\s*\$env\.SMTP_USER\s*\}\}/g, email?.smtp_user ?? '')
    .replace(/\{\{\s*\$env\.SMTP_PASS\s*\}\}/g, email?.smtp_pass ?? '')
    .replace(/\{\{\s*\$env\.EMAIL_FROM\s*\}\}/g, email?.from_email ?? '')
    .replace(/\{\{\s*user\.email\.smtp[_-]?host\s*\}\}/gi, email?.smtp_host ?? '')
    .replace(/\{\{\s*user\.email\.smtp[_-]?port\s*\}\}/gi, email?.smtp_port ?? '')
    .replace(/\{\{\s*user\.email\.smtp[_-]?user\s*\}\}/gi, email?.smtp_user ?? '')
    .replace(/\{\{\s*user\.email\.smtp[_-]?pass\s*\}\}/gi, email?.smtp_pass ?? '')
    .replace(/\{\{\s*user\.email\.from\s*\}\}/gi, email?.from_email ?? '');
}

function deepInject(value: unknown, integrations: Record<IntegrationProvider, Record<string, string> | undefined>): unknown {
  if (typeof value === 'string') {
    return replaceEnvTokens(value, integrations);
  }

  if (Array.isArray(value)) {
    return value.map(v => deepInject(v, integrations));
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // Skip keys that would invoke prototype setters or shadow built-in properties.
      // JSON.parse already converts __proto__ to an own property, but assignment
      // via bracket notation still calls the setter on a plain {} object.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      output[key] = deepInject(val, integrations);
    }
    return output;
  }

  return value;
}

/**
 * Injects user credentials into generated n8n JSON.
 * This keeps all credential handling server-side.
 *
 * Security invariant: credentials are only injected into nodes whose type is
 * present in PROVIDER_NODE_ALLOWLIST. Unrecognized node types — including
 * n8n-nodes-base.httpRequest and all crafted fake types — are returned unchanged.
 */
export function injectCredentialsIntoWorkflow(
  workflowJson: unknown,
  integrationRows: IntegrationRecord[]
): Record<string, unknown> {
  const workflow = JSON.parse(JSON.stringify(workflowJson ?? {})) as {
    nodes?: Array<Record<string, unknown>>;
  };

  const byProvider: Record<IntegrationProvider, Record<string, string> | undefined> = {
    shopify:      integrationRows.find(r => r.provider === 'shopify')?.credentials,
    slack:        integrationRows.find(r => r.provider === 'slack')?.credentials,
    airtable:     integrationRows.find(r => r.provider === 'airtable')?.credentials,
    google_drive: undefined,
    gmail:        integrationRows.find(r => r.provider === 'gmail')?.credentials
                    ?? integrationRows.find(r => r.provider === 'email')?.credentials,
    email:        integrationRows.find(r => r.provider === 'gmail')?.credentials
                    ?? integrationRows.find(r => r.provider === 'email')?.credentials,
    // OpenAI credentials are resolved at runtime from integration_credentials (new table),
    // not injected into workflow JSON. This entry stays undefined to preserve that invariant.
    openai:       undefined,
    // Generic/custom API-key credential: injected by the live HTTP handler at
    // execution time (context.integrations), never into deployed workflow JSON.
    custom:       undefined,
  };

  const noCredentials: Record<IntegrationProvider, Record<string, string> | undefined> = {
    shopify: undefined, slack: undefined, airtable: undefined,
    google_drive: undefined, gmail: undefined, email: undefined, openai: undefined, custom: undefined,
  };

  workflow.nodes = (workflow.nodes ?? []).map(node => {
    const type = String(node.type ?? '').toLowerCase();
    const providers = matchedProvidersForNode(type);

    // Unrecognized node type: return as-is — no placeholder substitution, no injection.
    if (providers.size === 0) return node;

    // Scope deepInject to only the credentials this node type is entitled to.
    // A Shopify node gets Shopify credentials; it cannot see Slack or SMTP secrets.
    const scopedCredentials: Record<IntegrationProvider, Record<string, string> | undefined> = {
      ...noCredentials,
    };
    for (const p of providers) {
      scopedCredentials[p] = byProvider[p];
    }

    const nextNode = deepInject(node, scopedCredentials) as Record<string, unknown>;

    if (PROVIDER_NODE_ALLOWLIST.get('shopify')?.has(type) && byProvider.shopify) {
      const params = (nextNode.parameters as Record<string, unknown> | undefined) ?? {};
      params.accessToken = byProvider.shopify.access_token ?? byProvider.shopify.admin_access_token ?? byProvider.shopify.api_key ?? params.accessToken;
      params.storeUrl = byProvider.shopify.shop_domain ?? byProvider.shopify.store_url ?? params.storeUrl;
      nextNode.parameters = params;
    }

    if (PROVIDER_NODE_ALLOWLIST.get('airtable')?.has(type) && byProvider.airtable) {
      const params = (nextNode.parameters as Record<string, unknown> | undefined) ?? {};
      // personal_access_token is the field name used by lib/credentials/provider-registry.ts;
      // airtable_token/api_key are fallbacks for integrations connected before that rename.
      params.apiKey =
        byProvider.airtable.personal_access_token ??
        byProvider.airtable.airtable_token ??
        byProvider.airtable.api_key ??
        params.apiKey;
      params.base = params.base ?? byProvider.airtable.base_id;
      params.table = params.table ?? byProvider.airtable.table_name;
      nextNode.parameters = params;
    }

    // Convert Slack node to an HTTP call when the stored credential can't be
    // referenced as an n8n-native credential on the target instance.
    if (PROVIDER_NODE_ALLOWLIST.get('slack')?.has(type) && (byProvider.slack?.bot_token || byProvider.slack?.webhook_url)) {
      const text = (((nextNode.parameters as Record<string, unknown> | undefined)?.text as string) ?? 'Workflow notification');
      const channel = (((nextNode.parameters as Record<string, unknown> | undefined)?.channel as string) ?? '#general');
      nextNode.type = 'n8n-nodes-base.httpRequest';
      nextNode.typeVersion = 4;
      nextNode.name = String(nextNode.name ?? 'Slack Message');

      if (byProvider.slack.bot_token) {
        // Bot token (Slack Web API) is the current credential type.
        nextNode.parameters = {
          method: 'POST',
          url: 'https://slack.com/api/chat.postMessage',
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'Authorization', value: `Bearer ${byProvider.slack.bot_token}` }] },
          sendBody: true,
          contentType: 'json',
          jsonBody: JSON.stringify({ channel, text }),
        };
      } else {
        nextNode.parameters = {
          method: 'POST',
          url: byProvider.slack.webhook_url,
          sendBody: true,
          contentType: 'json',
          jsonBody: JSON.stringify({ text }),
        };
      }
    }

    return nextNode;
  });

  return workflow as Record<string, unknown>;
}
