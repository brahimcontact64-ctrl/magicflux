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

  const creds = slackIntegration.credentials as Record<string, unknown>;
  const botToken = creds.bot_token as string | undefined;
  const webhookUrl = creds.webhook_url as string | undefined;

  // Bot token (Slack Web API) is the current credential type — see
  // lib/credentials/provider-registry.ts. Incoming-webhook URL is kept as a
  // fallback for integrations connected before the bot-token flow existed.
  if (botToken) {
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, text }),
      });

      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; ts?: string } | null;

      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ? `Slack API error: ${body.error}` : `Slack returned ${res.status}`);
      }

      logs.push(`Slack message sent to ${channel}.`);
      return { status: 'success', outputData: { ...data, slack_delivered: true, channel, ts: body.ts }, logs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logs.push(`Slack delivery failed: ${msg}`);
      return { status: 'failed', outputData: null, logs, error: msg };
    }
  }

  if (!webhookUrl) {
    logs.push('Slack credentials missing (no bot token or webhook URL).');
    return { status: 'failed', outputData: null, logs, error: 'Slack credentials incomplete' };
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
