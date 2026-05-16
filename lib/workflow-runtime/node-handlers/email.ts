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

  // Live mode: use configured provider
  const smtpIntegration = context.integrations.find((i) => i.provider === 'email');

  if (!smtpIntegration?.credentials) {
    logs.push('Email integration not configured.');
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
