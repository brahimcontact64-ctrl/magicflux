/**
 * Phase 9.9.21 -- Part 2/5/8: reusable platform-guide registry, researched
 * against each platform's CURRENT official documentation (Sep 2026) rather
 * than remembered/outdated setup paths. Adding a platform later means
 * appending one entry here -- no duplicated static pages, no per-platform
 * UI branching.
 *
 * `connectionType` is a truth claim, not a marketing label:
 *   - 'native'       the platform has a genuine, first-party, built-in
 *                     "send this event to a URL" feature (no plugin, no
 *                     third-party app required to originate the call).
 *   - 'plugin'       requires installing a plugin/app inside the platform
 *                     (the platform itself has no built-in outbound webhook).
 *   - 'intermediary' the platform's own UI has no generic outbound-webhook
 *                     destination at all; a bridge tool (commonly Zapier or
 *                     Make) is the realistic path.
 *   - 'custom_api'   only reachable by writing code against the platform's
 *                     API/SDK -- no no-code path exists.
 *
 * `supportsCustomAuthHeader` records whether that platform's own webhook/
 * automation UI lets a user attach an arbitrary header (needed for
 * MagicFlux's `X-MagicFlux-Webhook-Secret`). Most native e-commerce/page
 * builders sign deliveries with THEIR OWN scheme instead (Shopify:
 * X-Shopify-Hmac-Sha256; WooCommerce: X-WC-Webhook-Signature; Framer:
 * Framer-Signature) and do not expose a generic "add a header" field on the
 * simple no-code path -- `limitations` says so explicitly rather than
 * silently implying MagicFlux's own secret can always be wired in natively.
 */

export type ConnectionType = 'native' | 'plugin' | 'intermediary' | 'custom_api';

export type PlatformGuide = {
  id: string;
  label: string;
  connectionType: ConnectionType;
  summary: string;
  steps: string[];
  officialDocs: Array<{ label: string; url: string }>;
  limitations: string[];
  supportsCustomAuthHeader: boolean;
};

export const PLATFORM_GUIDES: PlatformGuide[] = [
  {
    id: 'custom',
    label: 'Custom website / custom code',
    connectionType: 'custom_api',
    summary: 'You (or your developer) control the server-side code that sends the request, so you can set every header MagicFlux requires directly.',
    steps: [
      'Copy the Production Webhook URL and the X-MagicFlux-Webhook-Secret value below.',
      'From your SERVER (never from public browser JavaScript), send a POST request with a JSON body and the secret header.',
      'Use the code examples below for your language/framework.',
    ],
    officialDocs: [],
    limitations: [
      'Never call the webhook directly from public browser JavaScript with the secret embedded -- anyone viewing page source could read it. Forward through your own server endpoint instead (see the code examples).',
    ],
    supportsCustomAuthHeader: true,
  },
  {
    id: 'wordpress',
    label: 'WordPress',
    connectionType: 'plugin',
    summary: 'Plain WordPress core has no built-in outbound webhook feature. A form plugin\'s webhook add-on sends the submission to MagicFlux instead.',
    steps: [
      'If you don\'t already use one, install a form plugin with webhook support: Gravity Forms (with its official Webhooks Add-On), WPForms (Webhooks addon), Ninja Forms (Webhooks add-on), or a universal forwarder like WP Webhooks / Webhookify for Contact Form 7 and others.',
      'In that plugin\'s webhook/notification settings, set the Request URL to the Production Webhook URL below and the Request Method to POST.',
      'Add a custom header named X-MagicFlux-Webhook-Secret with the secret value below (most of these plugins support custom headers -- check "Advanced"/"Headers" in the add-on\'s settings).',
      'Map each form field to the matching field name shown below.',
    ],
    officialDocs: [
      { label: 'Gravity Forms Webhooks Add-On', url: 'https://www.gravityforms.com/feature/webhooks/' },
      { label: 'WPForms Webhooks addon', url: 'https://wpforms.com/features/webhooks-addon/' },
      { label: 'WP Webhooks plugin', url: 'https://wordpress.org/plugins/wp-webhooks/' },
    ],
    limitations: [
      'WordPress core itself has no native webhook feature -- this always requires a plugin.',
      'Exact header-configuration steps vary by plugin; confirm your chosen plugin\'s settings screen exposes a custom-headers field before relying on it.',
    ],
    supportsCustomAuthHeader: true,
  },
  {
    id: 'woocommerce',
    label: 'WooCommerce',
    connectionType: 'native',
    summary: 'WooCommerce ships with a native Webhooks feature under its own settings -- no plugin required.',
    steps: [
      'In wp-admin, go to WooCommerce > Settings > Advanced > Webhooks, then Add webhook.',
      'Set Status to Active, Topic to the order/customer event you want (e.g. "Order created"), and Delivery URL to the Production Webhook URL below.',
      'Set the Secret field to the value below -- WooCommerce uses it to sign each delivery with an X-WC-Webhook-Signature header (HMAC-SHA256, base64), a DIFFERENT scheme from MagicFlux\'s own header-based secret.',
    ],
    officialDocs: [
      { label: 'WooCommerce Webhooks documentation', url: 'https://woocommerce.com/document/webhooks/' },
      { label: 'WooCommerce developer webhooks reference', url: 'https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/' },
    ],
    limitations: [
      'WooCommerce\'s native webhook form has no generic "add a custom header" field -- it can\'t send MagicFlux\'s X-MagicFlux-Webhook-Secret header directly. Use an intermediary (Zapier/Make) to receive WooCommerce\'s natively-signed delivery and forward it to MagicFlux with the required header, or have a developer verify the X-WC-Webhook-Signature server-side before relaying.',
    ],
    supportsCustomAuthHeader: false,
  },
  {
    id: 'shopify',
    label: 'Shopify',
    connectionType: 'native',
    summary: 'Shopify has a native Webhooks feature (Settings > Notifications, or the Admin/GraphQL API for finer control) -- no app install required for the basic UI path.',
    steps: [
      'In Shopify admin, go to Settings > Notifications, scroll to Webhooks, and click Create webhook.',
      'Choose the event (e.g. "Order creation"), format JSON, and enter the Production Webhook URL below as the URL.',
      'Shopify signs every delivery with an X-Shopify-Hmac-Sha256 header using your app\'s client secret -- a different scheme from MagicFlux\'s own secret header.',
    ],
    officialDocs: [
      { label: 'Shopify: Creating webhooks', url: 'https://help.shopify.com/en/manual/fulfillment/setup/notifications/webhooks' },
      { label: 'Shopify: About webhooks', url: 'https://shopify.dev/docs/apps/build/webhooks' },
    ],
    limitations: [
      'The basic admin UI webhook form has no field for a custom MagicFlux header. Use an intermediary (Zapier/Make have native Shopify triggers) to bridge to MagicFlux, or a custom/private app (Admin API) where your own server code can add the header before forwarding.',
      'Shopify requires the destination URL to be HTTPS -- MagicFlux\'s production URL already is.',
    ],
    supportsCustomAuthHeader: false,
  },
  {
    id: 'clickfunnels',
    label: 'ClickFunnels',
    connectionType: 'native',
    summary: 'ClickFunnels 2.0 has a native Webhooks feature under Workspace Settings -- no third-party app required.',
    steps: [
      'In ClickFunnels, go to Workspace Settings > Webhooks > Add New Endpoint.',
      'Enter a name, set the URL to the Production Webhook URL below, and select the event types (e.g. contact.created, order.completed).',
      'Optionally scope the webhook to specific funnels/pages under Endpoint Scopes.',
    ],
    officialDocs: [
      { label: 'ClickFunnels: Creating Webhooks', url: 'https://support.myclickfunnels.com/docs/how-to-create-and-manage-webhooks-in-clickfunnels' },
      { label: 'ClickFunnels developer docs', url: 'https://developers.myclickfunnels.com/docs/intro' },
    ],
    limitations: [
      'ClickFunnels\' official docs do not document a custom-header field on the basic endpoint form -- verify in your account before assuming the secret header can be attached natively; if it can\'t, use an intermediary (Zapier/Make) instead.',
      'Use ClickFunnels 2.0\'s webhook system, not the deprecated ClickFunnels Classic v1 webhooks, which only receive maintenance support.',
    ],
    supportsCustomAuthHeader: false,
  },
  {
    id: 'webflow',
    label: 'Webflow',
    connectionType: 'native',
    summary: 'Webflow has native Webhooks (Site Settings > Integrations, or the Data API), including a "form_submission" trigger built for exactly this.',
    steps: [
      'In your Webflow project, go to Site Settings > Integrations > Webhooks (or use the "Form Data" quick-connect at webflow.com/integrations/form-data).',
      'Add a webhook with Trigger Type "Form Submission" and Destination URL set to the Production Webhook URL below.',
      'Webflow sends form field names as JSON keys, matching the field names shown below.',
    ],
    officialDocs: [
      { label: 'Webflow: Working with webhooks', url: 'https://developers.webflow.com/data/docs/working-with-webhooks' },
      { label: 'Webflow: Form Data quick connect', url: 'https://webflow.com/integrations/form-data' },
    ],
    limitations: [
      'The native Webhooks panel has no custom-header field -- MagicFlux\'s secret header can\'t be attached directly from Webflow\'s UI. Use an intermediary (Zapier/Make) or a small server-side relay.',
      'Webflow limits registrations to 75 per trigger type per site.',
    ],
    supportsCustomAuthHeader: false,
  },
  {
    id: 'wix',
    label: 'Wix',
    connectionType: 'native',
    summary: 'Wix Automations (the built-in no-code automation builder) has a "Send an HTTP Request" action that can POST any trigger\'s data -- including form submissions -- to an external URL.',
    steps: [
      'In your Wix dashboard, go to Automations and create a new automation.',
      'Choose "Form submitted" as the trigger (Any form, or a specific one).',
      'Add the "Send an HTTP Request" action, set the method to POST, the URL to the Production Webhook URL below, and choose "All keys and values" so every form field is sent.',
    ],
    officialDocs: [
      { label: 'Wix: Sending an HTTP Request', url: 'https://support.wix.com/en/article/the-new-automation-builder-sending-data-via-webhook' },
      { label: 'Wix: Form submission automations', url: 'https://support.wix.com/en/article/wix-automations-creating-automations-for-cms-form-submissions' },
    ],
    limitations: [
      'Whether the HTTP Request action\'s "Advanced" options expose a custom-header field varies by Wix plan/version -- confirm this before relying on it; if it doesn\'t, use an intermediary (Zapier/Make, both officially supported by Wix Automations).',
    ],
    supportsCustomAuthHeader: false,
  },
  {
    id: 'squarespace',
    label: 'Squarespace',
    connectionType: 'intermediary',
    summary: 'Squarespace\'s native Form Block does not support sending submissions to a custom webhook URL -- an intermediary is the realistic, honest path.',
    steps: [
      'Connect your Squarespace Form Block to Zapier (Squarespace\'s official native Zapier integration) or Make.',
      'In Zapier/Make, use its "Webhooks" action to POST to the Production Webhook URL below with a custom X-MagicFlux-Webhook-Secret header.',
      'Map each Squarespace form field to the matching field name shown below.',
    ],
    officialDocs: [
      { label: 'Squarespace Form blocks', url: 'https://support.squarespace.com/hc/en-us/articles/206566737-Form-blocks' },
    ],
    limitations: [
      'Squarespace does not offer a native "custom webhook URL" destination on its Form Block -- do not expect a built-in field for this. Zapier/Make is the correct, truthful path today, not a workaround.',
    ],
    supportsCustomAuthHeader: true,
  },
  {
    id: 'framer',
    label: 'Framer',
    connectionType: 'native',
    summary: 'Framer Forms has a native "Send To > Webhook" destination built specifically for this.',
    steps: [
      'Select your form on the Framer canvas, click "Add…" next to "Send To" in the right sidebar, and choose Webhook.',
      'Enter the Production Webhook URL below (must start with https://).',
      'Framer signs each delivery with its own Framer-Signature header (HMAC-SHA256, using a secret you set in Framer, at least 32 characters) -- a different scheme from MagicFlux\'s own secret header.',
    ],
    officialDocs: [
      { label: 'Framer: Connect a form to a webhook', url: 'https://www.framer.com/help/articles/framer-form-webhook-setup/' },
    ],
    limitations: [
      'Framer\'s webhook destination has no field for a custom MagicFlux header -- it only supports Framer\'s own signature scheme. Use an intermediary (Zapier/Make) to bridge, or verify Framer-Signature server-side before relaying.',
      'Framer requires your endpoint to return a 2xx status and does not follow redirects; it retries up to 5 times otherwise.',
    ],
    supportsCustomAuthHeader: false,
  },
  {
    id: 'other',
    label: 'Other / not listed',
    connectionType: 'custom_api',
    summary: 'Check whether your platform has its own automation builder or webhook/API feature. Most modern site/store builders support at least one of: a native webhook destination, a Zapier/Make integration, or a public API.',
    steps: [
      'Search your platform\'s help center for "webhook" or "API" to see what it natively supports.',
      'If it integrates with Zapier or Make, use their generic "Webhooks" action to reach the Production Webhook URL below.',
      'If it only offers a plugin/app marketplace, look for a "webhook" or "automation" app.',
    ],
    officialDocs: [],
    limitations: [
      'MagicFlux cannot claim a specific connection path for a platform it hasn\'t verified -- confirm your platform\'s current capability in its own documentation before assuming any of the above.',
    ],
    supportsCustomAuthHeader: false,
  },
];

export function getPlatformGuide(id: string): PlatformGuide | undefined {
  return PLATFORM_GUIDES.find((p) => p.id === id);
}
