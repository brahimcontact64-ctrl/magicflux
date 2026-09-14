import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';
import nodemailer from 'nodemailer';
import { redactText } from '@/lib/security/redact';
import { asRecord, resolveFieldReference, resolveTemplateParamValue } from './json-field-reference';

function getParam(node: EngineNode, keys: string[]): string {
  const params = node.parameters ?? {};
  for (const key of keys) {
    const val = params[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return '';
}

/**
 * Phase 9.8.7 -- resolves a node parameter through the same narrow
 * `={{$json["field"]}}` shape condition.ts already supports (see
 * ./json-field-reference), then falls through if unresolved. A static
 * literal (the overwhelmingly common case -- e.g. "nssmpro@gmail.com") is
 * returned completely unchanged, since it never matches that pattern:
 * static configuration remains authoritative and is never affected by
 * runtime input. Only a parameter that intentionally uses this exact
 * expression syntax reads from the trigger payload at all.
 */
function resolveParam(node: EngineNode, keys: string[], data: Record<string, unknown>): string {
  const raw = getParam(node, keys);
  if (!raw) return '';
  const resolved = resolveFieldReference(raw, data);
  if (resolved === undefined || resolved === null) return '';
  return typeof resolved === 'string' ? resolved : String(resolved);
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
    throw new Error(`Gmail API returned ${res.status}: ${redactText(errBody.slice(0, 200))}`);
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

  // Recipient resolution is unchanged (Phase 9.9.4A only extends subject/body
  // to the embedded-template resolver) -- still the narrow whole-value-only
  // shape, falling back to data.email / a placeholder.
  const to = resolveParam(node, ['to', 'emailTo', 'recipient'], data) || String(data.email ?? 'user@example.com');

  // Phase 9.9.4A -- subject/body now go through the shared safe template
  // resolver, which additionally supports one or more {{$json["field"]}}
  // references EMBEDDED inside a larger string (e.g.
  // "We have a new Hot lead: {{$json[\"name\"]}}"), not just a whole-value
  // expression. A reference to a field genuinely missing from this
  // execution's data fails the node rather than sending literal
  // "undefined"/unresolved template text to a real recipient.
  const subjectResult = resolveTemplateParamValue(getParam(node, ['subject']), data);
  if (!subjectResult.ok) {
    const error = `Email subject: ${subjectResult.reason}`;
    logs.push(error);
    return { status: 'failed', outputData: null, logs, error };
  }
  const subject = subjectResult.value || `Message from ${node.name ?? 'MagicFlux'}`;

  const bodyResult = resolveTemplateParamValue(getParam(node, ['text', 'html', 'message']), data);
  if (!bodyResult.ok) {
    const error = `Email body: ${bodyResult.reason}`;
    logs.push(error);
    return { status: 'failed', outputData: null, logs, error };
  }
  const body = bodyResult.value || 'Automated message from MagicFlux.';

  const preview = { nodeName: node.name ?? node.id, to, subject, body };

  if (context.mode === 'test') {
    context.previews?.emails.push(preview);
    logs.push('Email send simulated in test mode — preview generated.');
    return { status: 'simulated_success', outputData: { ...data, email_preview: preview }, logs };
  }

  // Gmail (OAuth) is the current credential type — see lib/credentials/provider-registry.ts.
  // Legacy SMTP integrations (provider 'email') are kept as a fallback for accounts
  // connected before the OAuth flow existed.
  //
  // Phase 9.8.5 -- lib/user-integrations.ts's getUserIntegrations() now
  // canonicalizes a stored 'email' row to provider 'gmail' at load time (so
  // Builder readiness and runtime resolution agree it satisfies a required
  // 'gmail'), so the SAME legacy SMTP integration can arrive here labeled
  // 'gmail' instead of 'email'. Distinguish by credential shape, not label:
  // an access_token means real OAuth; smtp_host means this is the legacy
  // SMTP credential regardless of which provider label it carries. The
  // 'email' label lookup is kept as defense in depth for any context that
  // still passes it unlabeled.
  const gmailIntegration = context.integrations.find((i) => i.provider === 'gmail');
  const gmailCredentials = (gmailIntegration?.credentials as Record<string, unknown> | undefined) ?? {};
  const gmailAccessToken = gmailCredentials.access_token as string | undefined;

  if (gmailAccessToken) {
    try {
      const from = gmailCredentials.email as string | undefined;
      const info = await sendViaGmailApi(gmailAccessToken, { to, from, subject, body });
      logs.push(`Email sent to ${to} via Gmail API. messageId=${info.id}`);
      return { status: 'success', outputData: { ...data, sent_to: to, messageId: info.id }, logs };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Gmail delivery failed';
      logs.push(`Gmail delivery failed: ${msg}`);
      return { status: 'failed', outputData: null, logs, error: msg };
    }
  }

  const smtpIntegration =
    context.integrations.find((i) => i.provider === 'email') ??
    (gmailCredentials.smtp_host ? gmailIntegration : undefined);

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
