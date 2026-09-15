import type { EngineNode, NodeHandlerContext, NodeHandlerResult } from '../types';
import nodemailer from 'nodemailer';
import dns from 'node:dns';
import net from 'node:net';
import { redactText } from '@/lib/security/redact';
import { asRecord, resolveFieldReference, resolveTemplateParamValue } from './json-field-reference';

/**
 * Phase 9.9.6 -- Part A: explicit, bounded SMTP timeouts.
 *
 * Root cause of the production incident: nodemailer.createTransport() was
 * given no timeout options at all, so its own defaults applied --
 * connectionTimeout alone is 2 MINUTES. A single stuck connection attempt
 * (see resolveSmtpIPv4Host() below for why one occurred) could therefore
 * block this node for up to 2 minutes per attempt, repeated across every
 * retry, for many multiples of the platform's overall execution budget
 * (RUNTIME_MAX_EXECUTION_DURATION_MS, 5 minutes by default) before ever
 * failing. These are deliberately materially shorter than that budget so
 * a single SMTP attempt can never itself consume more than a small
 * fraction of it, while still being generous enough for a real, healthy
 * connection (typical Gmail/SMTP round trips are well under 2s).
 */
const SMTP_CONNECTION_TIMEOUT_MS = Number(process.env.RUNTIME_SMTP_CONNECTION_TIMEOUT_MS ?? 10_000);
const SMTP_GREETING_TIMEOUT_MS = Number(process.env.RUNTIME_SMTP_GREETING_TIMEOUT_MS ?? 10_000);
const SMTP_SOCKET_TIMEOUT_MS = Number(process.env.RUNTIME_SMTP_SOCKET_TIMEOUT_MS ?? 20_000);
const GMAIL_API_TIMEOUT_MS = Number(process.env.RUNTIME_GMAIL_API_TIMEOUT_MS ?? 20_000);

/**
 * Phase 9.9.6 -- Part A: prefer/force usable IPv4 resolution for the SMTP
 * connection instead of letting nodemailer's own resolver (which combines
 * IPv4 AND IPv6 addresses and picks ONE AT RANDOM -- see
 * node_modules/nodemailer/lib/shared/index.js's formatDNSValue()) risk
 * picking an IPv6 address on infrastructure with no outbound IPv6 route
 * (the confirmed production failure: `connect ENETUNREACH
 * 2a00:1450:...:587`, a Google IPv6 address).
 *
 * Deliberately scoped to only this one handler's own SMTP connection --
 * this never touches Node's global DNS resolution order
 * (dns.setDefaultResultOrder) or any other node type's networking
 * (the AI Classifier's OpenAI calls, the generic HTTP node, Slack/Airtable
 * webhooks all keep using whatever the platform's normal, unmodified
 * fetch()/DNS behavior already is).
 *
 * No IP is ever hardcoded -- the address is resolved fresh via DNS at
 * send time. `tlsServername` is always the ORIGINAL hostname, never the
 * resolved IP, so TLS certificate hostname verification (SNI and
 * certificate CN/SAN matching) still validates against the real mail
 * server identity -- connecting to a raw IP without setting this would
 * either fail certificate validation or silently skip hostname checking,
 * neither of which is acceptable; this preserves full validation while
 * only changing which address family carries the connection.
 *
 * Falls back to the original hostname (unresolved, nodemailer's own
 * resolution applies) if no IPv4 address can be found at all -- a
 * hypothetical IPv6-only SMTP provider still works, just without this
 * specific fix; it would need a real IPv6 route to function regardless.
 */
export async function resolveSmtpIPv4Host(host: string): Promise<{ connectHost: string; tlsServername: string }> {
  if (!host || net.isIP(host)) {
    return { connectHost: host, tlsServername: host };
  }

  try {
    const addresses = await dns.promises.resolve4(host);
    if (addresses.length > 0) {
      return { connectHost: addresses[0], tlsServername: host };
    }
  } catch {
    // No A records via a direct DNS query -- fall through to the OS
    // resolver, which may succeed via /etc/hosts or a different path.
  }

  try {
    const result = await dns.promises.lookup(host, { family: 4 });
    return { connectHost: result.address, tlsServername: host };
  } catch {
    // Genuinely no IPv4 route/record found -- preserve prior behavior
    // (nodemailer's own resolver, which may still succeed via IPv6 if the
    // network actually supports it) rather than hard-failing the node.
    return { connectHost: host, tlsServername: host };
  }
}

type SmtpErrorLike = Error & { code?: string; command?: string; responseCode?: number };

/**
 * Phase 9.9.6 -- Part E: distinguishes a pre-connect failure (DNS
 * failure, TCP ENETUNREACH/ECONNREFUSED, a connection/greeting/socket
 * timeout before the SMTP transaction reached the DATA command) -- nothing
 * was ever transmitted, so it is always safe to retry -- from a failure
 * during or after the DATA command, where the message body may have
 * already been fully transmitted and the receiving server may have
 * already accepted it before the connection dropped and the final "250
 * OK" acknowledgement was lost. nodemailer tags every SMTP-protocol error
 * with the last command in flight (err.command); 'DATA' is the exact,
 * documented signal for this ambiguous window. Retrying an ambiguous
 * send risks a real duplicate email to the recipient, so it is marked
 * nonRetryable instead -- a safe delivery_unknown/manual-review-required
 * outcome rather than a blind assumption that "failed" means "unsent."
 */
function classifySmtpFailure(error: unknown): { nonRetryable: boolean; message: string } {
  const err = error as SmtpErrorLike | undefined;
  const originalMessage = err instanceof Error ? err.message : 'Email delivery failed';

  if (err?.command === 'DATA') {
    return {
      nonRetryable: true,
      message:
        `AMBIGUOUS_DELIVERY: the SMTP connection failed during or after message transmission ` +
        `(command: DATA) -- the receiving server may already have accepted this email. Not ` +
        `retrying automatically to avoid duplicate delivery; this requires manual verification ` +
        `before resending. Original error: ${originalMessage}`,
    };
  }

  return { nonRetryable: false, message: originalMessage };
}

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
    // Consistency with the SMTP path's own explicit bounded timeouts --
    // Node's fetch() has no default timeout, so an unbounded hang here
    // would defeat the execution deadline the exact same way an
    // unbounded SMTP connect did.
    signal: AbortSignal.timeout(GMAIL_API_TIMEOUT_MS),
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
      // The Gmail API is a single request/response call, not SMTP's
      // multi-command protocol -- there is no "message accepted but ack
      // lost" window here; a failed fetch() means the request never
      // completed, so this is always safely retryable.
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
    // Part A: resolve to a concrete IPv4 address ourselves (scoped to this
    // one connection only) and keep the real hostname for TLS validation.
    const { connectHost, tlsServername } = await resolveSmtpIPv4Host(host);

    // Preserves both port 465 (implicit TLS, secure:true -- nodemailer
    // connects via tls.connect directly) and port 587 (STARTTLS,
    // secure:false -- nodemailer connects plain and upgrades once the
    // server advertises STARTTLS) exactly as before; only the resolved
    // connection address and explicit timeouts are new.
    const transporter = nodemailer.createTransport({
      host: connectHost,
      port,
      secure: port === 465,
      auth: { user, pass },
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      tls: { servername: tlsServername },
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
    const classification = classifySmtpFailure(error);
    logs.push(`Email delivery failed: ${classification.message}`);
    return {
      status: 'failed',
      outputData: null,
      logs,
      error: classification.message,
      nonRetryable: classification.nonRetryable,
    };
  }
}
