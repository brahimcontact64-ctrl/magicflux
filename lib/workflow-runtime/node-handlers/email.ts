import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';
import nodemailer from 'nodemailer';

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

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function encodeHeaderWord(value: string): string {
  // RFC 2047 encoded-word for non-ASCII subject/name content.
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

async function sendViaGmailApi(
  accessToken: string,
  opts: { to: string; from?: string; subject: string; body: string }
): Promise<{ id: string }> {
  const headers = [
    opts.from ? `From: ${opts.from}` : null,
    `To: ${opts.to}`,
    `Subject: ${encodeHeaderWord(opts.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter(Boolean);
  const mime = `${headers.join('\r\n')}\r\n\r\n${opts.body}`;

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: base64UrlEncode(mime) }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Gmail API returned ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const result = (await res.json()) as { id?: string };
  return { id: String(result.id ?? 'unknown') };
}

export async function emailHandler(
  node: EngineNode,
  inputData: unknown,
  context: NodeHandlerContext
): Promise<NodeHandlerResult> {
  const logs: string[] = [];
  const data = asRecord(inputData);

  const to = getParam(node, ['to', 'emailTo', 'recipient']) || String(data.email ?? 'user@example.com');
  const subject = getParam(node, ['subject']) || `Message from ${node.name ?? 'MagicFlux'}`;
  const body = getParam(node, ['text', 'html', 'message']) || 'Automated message from MagicFlux.';

  const preview = { nodeName: node.name ?? node.id, to, subject, body };

  if (context.mode === 'test') {
    context.previews?.emails.push(preview);
    logs.push('Email send simulated in test mode — preview generated.');
    return { status: 'simulated_success', outputData: { ...data, email_preview: preview }, logs };
  }

  // Gmail (OAuth) is the current credential type — see lib/credentials/provider-registry.ts.
  // Legacy SMTP integrations (provider 'email') are kept as a fallback for accounts
  // connected before the OAuth flow existed.
  const gmailIntegration = context.integrations.find((i) => i.provider === 'gmail');
  const gmailAccessToken = (gmailIntegration?.credentials as Record<string, unknown> | undefined)?.access_token as
    | string
    | undefined;

  if (gmailAccessToken) {
    try {
      const from = (gmailIntegration?.credentials as Record<string, unknown> | undefined)?.email as string | undefined;
      const info = await sendViaGmailApi(gmailAccessToken, { to, from, subject, body });
      logs.push(`Email sent to ${to} via Gmail API. messageId=${info.id}`);
      return { status: 'success', outputData: { ...data, sent_to: to, messageId: info.id }, logs };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Gmail delivery failed';
      logs.push(`Gmail delivery failed: ${msg}`);
      return { status: 'failed', outputData: null, logs, error: msg };
    }
  }

  const smtpIntegration = context.integrations.find((i) => i.provider === 'email');

  if (!smtpIntegration?.credentials) {
    logs.push('Email integration not configured. Connect Gmail in Settings → Credentials.');
    return { status: 'failed', outputData: null, logs, error: 'Email integration not configured' };
  }

  const host = String(smtpIntegration.credentials.smtp_host ?? '');
  const port = Number(smtpIntegration.credentials.smtp_port ?? 0);
  const user = String(smtpIntegration.credentials.smtp_user ?? '');
  const pass = String(smtpIntegration.credentials.smtp_pass ?? '');
  const from = String(smtpIntegration.credentials.from_email ?? user);

  if (!host || !port || !user || !pass || !from) {
    logs.push('Email credentials incomplete.');
    return { status: 'failed', outputData: null, logs, error: 'Email credentials incomplete' };
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text: body,
    });

    logs.push(`Email sent to ${to}. messageId=${info.messageId}`);
    return { status: 'success', outputData: { ...data, sent_to: to, messageId: info.messageId }, logs };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Email delivery failed';
    logs.push(`Email delivery failed: ${msg}`);
    return { status: 'failed', outputData: null, logs, error: msg };
  }
}
