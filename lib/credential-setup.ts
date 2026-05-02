/**
 * Per-integration credential setup instructions for the post-deployment wizard.
 * Each entry maps an n8n credential type to step-by-step instructions,
 * required fields, example values, and official documentation links.
 */

export interface CredentialField {
  label: string;
  key: string;
  type: 'text' | 'password' | 'url' | 'select';
  required: boolean;
  description: string;
  example: string;
  options?: string[];
}

/**
 * Tiers:
 * - 'full'   : Fully automatable via n8n API — no manual step required in n8n after deployment
 * - 'manual' : Credential shell can be created, but a manual step in n8n is required (e.g. OAuth)
 * - 'risk'   : Automatable but field names or auth scheme may differ across n8n versions — verify before using in production
 */
export type CredentialTier = 'full' | 'manual' | 'risk';

export interface CredentialSetupGuide {
  /** Matches CredentialRequirement.n8nCredentialType */
  n8nCredentialType: string;
  /** Human-readable integration name */
  service: string;
  icon: string;
  summary: string;
  /** Ordered steps to create this credential in n8n */
  steps: string[];
  fields: CredentialField[];
  docsUrl: string;
  docsLabel: string;
  /** How long this typically takes */
  estimatedMinutes: number;
  /** Beta tier — determines whether the UI shows this as fully automated or requires manual steps */
  tier: CredentialTier;
  /** Shown in UI when tier is 'manual' or 'risk' */
  manualNote?: string;
}

const CREDENTIAL_GUIDES: Record<string, CredentialSetupGuide> = {
  shopifyApi: {
    n8nCredentialType: 'shopifyApi',
    service: 'Shopify',
    icon: '🛒',
    summary: 'Connects n8n to your Shopify store via Admin API.',
    tier: 'risk',
    manualNote: 'Shopify field mapping varies by n8n version. Verify the credential works in n8n after deployment before going live.',
    steps: [
      'In your Shopify Admin, go to Settings → Apps and sales channels → Develop apps.',
      'Click "Create an app", give it a name like "n8n Integration".',
      'Under "Configuration", click "Configure Admin API scopes" and enable: read_orders, write_orders, read_checkouts.',
      'Click "Install app", then copy the Admin API access token shown (it only shows once).',
      'In n8n, go to Credentials → Add Credential → Search "Shopify API".',
      'Paste your store subdomain (e.g. mystore.myshopify.com) and the access token.',
    ],
    fields: [
      { label: 'Shop Subdomain', key: 'shopSubdomain', type: 'url', required: true, description: 'Your Shopify store subdomain', example: 'mystore.myshopify.com' },
      { label: 'Admin API Access Token', key: 'apiKey', type: 'password', required: true, description: 'Token from the app you created', example: 'shpat_abc123...' },
    ],
    docsUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
    docsLabel: 'Shopify Custom Apps Guide',
    estimatedMinutes: 10,
  },

  slackApi: {
    n8nCredentialType: 'slackApi',
    service: 'Slack',
    icon: '💬',
    summary: 'Allows n8n to send messages to Slack channels.',
    tier: 'full',
    steps: [
      'Go to https://api.slack.com/apps and click "Create New App" → "From scratch".',
      'Name your app (e.g. "n8n Bot") and select your workspace.',
      'Under "OAuth & Permissions", scroll to "Scopes" → "Bot Token Scopes" and add: chat:write, channels:read.',
      'Click "Install to Workspace" at the top, then authorize.',
      'Copy the "Bot User OAuth Token" (starts with xoxb-).',
      'In n8n, go to Credentials → Add Credential → "Slack API".',
      'Paste the Bot Token.',
      'Invite the bot to your channel: In Slack, open the channel and type /invite @YourBotName.',
    ],
    fields: [
      { label: 'Bot Token', key: 'accessToken', type: 'password', required: true, description: 'Bot User OAuth Token from your Slack app', example: 'xoxb-123456789-...' },
    ],
    docsUrl: 'https://api.slack.com/authentication/oauth-v2',
    docsLabel: 'Slack OAuth Guide',
    estimatedMinutes: 10,
  },

  smtp: {
    n8nCredentialType: 'smtp',
    service: 'Gmail / SMTP',
    icon: '📧',
    summary: 'Sends emails from your Gmail or any SMTP provider.',
    tier: 'full',
    steps: [
      'In Gmail, go to Google Account → Security → 2-Step Verification (must be enabled).',
      'Under "2-Step Verification", scroll to "App passwords" and click it.',
      'Select app "Mail" and device "Other (custom name)", name it "n8n".',
      'Google shows a 16-character app password — copy it.',
      'In n8n, go to Credentials → Add Credential → "SMTP".',
      'Host: smtp.gmail.com | Port: 465 | Secure: SSL | User: your@gmail.com | Password: the 16-char app password.',
    ],
    fields: [
      { label: 'SMTP Host', key: 'host', type: 'text', required: true, description: 'SMTP server hostname', example: 'smtp.gmail.com' },
      { label: 'Port', key: 'port', type: 'select', required: true, description: 'SMTP port', example: '465', options: ['465', '587', '25'] },
      { label: 'Security', key: 'secure', type: 'select', required: true, description: 'Connection security', example: 'SSL', options: ['SSL', 'TLS', 'None'] },
      { label: 'Username', key: 'user', type: 'text', required: true, description: 'Your Gmail address', example: 'yourname@gmail.com' },
      { label: 'Password', key: 'password', type: 'password', required: true, description: 'Gmail App Password (16 chars, no spaces)', example: 'abcd efgh ijkl mnop' },
    ],
    docsUrl: 'https://support.google.com/accounts/answer/185833',
    docsLabel: 'Gmail App Passwords Guide',
    estimatedMinutes: 8,
  },

  googleSheetsOAuth2Api: {
    n8nCredentialType: 'googleSheetsOAuth2Api',
    service: 'Google Sheets',
    icon: '📊',
    summary: 'Reads and writes data in Google Sheets via OAuth2.',
    tier: 'manual',
    manualNote: 'Google Sheets requires completing OAuth authorization inside n8n after deployment. The credential shell will be created automatically, but you must open n8n and click "Sign in with Google" to finish setup before the workflow can run.',
    steps: [
      'Go to https://console.cloud.google.com/ and create or select a project.',
      'Enable the Google Sheets API: APIs & Services → Enable APIs → search "Google Sheets API".',
      'Go to APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID.',
      'Application type: Web application. Add authorized redirect URI: your-n8n-url/rest/oauth2-credential/callback.',
      'Download the JSON credentials and copy the Client ID and Client Secret.',
      'After deployment, open n8n → Credentials → find "Google Sheets" → click "Sign in with Google" to complete OAuth.',
    ],
    fields: [
      { label: 'Client ID', key: 'clientId', type: 'text', required: true, description: 'OAuth2 Client ID from Google Cloud Console', example: '123456789-abc...apps.googleusercontent.com' },
      { label: 'Client Secret', key: 'clientSecret', type: 'password', required: true, description: 'OAuth2 Client Secret', example: 'GOCSPX-...' },
    ],
    docsUrl: 'https://docs.n8n.io/integrations/builtin/credentials/google/',
    docsLabel: 'n8n Google Credentials Guide',
    estimatedMinutes: 15,
  },

  airtableTokenApi: {
    n8nCredentialType: 'airtableTokenApi',
    service: 'Airtable',
    icon: '🗃️',
    summary: 'Reads and writes records in Airtable bases.',
    tier: 'full',
    steps: [
      'Go to https://airtable.com/create/tokens and click "Create new token".',
      'Name it "n8n Integration".',
      'Under Scopes, add: data.records:read, data.records:write.',
      'Under Access, select the specific base(s) this token should access.',
      'Click "Create token" and copy the token (starts with pat).',
      'In n8n, go to Credentials → Add Credential → "Airtable Token API".',
      'Paste the personal access token.',
    ],
    fields: [
      // n8n airtableTokenApi credential uses field name "token" (not "apiKey")
      { label: 'Personal Access Token', key: 'token', type: 'password', required: true, description: 'Airtable PAT starting with "pat"', example: 'patXXXXXXXXXXXXXX.yyy...' },
    ],
    docsUrl: 'https://airtable.com/create/tokens',
    docsLabel: 'Airtable Personal Access Tokens',
    estimatedMinutes: 5,
  },

  hubspotApi: {
    n8nCredentialType: 'hubspotApi',
    service: 'HubSpot',
    icon: '🔶',
    summary: 'Creates and updates contacts and deals in HubSpot CRM.',
    tier: 'risk',
    manualNote: 'HubSpot credential field names changed between n8n versions (apiKey vs accessToken). After deployment, verify the credential authenticates correctly in n8n before activating the workflow.',
    steps: [
      'In HubSpot, go to Settings (gear icon) → Account Setup → Integrations → Private Apps.',
      'Click "Create a private app".',
      'Name it "n8n Integration".',
      'Under Scopes, select: crm.objects.contacts.read, crm.objects.contacts.write.',
      'Click "Create app", then copy the access token shown.',
      'In n8n, go to Credentials → Add Credential → "HubSpot API".',
      'Paste the access token.',
    ],
    fields: [
      { label: 'Access Token', key: 'apiKey', type: 'password', required: true, description: 'Private app access token from HubSpot', example: 'pat-eu1-xxxxxxxx-...' },
    ],
    docsUrl: 'https://developers.hubspot.com/docs/api/private-apps',
    docsLabel: 'HubSpot Private Apps Guide',
    estimatedMinutes: 8,
  },

  twilioApi: {
    n8nCredentialType: 'twilioApi',
    service: 'Twilio',
    icon: '📱',
    summary: 'Sends SMS messages via Twilio.',
    tier: 'full',
    steps: [
      'Log in at https://console.twilio.com.',
      'From the dashboard, copy your Account SID and Auth Token.',
      'Ensure you have a Twilio phone number (Messaging → Phone Numbers).',
      'In n8n, go to Credentials → Add Credential → "Twilio API".',
      'Paste Account SID and Auth Token.',
    ],
    fields: [
      { label: 'Account SID', key: 'accountSid', type: 'text', required: true, description: 'Twilio Account SID from console', example: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      { label: 'Auth Token', key: 'authToken', type: 'password', required: true, description: 'Twilio Auth Token from console', example: 'your_auth_token_here' },
    ],
    docsUrl: 'https://www.twilio.com/docs/usage/api',
    docsLabel: 'Twilio API Credentials',
    estimatedMinutes: 5,
  },
};

export function getCredentialGuide(n8nCredentialType: string): CredentialSetupGuide | undefined {
  return CREDENTIAL_GUIDES[n8nCredentialType];
}

export function getCredentialGuides(types: string[]): CredentialSetupGuide[] {
  return types.flatMap(t => {
    const guide = CREDENTIAL_GUIDES[t];
    return guide ? [guide] : [];
  });
}

/** Whether a credential type requires manual browser-based OAuth in n8n */
export function requiresManualOAuth(n8nCredentialType: string): boolean {
  return CREDENTIAL_GUIDES[n8nCredentialType]?.tier === 'manual';
}

export const APPROVAL_NODE_GUIDE = {
  title: 'Approval Workflow — Manual Step Required',
  steps: [
    'After your workflow runs for the first time, open it in n8n.',
    'Click the "Wait for Approval" node.',
    'Copy the "Webhook URL" / "Resume URL" shown in the node panel.',
    'Share this URL with your approvers — include it in your Slack message or email.',
    'When an approver visits the URL, the workflow resumes execution.',
  ],
  important: 'Approval URLs are generated by n8n at runtime and cannot be fetched via the n8n Public API. They must be copied manually from the n8n editor.',
} as const;
