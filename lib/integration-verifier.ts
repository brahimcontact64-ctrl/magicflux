import type { IntegrationProvider } from '@/lib/integrations';
import nodemailer from 'nodemailer';

type VerifyResult = {
  ok: boolean;
  error?: string;
};

function safeError(message: string): string {
  return message
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/(token|password|pass|key)=([^\s&]+)/gi, '$1=[redacted]')
    .slice(0, 180);
}

function normalizeShopDomain(storeUrl: string): string {
  const trimmed = storeUrl.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      return new URL(trimmed).host;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

async function verifySlack(credentials: Record<string, string>): Promise<VerifyResult> {
  const webhook = credentials.webhook_url;
  if (!webhook) return { ok: false, error: 'Slack webhook_url is required' };

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'MagicFlux connection test' }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: safeError(`Slack verification failed (${res.status}): ${body}`) };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: safeError(error instanceof Error ? error.message : 'Slack verification failed') };
  }
}

async function verifyShopify(credentials: Record<string, string>): Promise<VerifyResult> {
  const apiKey = credentials.admin_access_token;
  const storeUrl = credentials.shop_domain;
  if (!apiKey || !storeUrl) return { ok: false, error: 'Shopify SHOP_DOMAIN and ADMIN_ACCESS_TOKEN are required' };

  const host = normalizeShopDomain(storeUrl);
  if (!host) return { ok: false, error: 'Invalid Shopify store URL' };

  try {
    const res = await fetch(`https://${host}/admin/api/2025-01/shop.json`, {
      headers: {
        'X-Shopify-Access-Token': apiKey,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: safeError(`Shopify verification failed (${res.status}): ${body}`) };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: safeError(error instanceof Error ? error.message : 'Shopify verification failed') };
  }
}

async function verifyGmail(credentials: Record<string, string>): Promise<VerifyResult> {
  const authType = (credentials.auth_type ?? 'smtp').toLowerCase();
  const fromEmail = credentials.from_email || '';

  if (!fromEmail) {
    return { ok: false, error: 'FROM_EMAIL is required' };
  }

  if (authType === 'oauth') {
    if (!credentials.client_id || !credentials.client_secret || !credentials.refresh_token) {
      return { ok: false, error: 'Gmail OAuth requires AUTH_TYPE, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, FROM_EMAIL' };
    }
    return { ok: true };
  }

  const host = credentials.smtp_host;
  const port = Number(credentials.smtp_port ?? '0');
  const user = credentials.smtp_user;
  const pass = credentials.smtp_pass;

  if (!host || !port || !user || !pass) {
    return { ok: false, error: 'Gmail SMTP requires AUTH_TYPE, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL' };
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    await transporter.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: safeError(error instanceof Error ? error.message : 'SMTP verification failed') };
  }
}

async function verifyAirtable(credentials: Record<string, string>): Promise<VerifyResult> {
  const apiKey = credentials.airtable_token;
  const baseId = credentials.base_id;
  const tableName = credentials.table_name;
  if (!apiKey || !baseId || !tableName) return { ok: false, error: 'Airtable AIRTABLE_TOKEN, BASE_ID and TABLE_NAME are required' };

  try {
    const res = await fetch(`https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}?maxRecords=1`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: safeError(`Airtable verification failed (${res.status}): ${body}`) };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: safeError(error instanceof Error ? error.message : 'Airtable verification failed') };
  }
}

export async function runIntegrationTestAction(
  provider: IntegrationProvider,
  credentials: Record<string, string>,
  action: string,
  payload?: Record<string, unknown>
): Promise<VerifyResult & { details?: Record<string, unknown> }> {
  if ((provider === 'gmail' || provider === 'email') && action === 'send_test_email') {
    const destination = String(payload?.destinationEmail ?? '').trim();
    if (!destination) return { ok: false, error: 'destinationEmail is required' };

    const authType = (credentials.auth_type ?? 'smtp').toLowerCase();
    if (authType !== 'smtp') {
      return { ok: false, error: 'Test email is only supported for Gmail SMTP connections' };
    }

    try {
      const transporter = nodemailer.createTransport({
        host: credentials.smtp_host,
        port: Number(credentials.smtp_port),
        secure: Number(credentials.smtp_port) === 465,
        auth: { user: credentials.smtp_user, pass: credentials.smtp_pass },
      });

      const result = await transporter.sendMail({
        from: credentials.from_email,
        to: destination,
        subject: 'MagicFlux test email',
        text: 'MagicFlux integration test email.',
      });

      return { ok: true, details: { messageId: result.messageId } };
    } catch (error) {
      return { ok: false, error: safeError(error instanceof Error ? error.message : 'Failed to send test email') };
    }
  }

  if (provider === 'slack' && action === 'send_test_message') {
    try {
      const res = await fetch(credentials.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'MagicFlux test Slack message' }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, error: safeError(`Slack test failed (${res.status}): ${body}`) };
      }
      return { ok: true, details: { status: res.status } };
    } catch (error) {
      return { ok: false, error: safeError(error instanceof Error ? error.message : 'Slack test failed') };
    }
  }

  if (provider === 'airtable' && action === 'create_test_record') {
    try {
      const res = await fetch(
        `https://api.airtable.com/v0/${encodeURIComponent(credentials.base_id)}/${encodeURIComponent(credentials.table_name)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.airtable_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fields: { Name: 'MagicFlux test', Source: 'MagicFlux' } }),
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, error: safeError(`Airtable test failed (${res.status}): ${body}`) };
      }
      const created = await res.json() as Record<string, unknown>;
      return { ok: true, details: { recordId: created.id } };
    } catch (error) {
      return { ok: false, error: safeError(error instanceof Error ? error.message : 'Airtable test failed') };
    }
  }

  if (provider === 'shopify' && action === 'verify_shop') {
    const result = await verifyShopify(credentials);
    return { ok: result.ok, error: result.error };
  }

  return { ok: false, error: 'Unsupported test action' };
}

export async function verifyIntegrationCredentials(
  provider: IntegrationProvider,
  credentials: Record<string, string>
): Promise<VerifyResult> {
  if (provider === 'slack') return verifySlack(credentials);
  if (provider === 'shopify') return verifyShopify(credentials);
  if (provider === 'gmail' || provider === 'email') return verifyGmail(credentials);
  if (provider === 'airtable') return verifyAirtable(credentials);
  return { ok: false, error: 'Unsupported provider' };
}
