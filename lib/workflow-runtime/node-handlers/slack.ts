import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';
import { resolveNotificationTemplate } from './json-field-reference';
import { fetchWithOutcome, indeterminateFailure, configBlockedFailure, isAuthRejectionStatus } from './provider-outcome';

/**
 * Phase 9.9.14 -- Part C/J: Slack's Web API quirk -- an auth failure often
 * comes back as HTTP 200 with `{ok:false, error:'invalid_auth'}` rather
 * than a 401/403 status, so isAuthRejectionStatus() alone would miss most
 * real Slack credential failures. These specific error codes are Slack's
 * own documented permanent-auth-failure vocabulary (never a transient
 * condition) -- see https://api.slack.com/methods/chat.postMessage#errors.
 */
const SLACK_AUTH_ERROR_CODES = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'missing_scope']);

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

  // Phase 9.9.4A -- text now goes through the shared safe template resolver
  // (same one email.ts/airtable.ts use), so an embedded
  // {{$json["field"]}} reference actually interpolates instead of being
  // sent to Slack as literal, unresolved template text. Credential
  // resolution below is untouched.
  //
  // Phase 9.9.9 -- resolveNotificationTemplate() additionally supports the
  // optional-block primitive for a concise summary line built from several
  // genuinely-optional fields (e.g. service/budget/desired start) -- a
  // missing one drops just its own " | "-delimited segment (when the
  // separator is authored inside the block), never the whole message.
  const textResult = resolveNotificationTemplate(getParam(node, ['text', 'message']), data);
  if (!textResult.ok) {
    const error = `Slack text: ${textResult.reason}`;
    logs.push(error);
    return { status: 'failed', outputData: null, logs, error };
  }
  const text = textResult.value || String(data.message ?? `MagicFlux notification from ${node.name ?? 'workflow'}`);

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

  // Phase 9.9.11 -- Part E/H: Slack's chat.postMessage has no caller-
  // supplied idempotency key. A response actually received from Slack
  // (ok:true or a clean `{ok:false, error}`) is trustworthy -- Slack
  // explicitly told us what happened, safe to retry a real rejection. A
  // thrown fetch() error (timeout/connection reset) means the message may
  // already have posted before the response was lost -- classified
  // indeterminate and never auto-retried, so a lost response can never
  // silently become a duplicate Slack message.
  //
  // Bot token (Slack Web API) is the current credential type — see
  // lib/credentials/provider-registry.ts. Incoming-webhook URL is kept as a
  // fallback for integrations connected before the bot-token flow existed.
  if (botToken) {
    const attempt = await fetchWithOutcome('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text }),
    });

    if (attempt.kind === 'indeterminate') {
      logs.push(`Slack delivery: ${attempt.message}`);
      return { status: 'failed', outputData: null, logs, ...indeterminateFailure('Slack message', attempt.message) };
    }

    const res = attempt.response;
    const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; ts?: string } | null;

    if (!res.ok || !body?.ok) {
      const msg = body?.error ? `Slack API error: ${body.error}` : `Slack returned ${res.status}`;
      logs.push(`Slack delivery failed: ${msg}`);
      if (isAuthRejectionStatus(res.status) || (body?.error && SLACK_AUTH_ERROR_CODES.has(body.error))) {
        return { status: 'failed', outputData: null, logs, ...configBlockedFailure('Slack message', res.status, msg) };
      }
      return { status: 'failed', outputData: null, logs, error: msg };
    }

    logs.push(`Slack message sent to ${channel}.`);
    return { status: 'success', outputData: { ...data, slack_delivered: true, channel, ts: body.ts }, logs };
  }

  if (!webhookUrl) {
    logs.push('Slack credentials missing (no bot token or webhook URL).');
    return { status: 'failed', outputData: null, logs, error: 'Slack credentials incomplete' };
  }

  const attempt = await fetchWithOutcome(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, channel }),
  });

  if (attempt.kind === 'indeterminate') {
    logs.push(`Slack delivery: ${attempt.message}`);
    return { status: 'failed', outputData: null, logs, ...indeterminateFailure('Slack message', attempt.message) };
  }

  const res = attempt.response;
  if (!res.ok) {
    const msg = `Slack returned ${res.status}`;
    logs.push(`Slack delivery failed: ${msg}`);
    if (isAuthRejectionStatus(res.status)) {
      return { status: 'failed', outputData: null, logs, ...configBlockedFailure('Slack message', res.status, msg) };
    }
    return { status: 'failed', outputData: null, logs, error: msg };
  }

  logs.push(`Slack message sent to ${channel}.`);
  return { status: 'success', outputData: { ...data, slack_delivered: true, channel }, logs };
}
