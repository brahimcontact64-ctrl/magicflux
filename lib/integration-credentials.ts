import type { IntegrationProvider } from '@/lib/integrations';

export type Provider = IntegrationProvider;

export type NormalizedCredentials = Record<string, string>;

export function normalizeCredentials(provider: Provider, raw: Record<string, unknown>): NormalizedCredentials {
  const take = (keys: string[]) => {
    for (const k of keys) {
      const val = raw[k];
      if (typeof val === 'string' && val.trim().length > 0) return val.trim();
    }
    return '';
  };

  if (provider === 'email') {
    return {
      smtp_host: take(['SMTP_HOST', 'smtp_host']),
      smtp_port: take(['SMTP_PORT', 'smtp_port']),
      smtp_user: take(['SMTP_USER', 'smtp_user']),
      smtp_pass: take(['SMTP_PASS', 'smtp_pass']),
      from_email: take(['FROM_EMAIL', 'from_email']),
    };
  }

  if (provider === 'slack') {
    return {
      webhook_url: take(['WEBHOOK_URL', 'webhook_url']),
    };
  }

  if (provider === 'airtable') {
    return {
      airtable_token: take(['AIRTABLE_TOKEN', 'airtable_token', 'api_key']),
      base_id: take(['BASE_ID', 'base_id']),
      table_name: take(['TABLE_NAME', 'table_name']),
    };
  }

  return {
    shop_domain: take(['SHOP_DOMAIN', 'shop_domain', 'store_url']),
    admin_access_token: take(['ADMIN_ACCESS_TOKEN', 'admin_access_token', 'api_key']),
  };
}

export function validateRequiredCredentials(provider: Provider, creds: NormalizedCredentials): string | null {
  const has = (...keys: string[]) => keys.every((k) => !!creds[k]);

  if (provider === 'email' && !has('smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'from_email')) {
    return 'Email requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL';
  }

  if (provider === 'slack' && !has('webhook_url')) {
    return 'Slack requires WEBHOOK_URL';
  }

  if (provider === 'airtable' && !has('airtable_token', 'base_id', 'table_name')) {
    return 'Airtable requires AIRTABLE_TOKEN, BASE_ID, TABLE_NAME';
  }

  if (provider === 'shopify' && !has('shop_domain', 'admin_access_token')) {
    return 'Shopify requires SHOP_DOMAIN and ADMIN_ACCESS_TOKEN';
  }

  return null;
}

export function maskIntegrationInfo(provider: Provider, creds: NormalizedCredentials): string {
  const maskToken = (value: string) => {
    if (!value) return '-';
    if (value.length <= 6) return '***';
    return `${value.slice(0, 3)}***${value.slice(-3)}`;
  };

  if (provider === 'email') {
    return creds.smtp_user ? `SMTP: ${creds.smtp_user}` : 'SMTP configured';
  }

  if (provider === 'slack') {
    return creds.webhook_url ? `Webhook: ${maskToken(creds.webhook_url)}` : 'Webhook configured';
  }

  if (provider === 'airtable') {
    return creds.base_id ? `Base: ${creds.base_id}` : 'Airtable configured';
  }

  return creds.shop_domain ? `Shop: ${creds.shop_domain}` : 'Shopify configured';
}
