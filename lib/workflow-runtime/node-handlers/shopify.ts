import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

export async function shopifyHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);

  if (context.mode === 'test') {
    logs.push('Shopify node simulated in test mode — using sample order data.');
    return {
      status: 'simulated_success',
      outputData: { ...data, shopify_simulated: true },
      logs,
    };
  }

  const shopifyIntegration = context.integrations.find((i) => i.provider === 'shopify');
  if (!shopifyIntegration?.credentials) {
    logs.push('Shopify integration not configured.');
    return { status: 'failed', outputData: null, logs, error: 'Shopify integration not configured' };
  }

  const creds = shopifyIntegration.credentials as Record<string, unknown>;
  const shopDomain = String(creds.shop_domain ?? creds.shopDomain ?? creds.shop ?? '');
  // access_token is the field name used by lib/credentials/provider-registry.ts;
  // admin_access_token/accessToken/token are fallbacks for integrations connected
  // before that field was standardized.
  const accessToken = String(creds.access_token ?? creds.admin_access_token ?? creds.accessToken ?? creds.token ?? '');

  if (!shopDomain || !accessToken) {
    return { status: 'failed', outputData: null, logs, error: 'Shopify credentials incomplete' };
  }

  const type = String(node.type ?? '').toLowerCase();
  const params = asRecord(node.parameters);

  try {
    if (type.includes('trigger') || type.includes('webhook')) {
      // Trigger node — data comes from incoming webhook
      logs.push('Shopify trigger: using incoming event payload.');
      return { status: 'success', outputData: inputData, logs };
    }

    if (type.includes('order')) {
      const orderId = String(data.order_id ?? params.orderId ?? '');
      if (!orderId) {
        logs.push('Shopify order node: no order_id in input.');
        return { status: 'success', outputData: data, logs };
      }

      const res = await fetch(
        `https://${shopDomain}/admin/api/2025-01/orders/${encodeURIComponent(orderId)}.json`,
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );

      if (!res.ok) throw new Error(`Shopify API returned ${res.status}`);
      const json = await res.json() as Record<string, unknown>;
      logs.push(`Shopify order ${orderId} fetched.`);
      return { status: 'success', outputData: { ...data, shopify_order: json.order }, logs };
    }

    logs.push(`Shopify node type ${node.type ?? 'unknown'} — passing through.`);
    return { status: 'success', outputData: inputData, logs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(`Shopify error: ${msg}`);
    return { status: 'failed', outputData: null, logs, error: msg };
  }
}
