import { CredentialRequirement, DependencyItem, VariableSchema } from './ai-engine/types';

interface TemplateEnrichment {
  credentials: CredentialRequirement[];
  dependencies: DependencyItem[];
  variables: VariableSchema[];
}

const SMTP_DEPS: DependencyItem[] = [
  {
    id: 'smtp',
    name: 'SMTP Email Access',
    type: 'smtp',
    required: true,
    description: 'Gmail (with App Password), SendGrid, or Mailgun for sending emails',
    setupUrl: 'https://support.google.com/accounts/answer/185833',
    icon: 'Mail'
  }
];

const SMTP_VARS: VariableSchema[] = [
  { key: 'SMTP_HOST', type: 'string', required: true, description: 'SMTP server hostname', example: 'smtp.gmail.com', group: 'SMTP' },
  { key: 'SMTP_PORT', type: 'number', required: true, description: 'SMTP server port', example: '587', group: 'SMTP' },
  { key: 'SMTP_USER', type: 'email', required: true, description: 'SMTP login email', example: 'you@gmail.com', group: 'SMTP' },
  { key: 'SMTP_PASS', type: 'password', required: true, description: 'SMTP password or app password', example: 'xxxx xxxx xxxx xxxx', group: 'SMTP' }
];

const AIRTABLE_DEPS: DependencyItem[] = [
  {
    id: 'airtable',
    name: 'Airtable Account',
    type: 'account',
    required: true,
    description: 'Free Airtable account with a configured base',
    setupUrl: 'https://airtable.com/signup',
    icon: 'Table'
  },
  {
    id: 'airtable_key',
    name: 'Airtable API Key',
    type: 'api_key',
    required: true,
    description: 'Personal access token from Airtable',
    setupUrl: 'https://airtable.com/account',
    icon: 'Key'
  }
];

const AIRTABLE_VARS: VariableSchema[] = [
  { key: 'AIRTABLE_API_KEY', type: 'api_key', required: true, description: 'Airtable Personal Access Token', example: 'patXXXXXXXXXXXXXX', group: 'Airtable' },
  { key: 'AIRTABLE_BASE_ID', type: 'string', required: true, description: 'Airtable Base ID from URL', example: 'appXXXXXXXXXXXXXX', group: 'Airtable' }
];

const N8N_DEPS: DependencyItem[] = [
  {
    id: 'n8n',
    name: 'n8n Instance',
    type: 'tool',
    required: true,
    description: 'Self-hosted or n8n Cloud instance for running the workflow',
    setupUrl: 'https://docs.n8n.io/hosting/',
    icon: 'Server'
  }
];

const ENRICHMENTS: Record<string, TemplateEnrichment> = {
  'tenant-maintenance': {
    credentials: [
      { service: 'SMTP / Email', type: 'smtp', description: 'For sending notifications', docsUrl: 'https://docs.n8n.io/integrations/builtin/credentials/smtp/' },
      { service: 'Airtable', type: 'airtable_personal_access_token', description: 'For ticket management', docsUrl: 'https://airtable.com/developers/web/api/introduction' }
    ],
    dependencies: [
      ...N8N_DEPS,
      ...SMTP_DEPS,
      ...AIRTABLE_DEPS,
      { id: 'form', name: 'Intake Form', type: 'tool', required: true, description: 'Typeform, Tally, or your website form that POSTs to the webhook', setupUrl: 'https://tally.so', icon: 'FormInput' }
    ],
    variables: [
      { key: 'FROM_EMAIL', type: 'email', required: true, description: 'Sender email address', example: 'noreply@yourproperty.com', group: 'Email' },
      { key: 'PROPERTY_MANAGER_EMAIL', type: 'email', required: true, description: 'Property manager notification email', example: 'manager@yourproperty.com', group: 'Email' },
      ...AIRTABLE_VARS,
      ...SMTP_VARS
    ]
  },
  'rent-reminder': {
    credentials: [
      { service: 'SMTP / Email', type: 'smtp', description: 'For sending monthly reminders', docsUrl: 'https://docs.n8n.io/integrations/builtin/credentials/smtp/' },
      { service: 'Airtable', type: 'airtable_personal_access_token', description: 'For reading tenant data', docsUrl: 'https://airtable.com/developers/web/api/introduction' }
    ],
    dependencies: [
      ...N8N_DEPS,
      ...SMTP_DEPS,
      ...AIRTABLE_DEPS,
      { id: 'cron', name: 'Scheduled Trigger', type: 'configuration', required: true, description: 'n8n Schedule node — runs at 9 AM on 1st of month', icon: 'Clock' }
    ],
    variables: [
      { key: 'FROM_EMAIL', type: 'email', required: true, description: 'Sender email address', example: 'noreply@yourproperty.com', group: 'Email' },
      { key: 'PAYMENT_METHODS', type: 'string', required: true, description: 'List of accepted payment methods', example: 'Bank transfer, Zelle, or check', group: 'Business' },
      ...AIRTABLE_VARS,
      ...SMTP_VARS
    ]
  },
  'leasing-inquiry': {
    credentials: [
      { service: 'SMTP / Email', type: 'smtp', description: 'For sending inquiry responses', docsUrl: 'https://docs.n8n.io/integrations/builtin/credentials/smtp/' },
      { service: 'HubSpot', type: 'hubspot_private_app_token', description: 'For CRM lead management', docsUrl: 'https://developers.hubspot.com/docs/api/private-apps' }
    ],
    dependencies: [
      ...N8N_DEPS,
      ...SMTP_DEPS,
      { id: 'hubspot', name: 'HubSpot Account', type: 'account', required: true, description: 'Free HubSpot CRM for lead tracking', setupUrl: 'https://www.hubspot.com/products/crm', icon: 'Users' },
      { id: 'form', name: 'Leasing Inquiry Form', type: 'tool', required: true, description: 'Website contact form or Typeform POSTing to the webhook', setupUrl: 'https://tally.so', icon: 'FormInput' }
    ],
    variables: [
      { key: 'FROM_EMAIL', type: 'email', required: true, description: 'Sender email', example: 'leasing@yourproperty.com', group: 'Email' },
      { key: 'LEASING_AGENT_EMAIL', type: 'email', required: true, description: 'Leasing agent notification email', example: 'agent@yourproperty.com', group: 'Email' },
      { key: 'LISTINGS_URL', type: 'url', required: false, description: 'URL of your property listings page', example: 'https://yourproperty.com/listings', group: 'Business' },
      { key: 'HUBSPOT_API_KEY', type: 'api_key', required: true, description: 'HubSpot Private App Token', example: 'pat-na1-XXXX', group: 'HubSpot' },
      ...SMTP_VARS
    ]
  },
  'guest-messaging': {
    credentials: [
      { service: 'SMTP / Email', type: 'smtp', description: 'For sending guest communications', docsUrl: 'https://docs.n8n.io/integrations/builtin/credentials/smtp/' }
    ],
    dependencies: [
      ...N8N_DEPS,
      ...SMTP_DEPS,
      { id: 'airbnb_connect', name: 'Airbnb Booking Source', type: 'configuration', required: true, description: 'Zapier/Make.com trigger or email parser to forward booking webhooks', setupUrl: 'https://zapier.com', icon: 'Webhook' }
    ],
    variables: [
      { key: 'HOST_EMAIL', type: 'email', required: true, description: 'Your host email address', example: 'yourname@email.com', group: 'Host' },
      { key: 'HOST_PHONE', type: 'string', required: false, description: 'Host phone for guest contact', example: '+1 (555) 000-0000', group: 'Host' },
      { key: 'PROPERTY_ADDRESS', type: 'string', required: true, description: 'Full property address', example: '123 Main St, City, State 12345', group: 'Property' },
      { key: 'PROPERTY_ACCESS_CODE', type: 'string', required: true, description: 'Door/lockbox access code', example: '1234', group: 'Property' },
      { key: 'CHECKIN_TIME', type: 'string', required: true, description: 'Check-in time', example: '3:00 PM', group: 'Property' },
      { key: 'WIFI_NETWORK', type: 'string', required: true, description: 'WiFi network name', example: 'PropertyName_Guest', group: 'Property' },
      { key: 'WIFI_PASSWORD', type: 'password', required: true, description: 'WiFi password', example: 'yourpassword', group: 'Property' },
      ...SMTP_VARS
    ]
  },
  'cleaning-turnover': {
    credentials: [
      { service: 'SMTP / Email', type: 'smtp', description: 'For sending cleaning notifications', docsUrl: 'https://docs.n8n.io/integrations/builtin/credentials/smtp/' }
    ],
    dependencies: [
      ...N8N_DEPS,
      ...SMTP_DEPS,
      { id: 'checkout_source', name: 'Checkout Event Source', type: 'configuration', required: true, description: 'A trigger to detect guest checkouts (manual, Zapier, or iCal)', icon: 'Calendar' }
    ],
    variables: [
      { key: 'HOST_EMAIL', type: 'email', required: true, description: 'Host email address', example: 'yourname@email.com', group: 'Host' },
      { key: 'CLEANING_TEAM_EMAIL', type: 'email', required: true, description: 'Cleaning team email address', example: 'cleaners@email.com', group: 'Operations' },
      ...SMTP_VARS
    ]
  },
  'checkin-checkout': {
    credentials: [
      { service: 'SMTP / Email', type: 'smtp', description: 'For guest communications', docsUrl: 'https://docs.n8n.io/integrations/builtin/credentials/smtp/' },
      { service: 'Google Calendar', type: 'google_oauth2', description: 'For logging events', docsUrl: 'https://docs.n8n.io/integrations/builtin/credentials/google/' }
    ],
    dependencies: [
      ...N8N_DEPS,
      ...SMTP_DEPS,
      { id: 'gcal', name: 'Google Calendar', type: 'account', required: false, description: 'Google Calendar for logging check-in/out events', setupUrl: 'https://calendar.google.com', icon: 'Calendar' }
    ],
    variables: [
      { key: 'HOST_EMAIL', type: 'email', required: true, description: 'Host email address', example: 'yourname@email.com', group: 'Host' },
      { key: 'HOST_PHONE', type: 'string', required: false, description: 'Host phone number', example: '+1 (555) 000-0000', group: 'Host' },
      { key: 'REVIEW_LINK', type: 'url', required: false, description: 'Airbnb review link', example: 'https://airbnb.com/your-review-link', group: 'Business' },
      { key: 'GOOGLE_CALENDAR_ID', type: 'string', required: false, description: 'Google Calendar ID', example: 'your-calendar-id@group.calendar.google.com', group: 'Calendar' },
      ...SMTP_VARS
    ]
  },
  'abandoned-cart': {
    credentials: [
      { service: 'SMTP / Email', type: 'smtp', description: 'For recovery email sequence', docsUrl: 'https://docs.n8n.io/integrations/builtin/credentials/smtp/' },
      { service: 'Shopify', type: 'shopify_api_key', description: 'For cart data access', docsUrl: 'https://shopify.dev/docs/apps/auth/admin-app-access-tokens' }
    ],
    dependencies: [
      ...N8N_DEPS,
      ...SMTP_DEPS,
      { id: 'shopify', name: 'Shopify Store', type: 'account', required: true, description: 'Active Shopify store with abandoned checkout webhooks enabled', setupUrl: 'https://partners.shopify.com', icon: 'ShoppingBag' },
      { id: 'shopify_webhook', name: 'Shopify Checkout Webhook', type: 'configuration', required: true, description: 'Shopify Admin → Settings → Notifications → Webhooks → "Checkout abandoned"', icon: 'Webhook' },
      { id: 'discount_code', name: 'Recovery Discount Code', type: 'configuration', required: true, description: 'Create a Shopify discount code (e.g. COMEBACK10) for the second email', icon: 'Tag' }
    ],
    variables: [
      { key: 'STORE_EMAIL', type: 'email', required: true, description: 'Store notification email', example: 'noreply@yourstore.com', group: 'Store' },
      { key: 'SHOPIFY_STORE_URL', type: 'url', required: true, description: 'Your Shopify store URL', example: 'your-store.myshopify.com', group: 'Shopify' },
      { key: 'SHOPIFY_ACCESS_TOKEN', type: 'api_key', required: true, description: 'Shopify Admin API access token', example: 'shpat_XXXXXXXXXXXX', group: 'Shopify' },
      { key: 'CART_RECOVERY_DISCOUNT', type: 'string', required: true, description: 'Discount code for cart recovery', example: 'COMEBACK10', group: 'Campaign' },
      ...SMTP_VARS
    ]
  },
  'order-fulfillment': {
    credentials: [
      { service: 'SMTP / Email', type: 'smtp', description: 'For order confirmations', docsUrl: 'https://docs.n8n.io/integrations/builtin/credentials/smtp/' },
      { service: 'Shopify', type: 'shopify_api_key', description: 'For order data and tagging', docsUrl: 'https://shopify.dev/docs/apps/auth/admin-app-access-tokens' }
    ],
    dependencies: [
      ...N8N_DEPS,
      ...SMTP_DEPS,
      { id: 'shopify', name: 'Shopify Store', type: 'account', required: true, description: 'Active Shopify store', setupUrl: 'https://partners.shopify.com', icon: 'ShoppingBag' },
      { id: 'shopify_webhook', name: 'Shopify Order Webhook', type: 'configuration', required: true, description: 'Shopify Admin → Settings → Notifications → Webhooks → "Order created"', icon: 'Webhook' }
    ],
    variables: [
      { key: 'STORE_EMAIL', type: 'email', required: true, description: 'Store notification email', example: 'orders@yourstore.com', group: 'Store' },
      { key: 'WAREHOUSE_EMAIL', type: 'email', required: true, description: 'Warehouse/fulfillment team email', example: 'warehouse@yourstore.com', group: 'Operations' },
      { key: 'SHOPIFY_ACCESS_TOKEN', type: 'api_key', required: true, description: 'Shopify Admin API access token', example: 'shpat_XXXXXXXXXXXX', group: 'Shopify' },
      ...SMTP_VARS
    ]
  },
  'returns-workflow': {
    credentials: [
      { service: 'SMTP / Email', type: 'smtp', description: 'For return communications', docsUrl: 'https://docs.n8n.io/integrations/builtin/credentials/smtp/' },
      { service: 'Shopify', type: 'shopify_api_key', description: 'For processing refunds', docsUrl: 'https://shopify.dev/docs/apps/auth/admin-app-access-tokens' }
    ],
    dependencies: [
      ...N8N_DEPS,
      ...SMTP_DEPS,
      { id: 'shopify', name: 'Shopify Store', type: 'account', required: true, description: 'Active Shopify store with write_orders permissions', setupUrl: 'https://partners.shopify.com', icon: 'ShoppingBag' },
      { id: 'return_form', name: 'Returns Request Form', type: 'tool', required: true, description: 'Customer-facing form that collects return details', setupUrl: 'https://tally.so', icon: 'FormInput' }
    ],
    variables: [
      { key: 'STORE_EMAIL', type: 'email', required: true, description: 'Store support email', example: 'support@yourstore.com', group: 'Store' },
      { key: 'RETURNS_TEAM_EMAIL', type: 'email', required: true, description: 'Returns team email', example: 'returns@yourstore.com', group: 'Operations' },
      { key: 'RETURN_ADDRESS', type: 'string', required: true, description: 'Physical returns address', example: '123 Returns St, City, CA 90210', group: 'Operations' },
      { key: 'SHOPIFY_ACCESS_TOKEN', type: 'api_key', required: true, description: 'Shopify Admin API access token (needs write_orders)', example: 'shpat_XXXXXXXXXXXX', group: 'Shopify' },
      ...SMTP_VARS
    ]
  }
};

export function getTemplateEnrichment(templateId: string): TemplateEnrichment | null {
  return ENRICHMENTS[templateId] || null;
}
