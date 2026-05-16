import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';

function getParam(node: EngineNode, keys: string[]): string {
  const params = node.parameters ?? {};
  for (const key of keys) {
    const val = params[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return '';
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

export async function slackHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);

  const channel = getParam(node, ['channel']) || '#general';
  const text =
    getParam(node, ['text', 'message']) ||
    String(data.message ?? `MagicFlux notification from ${node.name ?? 'workflow'}`);

  const preview = { nodeName: node.name ?? node.id, channel, text };

  if (context.mode === 'test') {
    context.previews?.slackMessages.push(preview);
    logs.push('Slack message simulated in test mode — preview generated.');
    return { status: 'simulated_success', outputData: { ...data, slack_preview: preview }, logs };
  }

  const slackIntegration = context.integrations.find((i) => i.provider === 'slack');

  if (!slackIntegration?.credentials) {
    logs.push('Slack integration not configured.');
    return { status: 'failed', outputData: null, logs, error: 'Slack integration not configured' };
  }

  const webhookUrl = (slackIntegration.credentials as Record<string, unknown>).webhook_url as string | undefined;

  if (!webhookUrl) {
    logs.push('Slack webhook URL missing.');
    return { status: 'failed', outputData: null, logs, error: 'Slack webhook URL missing' };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, channel }),
    });

    if (!res.ok) throw new Error(`Slack returned ${res.status}`);
    logs.push(`Slack message sent to ${channel}.`);
    return { status: 'success', outputData: { ...data, slack_delivered: true, channel }, logs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(`Slack delivery failed: ${msg}`);
    return { status: 'failed', outputData: null, logs, error: msg };
  }
}
