/**
 * Composable Node Block Registry
 *
 * Every workflow node must come from this registry.
 * Each block defines its n8n node shape via buildN8nNode().
 * Unsupported integrations cannot be used — they simply don't exist here.
 */

export type BlockCategory =
  | 'trigger'
  | 'transform'
  | 'condition'
  | 'action'
  | 'delay'
  | 'error';

export type IntegrationId =
  | 'n8n_webhook'
  | 'n8n_schedule'
  | 'n8n_code'
  | 'n8n_if'
  | 'n8n_wait'
  | 'n8n_error_trigger'
  | 'n8n_set'
  | 'gmail'
  | 'smtp'
  | 'slack'
  | 'shopify'
  | 'airtable'
  | 'google_sheets'
  | 'twilio'
  | 'hubspot'
  | 'http';

export interface BlockParam {
  key: string;
  label: string;
  type: 'string' | 'email' | 'url' | 'number' | 'cron' | 'password' | 'select' | 'boolean';
  required: boolean;
  defaultValue?: string | number | boolean;
  options?: string[];
  envVar?: string;
  description: string;
}

export interface BlockDependency {
  service: string;
  type: 'account' | 'api_key' | 'oauth' | 'smtp' | 'configuration';
  description: string;
  setupUrl?: string;
}

/** Canonical n8n node payload shape.
 *  credentials is intentionally omitted — workflows are deployed credential-free.
 *  Users link credentials in n8n UI after import. */
export interface N8nNodePayload {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: never;
}

/** Connection from one node instance to another */
export interface N8nConnectionEntry {
  node: string;
  type: 'main';
  index: number;
}

export interface NodeBlock {
  id: string;
  name: string;
  description: string;
  category: BlockCategory;
  integration: IntegrationId;
  /** Canonical n8n node type string */
  n8nType: string;
  n8nTypeVersion: number;
  params: BlockParam[];
  dependencies: BlockDependency[];
  /** How many output ports this block exposes (default 1) */
  outputPorts: number;
  /** Whether block may only appear once per workflow */
  singleton?: boolean;
  tags: string[];
  /**
   * Build the n8n-compatible node payload for this block instance.
   * Called by the composer for every placed block.
   */
  buildN8nNode(instanceId: string, position: [number, number], params: Record<string, unknown>): N8nNodePayload;
  /**
   * Build the outgoing connections array for this block instance.
   * toNodeId is the next node in the sequence (may be null for terminal nodes).
   */
  buildConnections(fromInstanceId: string, toInstanceIds: string[]): Record<string, { main: N8nConnectionEntry[][] }>;
}

export interface PlacedBlock {
  instanceId: string;
  blockId: string;
  block: NodeBlock;
  position: [number, number];
  params: Record<string, string | number | boolean>;
  label?: string;
}

export interface BlockConnection {
  fromInstanceId: string;
  fromPort: number;
  toInstanceId: string;
  toPort: number;
}

export interface ComposedWorkflow {
  id: string;
  name: string;
  description: string;
  blocks: PlacedBlock[];
  connections: BlockConnection[];
  envVars: EnvVar[];
  createdAt: string;
}

export interface EnvVar {
  key: string;
  description: string;
  example: string;
  required: boolean;
}

// ─── HELPER BUILDERS ─────────────────────────────────────────────────────────

/**
 * Build a credential-free n8n node payload.
 * Credentials are NEVER embedded — they must be linked manually in n8n after import.
 * This ensures workflow JSON is importable into any n8n instance without broken references.
 */
function makeNode(
  id: string,
  name: string,
  type: string,
  version: number,
  position: [number, number],
  parameters: Record<string, unknown>
): N8nNodePayload {
  return { id, name, type, typeVersion: version, position, parameters };
}

function makeConnections(
  fromId: string,
  toIds: string[]
): Record<string, { main: N8nConnectionEntry[][] }> {
  if (toIds.length === 0) return {};
  return {
    [fromId]: {
      main: [toIds.map((toId) => ({ node: toId, type: 'main' as const, index: 0 }))]
    }
  };
}

/**
 * Which n8n credential type name each integration uses.
 * Used by the validator and UI to show required credentials — NOT embedded in JSON.
 */
export const CREDENTIAL_TYPE_MAP: Record<string, string> = {
  'Shopify':        'shopifyApi',
  'Slack':          'slackApi',
  'Gmail / SMTP':   'smtp',
  'Airtable':       'airtableTokenApi',
  'Google Sheets':  'googleSheetsOAuth2Api',
  'HubSpot':        'hubspotApi',
  'Twilio':         'twilioApi',
};

// ─── CONTEXT-AWARE CODE TEMPLATES ────────────────────────────────────────────

/**
 * Default JavaScript code snippets per workflow context.
 * Each template normalises upstream data into a flat object with predictable fields
 * that downstream nodes (Slack, email, Airtable) can reference via {{ $json.field }}.
 */
const CODE_TEMPLATES: Record<string, string> = {
  shopify_order: `// Normalise Shopify order data for downstream nodes
return $input.all().map(item => {
  const order = item.json;
  return {
    json: {
      order_id:       order.id,
      order_name:     order.name || ('#' + order.order_number),
      customer_email: order.email || order.customer?.email || '',
      customer_name:  (order.billing_address?.first_name || '') + ' ' + (order.billing_address?.last_name || ''),
      total_price:    order.total_price,
      currency:       order.currency,
      line_items:     (order.line_items || []).map(i => i.title).join(', '),
      created_at:     order.created_at,
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status || 'unfulfilled'
    }
  };
});`,

  abandoned_cart: `// Normalise Shopify abandoned cart data
return $input.all().map(item => {
  const cart = item.json;
  return {
    json: {
      cart_id:        cart.id,
      customer_email: cart.email || cart.customer?.email || '',
      customer_name:  cart.billing_address?.first_name || '',
      total_price:    cart.total_price,
      currency:       cart.currency,
      line_items:     (cart.line_items || []).map(i => i.title).join(', '),
      abandoned_at:   cart.updated_at
    }
  };
});`,

  generic: `// Pass through all fields from the previous step
return $input.all().map(item => ({ json: { ...item.json, processed_at: new Date().toISOString() } }));`
};

// ─── BLOCK REGISTRY ──────────────────────────────────────────────────────────

export const BLOCKS: Record<string, NodeBlock> = {

  // ── TRIGGERS ─────────────────────────────────────────────────────────────

  webhook_trigger: {
    id: 'webhook_trigger',
    name: 'Webhook Trigger',
    description: 'Starts the workflow when an HTTP POST request is received',
    category: 'trigger',
    integration: 'n8n_webhook',
    n8nType: 'n8n-nodes-base.webhook',
    n8nTypeVersion: 1,
    outputPorts: 1,
    singleton: true,
    tags: ['webhook', 'http', 'trigger', 'api', 'form', 'intake', 'request'],
    params: [
      { key: 'httpMethod', label: 'HTTP Method', type: 'select', required: true, defaultValue: 'POST', options: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method to listen for' },
      { key: 'path', label: 'URL Path', type: 'string', required: true, defaultValue: 'webhook', description: 'The path suffix for this webhook URL' }
    ],
    dependencies: [],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Webhook', this.n8nType, this.n8nTypeVersion, pos, {
        httpMethod: params.httpMethod ?? 'POST',
        path: params.path ?? 'webhook',
        responseMode: 'onReceived',
        responseData: 'allEntries'
      });
    },
    buildConnections: makeConnections
  },

  schedule_trigger: {
    id: 'schedule_trigger',
    name: 'Schedule Trigger',
    description: 'Runs the workflow on a repeating cron schedule',
    category: 'trigger',
    integration: 'n8n_schedule',
    n8nType: 'n8n-nodes-base.scheduleTrigger',
    n8nTypeVersion: 1,
    outputPorts: 1,
    singleton: true,
    tags: ['schedule', 'cron', 'daily', 'weekly', 'monthly', 'recurring', 'automatic', 'reminder'],
    params: [
      { key: 'rule', label: 'Cron Expression', type: 'cron', required: true, defaultValue: '0 9 1 * *', envVar: 'CRON_SCHEDULE', description: '0 9 1 * * = 9am on the 1st of each month' }
    ],
    dependencies: [],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Schedule', this.n8nType, this.n8nTypeVersion, pos, {
        rule: { interval: [{ field: 'cronExpression', expression: params.rule ?? '0 9 * * *' }] }
      });
    },
    buildConnections: makeConnections
  },

  shopify_order_trigger: {
    id: 'shopify_order_trigger',
    name: 'Shopify New Order',
    description: 'Fires when a new order is placed in your Shopify store',
    category: 'trigger',
    integration: 'shopify',
    n8nType: 'n8n-nodes-base.shopifyTrigger',
    n8nTypeVersion: 1,
    outputPorts: 1,
    singleton: true,
    tags: ['shopify', 'order', 'ecommerce', 'new order', 'purchase', 'buy'],
    params: [
      { key: 'topic', label: 'Event', type: 'select', required: true, defaultValue: 'orders/create', options: ['orders/create', 'orders/fulfilled', 'orders/cancelled'], description: 'Shopify event to listen for' }
    ],
    dependencies: [
      { service: 'Shopify', type: 'api_key', description: 'Shopify Admin API access token', setupUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps' }
    ],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Shopify Trigger', this.n8nType, this.n8nTypeVersion, pos,
        { topic: params.topic ?? 'orders/create' }
      );
    },
    buildConnections: makeConnections
  },

  shopify_abandoned_cart_trigger: {
    id: 'shopify_abandoned_cart_trigger',
    name: 'Shopify Abandoned Cart',
    description: 'Fires when a cart is abandoned in your Shopify store',
    category: 'trigger',
    integration: 'shopify',
    n8nType: 'n8n-nodes-base.shopifyTrigger',
    n8nTypeVersion: 1,
    outputPorts: 1,
    singleton: true,
    tags: ['shopify', 'abandoned cart', 'cart', 'recovery', 'ecommerce'],
    params: [
      { key: 'topic', label: 'Event', type: 'select', required: true, defaultValue: 'checkouts/create', options: ['checkouts/create', 'checkouts/update'], description: 'Checkout event type' }
    ],
    dependencies: [
      { service: 'Shopify', type: 'api_key', description: 'Shopify Admin API access token', setupUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps' }
    ],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Shopify Cart Trigger', this.n8nType, this.n8nTypeVersion, pos,
        { topic: params.topic ?? 'checkouts/create' }
      );
    },
    buildConnections: makeConnections
  },

  // ── TRANSFORMS ───────────────────────────────────────────────────────────

  code_transform: {
    id: 'code_transform',
    name: 'Code Transform',
    description: 'Run JavaScript to transform, filter, or enrich data between steps',
    category: 'transform',
    integration: 'n8n_code',
    n8nType: 'n8n-nodes-base.code',
    n8nTypeVersion: 2,
    outputPorts: 1,
    tags: ['code', 'transform', 'parse', 'javascript', 'process', 'format', 'map'],
    params: [
      { key: 'jsCode', label: 'JavaScript Code', type: 'string', required: true, defaultValue: 'return $input.all();', description: 'Code to run (return array of items)' },
      { key: 'context', label: 'Context hint', type: 'string', required: false, defaultValue: 'generic', description: 'Context hint for code generation (shopify_order, abandoned_cart, generic)' }
    ],
    dependencies: [],
    buildN8nNode(id, pos, params) {
      const context = (params.context as string) ?? 'generic';
      const jsCode = params.jsCode
        ? String(params.jsCode)
        : CODE_TEMPLATES[context] ?? CODE_TEMPLATES.generic;
      return makeNode(id, 'Process Data', this.n8nType, this.n8nTypeVersion, pos, {
        mode: 'runOnceForAllItems',
        jsCode
      });
    },
    buildConnections: makeConnections
  },

  set_fields: {
    id: 'set_fields',
    name: 'Set Fields',
    description: 'Map and assign specific fields to data items',
    category: 'transform',
    integration: 'n8n_set',
    n8nType: 'n8n-nodes-base.set',
    n8nTypeVersion: 3,
    outputPorts: 1,
    tags: ['set', 'fields', 'map', 'assign', 'data', 'prepare'],
    params: [
      { key: 'keepOnlySet', label: 'Keep only set fields', type: 'boolean', required: false, defaultValue: false, description: 'Remove all other fields' }
    ],
    dependencies: [],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Set Fields', this.n8nType, this.n8nTypeVersion, pos, {
        mode: 'manual',
        includeOtherFields: !(params.keepOnlySet ?? false),
        fields: { values: [] }
      });
    },
    buildConnections: makeConnections
  },

  // ── CONDITIONS ───────────────────────────────────────────────────────────

  if_condition: {
    id: 'if_condition',
    name: 'IF Condition',
    description: 'Branch the workflow based on a true/false condition',
    category: 'condition',
    integration: 'n8n_if',
    n8nType: 'n8n-nodes-base.if',
    n8nTypeVersion: 2,
    outputPorts: 2,
    tags: ['if', 'condition', 'branch', 'filter', 'check', 'conditional'],
    params: [
      { key: 'conditionField', label: 'Field', type: 'string', required: true, defaultValue: '={{ $json.status }}', description: 'Expression or field to evaluate' },
      { key: 'conditionValue', label: 'Expected value', type: 'string', required: true, defaultValue: 'approved', description: 'Value to compare against' }
    ],
    dependencies: [],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'IF Check', this.n8nType, this.n8nTypeVersion, pos, {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [
            {
              id: 'cond1',
              leftValue: params.conditionField ?? '={{ $json.status }}',
              rightValue: params.conditionValue ?? 'approved',
              operator: { type: 'string', operation: 'equals' }
            }
          ],
          combinator: 'and'
        }
      });
    },
    buildConnections(fromId, toIds) {
      if (toIds.length === 0) return {};
      const main: N8nConnectionEntry[][] = [
        toIds[0] ? [{ node: toIds[0], type: 'main', index: 0 }] : [],
        toIds[1] ? [{ node: toIds[1], type: 'main', index: 0 }] : []
      ];
      return { [fromId]: { main } };
    }
  },

  approval_node: {
    id: 'approval_node',
    name: 'Approval Step',
    description: 'Pauses workflow and waits for a human to approve via a unique resume webhook URL',
    category: 'condition',
    integration: 'n8n_wait',
    n8nType: 'n8n-nodes-base.wait',
    n8nTypeVersion: 1,
    outputPorts: 1,
    tags: ['approval', 'approve', 'human in the loop', 'review', 'manager', 'sign off', 'wait for'],
    params: [
      { key: 'webhookSuffix', label: 'Resume Webhook Suffix', type: 'string', required: false, defaultValue: 'approval', description: 'Suffix added to the n8n resume URL for this approval step' }
    ],
    dependencies: [],
    buildN8nNode(id, pos, params) {
      // n8n-nodes-base.wait with resume:'webhook' pauses execution and resumes
      // when a POST is made to the generated resume URL shown in n8n UI.
      return makeNode(id, 'Wait for Approval', this.n8nType, this.n8nTypeVersion, pos, {
        resume: 'webhook',
        options: {
          webhookSuffix: params.webhookSuffix ?? 'approval'
        }
      });
    },
    buildConnections: makeConnections
  },

  // ── ACTIONS ──────────────────────────────────────────────────────────────

  send_email_smtp: {
    id: 'send_email_smtp',
    name: 'Send Email (SMTP)',
    description: 'Send an email via Gmail App Password or any SMTP provider',
    category: 'action',
    integration: 'smtp',
    n8nType: 'n8n-nodes-base.emailSend',
    n8nTypeVersion: 2,
    outputPorts: 1,
    tags: ['email', 'gmail', 'smtp', 'send', 'notification', 'confirmation', 'reminder'],
    params: [
      { key: 'toEmail', label: 'To', type: 'email', required: true, defaultValue: '={{ $json.email }}', description: 'Recipient email' },
      { key: 'subject', label: 'Subject', type: 'string', required: true, defaultValue: 'Notification from MagicFlux', description: 'Email subject line' },
      { key: 'body', label: 'Body (HTML)', type: 'string', required: true, defaultValue: '<p>Hello {{ $json.name }},</p><p>This is an automated notification.</p>', description: 'HTML email body' },
      { key: 'fromName', label: 'From Name', type: 'string', required: false, envVar: 'SMTP_FROM_NAME', defaultValue: 'My Business', description: 'Sender display name' }
    ],
    dependencies: [
      { service: 'Gmail / SMTP', type: 'smtp', description: 'Gmail App Password or SMTP credentials', setupUrl: 'https://support.google.com/accounts/answer/185833' }
    ],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Send Email', this.n8nType, this.n8nTypeVersion, pos, {
        fromEmail: '={{ $env.SMTP_USER || "noreply@example.com" }}',
        fromName: params.fromName ?? 'My Business',
        toEmail: params.toEmail ?? '={{ $json.customer_email || $json.email }}',
        subject: params.subject ?? '={{ $json.order_name ? "Order " + $json.order_name + " confirmed" : "Notification" }}',
        emailType: 'html',
        message: params.body ?? '<p>Hi {{ $json.customer_name || "there" }},</p><p>{{ $json.order_name ? "Your order " + $json.order_name + " has been received." : "This is an automated notification." }}</p>'
      });
    },
    buildConnections: makeConnections
  },

  slack_message: {
    id: 'slack_message',
    name: 'Slack Message',
    description: 'Send a message to a Slack channel or direct message',
    category: 'action',
    integration: 'slack',
    n8nType: 'n8n-nodes-base.slack',
    n8nTypeVersion: 2,
    outputPorts: 1,
    tags: ['slack', 'notification', 'alert', 'message', 'team', 'channel'],
    params: [
      { key: 'channel', label: 'Channel', type: 'string', required: true, envVar: 'SLACK_CHANNEL_ID', defaultValue: '#general', description: 'Channel ID (C0...) or name (#channel)' },
      { key: 'text', label: 'Message', type: 'string', required: true, defaultValue: 'New event: {{ $json.title }}', description: 'Message text (Slack markdown supported)' }
    ],
    dependencies: [
      { service: 'Slack', type: 'api_key', description: 'Slack Bot Token starting with xoxb-', setupUrl: 'https://api.slack.com/apps' }
    ],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Slack Alert', this.n8nType, this.n8nTypeVersion, pos, {
        resource: 'message',
        operation: 'post',
        channel: params.channel ?? '#general',
        text: params.text ?? '={{ $json.order_name ? ":shopping_cart: New order " + $json.order_name + " — " + $json.customer_name + " — $" + $json.total_price + " " + $json.currency : $json.message || "Automation triggered: " + $workflow.name }}'
      });
    },
    buildConnections: makeConnections
  },

  airtable_create: {
    id: 'airtable_create',
    name: 'Airtable Create Record',
    description: 'Create a new record in an Airtable base',
    category: 'action',
    integration: 'airtable',
    n8nType: 'n8n-nodes-base.airtable',
    n8nTypeVersion: 2,
    outputPorts: 1,
    tags: ['airtable', 'database', 'record', 'store', 'log', 'save'],
    params: [
      { key: 'baseId', label: 'Base ID', type: 'string', required: true, envVar: 'AIRTABLE_BASE_ID', description: 'Airtable Base ID from URL' },
      { key: 'tableId', label: 'Table Name', type: 'string', required: true, defaultValue: 'Main Table', description: 'Table name or ID' }
    ],
    dependencies: [
      { service: 'Airtable', type: 'api_key', description: 'Airtable Personal Access Token (pat...)', setupUrl: 'https://airtable.com/create/tokens' }
    ],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Save to Airtable', this.n8nType, this.n8nTypeVersion, pos, {
        resource: 'record',
        operation: 'create',
        base: { value: params.baseId ?? '', mode: 'id' },
        table: { value: params.tableId ?? 'Main Table', mode: 'name' },
        fields: { fieldMappingMode: 'autoMapInputData', value: {} }
      });
    },
    buildConnections: makeConnections
  },

  airtable_search: {
    id: 'airtable_search',
    name: 'Airtable Search Records',
    description: 'Retrieve records from an Airtable table (supports filter formulas)',
    category: 'action',
    integration: 'airtable',
    n8nType: 'n8n-nodes-base.airtable',
    n8nTypeVersion: 2,
    outputPorts: 1,
    tags: ['airtable', 'search', 'fetch', 'retrieve', 'query', 'list', 'tenants'],
    params: [
      { key: 'baseId', label: 'Base ID', type: 'string', required: true, envVar: 'AIRTABLE_BASE_ID', description: 'Airtable Base ID' },
      { key: 'tableId', label: 'Table Name', type: 'string', required: true, defaultValue: 'Tenants', description: 'Table name or ID' },
      { key: 'filterFormula', label: 'Filter Formula', type: 'string', required: false, defaultValue: '', description: 'Optional Airtable formula' }
    ],
    dependencies: [
      { service: 'Airtable', type: 'api_key', description: 'Airtable Personal Access Token (pat...)', setupUrl: 'https://airtable.com/create/tokens' }
    ],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Fetch from Airtable', this.n8nType, this.n8nTypeVersion, pos, {
        resource: 'record',
        operation: 'list',
        base: { value: params.baseId ?? '', mode: 'id' },
        table: { value: params.tableId ?? 'Tenants', mode: 'name' },
        ...(params.filterFormula ? { filterByFormula: params.filterFormula } : {})
      });
    },
    buildConnections: makeConnections
  },

  google_sheets_append: {
    id: 'google_sheets_append',
    name: 'Google Sheets Append',
    description: 'Append a new row to a Google Sheets spreadsheet',
    category: 'action',
    integration: 'google_sheets',
    n8nType: 'n8n-nodes-base.googleSheets',
    n8nTypeVersion: 4,
    outputPorts: 1,
    tags: ['google sheets', 'spreadsheet', 'log', 'append', 'row', 'sheets'],
    params: [
      { key: 'sheetId', label: 'Spreadsheet ID', type: 'string', required: true, envVar: 'GOOGLE_SHEET_ID', description: 'ID from the Google Sheets URL' },
      { key: 'sheetName', label: 'Sheet Name', type: 'string', required: true, defaultValue: 'Sheet1', description: 'Tab name to write to' }
    ],
    dependencies: [
      { service: 'Google Sheets', type: 'oauth', description: 'Google OAuth2 credentials', setupUrl: 'https://console.cloud.google.com/' }
    ],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Log to Sheets', this.n8nType, this.n8nTypeVersion, pos, {
        resource: 'sheet',
        operation: 'appendOrUpdate',
        documentId: { value: params.sheetId ?? '', mode: 'id' },
        sheetName: { value: params.sheetName ?? 'Sheet1', mode: 'name' },
        columns: { mappingMode: 'autoMapInputData', value: {} }
      });
    },
    buildConnections: makeConnections
  },

  shopify_update_order: {
    id: 'shopify_update_order',
    name: 'Shopify Update Order',
    description: 'Update order tags, notes, or metadata in Shopify',
    category: 'action',
    integration: 'shopify',
    n8nType: 'n8n-nodes-base.shopify',
    n8nTypeVersion: 1,
    outputPorts: 1,
    tags: ['shopify', 'order', 'update', 'tag', 'fulfill'],
    params: [
      { key: 'orderId', label: 'Order ID', type: 'string', required: true, defaultValue: '={{ $json.id }}', description: 'Shopify order ID' },
      { key: 'tags', label: 'Tags', type: 'string', required: false, defaultValue: 'processed', description: 'Comma-separated tags to add' }
    ],
    dependencies: [
      { service: 'Shopify', type: 'api_key', description: 'Shopify Admin API access token', setupUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps' }
    ],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Update Shopify Order', this.n8nType, this.n8nTypeVersion, pos, {
        resource: 'order',
        operation: 'update',
        orderId: params.orderId ?? '={{ $json.order_id || $json.id }}',
        updateFields: { tags: params.tags ?? 'processed' }
      });
    },
    buildConnections: makeConnections
  },

  hubspot_create_contact: {
    id: 'hubspot_create_contact',
    name: 'HubSpot Create Contact',
    description: 'Create or update a contact in HubSpot CRM',
    category: 'action',
    integration: 'hubspot',
    n8nType: 'n8n-nodes-base.hubspot',
    n8nTypeVersion: 2,
    outputPorts: 1,
    tags: ['hubspot', 'crm', 'contact', 'lead', 'customer'],
    params: [
      { key: 'email', label: 'Email', type: 'email', required: true, defaultValue: '={{ $json.email }}', description: 'Contact email' },
      { key: 'firstName', label: 'First Name', type: 'string', required: false, defaultValue: '={{ $json.name }}', description: 'Contact first name' }
    ],
    dependencies: [
      { service: 'HubSpot', type: 'api_key', description: 'HubSpot Private App token', setupUrl: 'https://developers.hubspot.com/docs/api/private-apps' }
    ],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Create HubSpot Contact', this.n8nType, this.n8nTypeVersion, pos, {
        resource: 'contact',
        operation: 'upsert',
        additionalFields: {
          email: params.email ?? '={{ $json.customer_email || $json.email }}',
          firstName: params.firstName ?? '={{ $json.customer_name || $json.name || "" }}'
        }
      });
    },
    buildConnections: makeConnections
  },

  twilio_sms: {
    id: 'twilio_sms',
    name: 'Twilio SMS',
    description: 'Send an SMS message via Twilio',
    category: 'action',
    integration: 'twilio',
    n8nType: 'n8n-nodes-base.twilio',
    n8nTypeVersion: 1,
    outputPorts: 1,
    tags: ['sms', 'twilio', 'text', 'whatsapp', 'phone', 'mobile'],
    params: [
      { key: 'to', label: 'To', type: 'string', required: true, defaultValue: '={{ $json.phone }}', description: 'Recipient in E.164 (+15551234567)' },
      { key: 'message', label: 'Message', type: 'string', required: true, defaultValue: 'Automated notification', description: 'SMS body text' }
    ],
    dependencies: [
      { service: 'Twilio', type: 'api_key', description: 'Twilio Account SID and Auth Token', setupUrl: 'https://console.twilio.com' }
    ],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Send SMS', this.n8nType, this.n8nTypeVersion, pos, {
        operation: 'send',
        from: '={{ $env.TWILIO_FROM_NUMBER }}',
        to: params.to ?? '={{ $json.phone || $json.customer_phone }}',
        message: params.message ?? 'Automated notification'
      });
    },
    buildConnections: makeConnections
  },

  http_request: {
    id: 'http_request',
    name: 'HTTP Request',
    description: 'Make an HTTP request to any external API or webhook URL',
    category: 'action',
    integration: 'http',
    n8nType: 'n8n-nodes-base.httpRequest',
    n8nTypeVersion: 4,
    outputPorts: 1,
    tags: ['http', 'api', 'request', 'webhook', 'rest', 'post', 'get'],
    params: [
      { key: 'method', label: 'Method', type: 'select', required: true, defaultValue: 'POST', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method' },
      { key: 'url', label: 'URL', type: 'url', required: true, envVar: 'WEBHOOK_URL', description: 'Target URL' }
    ],
    dependencies: [],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'HTTP Request', this.n8nType, this.n8nTypeVersion, pos, {
        method: params.method ?? 'POST',
        url: params.url ?? '={{ $env.WEBHOOK_URL }}',
        sendBody: true,
        bodyParameters: { parameters: [] }
      });
    },
    buildConnections: makeConnections
  },

  // ── DELAY ────────────────────────────────────────────────────────────────

  wait_delay: {
    id: 'wait_delay',
    name: 'Wait / Delay',
    description: 'Pause the workflow for a set duration before continuing',
    category: 'delay',
    integration: 'n8n_wait',
    n8nType: 'n8n-nodes-base.wait',
    n8nTypeVersion: 1,
    outputPorts: 1,
    tags: ['wait', 'delay', 'pause', 'timer', 'sleep', 'hours', 'minutes'],
    params: [
      { key: 'amount', label: 'Amount', type: 'number', required: true, defaultValue: 1, description: 'How long to wait' },
      { key: 'unit', label: 'Unit', type: 'select', required: true, defaultValue: 'hours', options: ['seconds', 'minutes', 'hours', 'days'], description: 'Time unit' }
    ],
    dependencies: [],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Wait', this.n8nType, this.n8nTypeVersion, pos, {
        resume: 'timeInterval',
        amount: params.amount ?? 1,
        unit: params.unit ?? 'hours'
      });
    },
    buildConnections: makeConnections
  },

  // ── ERROR HANDLING ────────────────────────────────────────────────────────

  error_handler: {
    id: 'error_handler',
    name: 'Error Trigger',
    description: 'Catches errors from the workflow and passes them as data to the next step',
    category: 'error',
    integration: 'n8n_error_trigger',
    n8nType: 'n8n-nodes-base.errorTrigger',
    n8nTypeVersion: 1,
    outputPorts: 1,
    singleton: true,
    tags: ['error', 'catch', 'failure', 'handle', 'fallback'],
    params: [],
    dependencies: [],
    buildN8nNode(id, pos) {
      return makeNode(id, 'Error Trigger', this.n8nType, this.n8nTypeVersion, pos, {});
    },
    buildConnections: makeConnections
  },

  error_notify_email: {
    id: 'error_notify_email',
    name: 'Error Notification Email',
    description: 'Send an email alert when a workflow error occurs',
    category: 'action',
    integration: 'smtp',
    n8nType: 'n8n-nodes-base.emailSend',
    n8nTypeVersion: 2,
    outputPorts: 1,
    tags: ['error email', 'error notification', 'failure alert'],
    params: [
      { key: 'toEmail', label: 'Alert Email', type: 'email', required: true, envVar: 'ALERT_EMAIL', description: 'Who receives error alerts' },
      { key: 'subject', label: 'Subject', type: 'string', required: true, defaultValue: 'Workflow Error Alert', description: 'Subject line' }
    ],
    dependencies: [
      { service: 'Gmail / SMTP', type: 'smtp', description: 'Email credentials for error alerts', setupUrl: 'https://support.google.com/accounts/answer/185833' }
    ],
    buildN8nNode(id, pos, params) {
      return makeNode(id, 'Error Alert Email', this.n8nType, this.n8nTypeVersion, pos, {
        fromEmail: '={{ $env.SMTP_USER || "noreply@example.com" }}',
        toEmail: params.toEmail ?? '={{ $env.ALERT_EMAIL }}',
        subject: params.subject ?? 'Workflow Error Alert',
        emailType: 'text',
        message: 'Workflow error: {{ $json.execution.error.message }}'
      });
    },
    buildConnections: makeConnections
  }
};

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

export function getBlock(id: string): NodeBlock | undefined {
  return BLOCKS[id];
}

export function getBlocksByCategory(category: BlockCategory): NodeBlock[] {
  return Object.values(BLOCKS).filter(b => b.category === category);
}

/** Returns blocks whose tags overlap with the given tag list */
export function getBlocksByTags(tags: string[]): NodeBlock[] {
  const lower = tags.map(t => t.toLowerCase());
  return Object.values(BLOCKS).filter(b =>
    b.tags.some(tag => lower.some(l => tag.includes(l) || l.includes(tag)))
  );
}

/** Collect all env vars needed by a list of block IDs (deduped) */
export function collectEnvVars(blockIds: string[]): EnvVar[] {
  const seen = new Set<string>();
  const vars: EnvVar[] = [];
  for (const blockId of blockIds) {
    const block = BLOCKS[blockId];
    if (!block) continue;
    for (const param of block.params) {
      if (param.envVar && !seen.has(param.envVar)) {
        seen.add(param.envVar);
        vars.push({
          key: param.envVar,
          description: param.description,
          example: typeof param.defaultValue === 'string' ? param.defaultValue : '',
          required: param.required
        });
      }
    }
  }
  return vars;
}

/** Collect all credential dependencies needed by a list of block IDs (deduped by service name) */
export function collectDependencies(blockIds: string[]): BlockDependency[] {
  const seen = new Set<string>();
  const deps: BlockDependency[] = [];
  for (const blockId of blockIds) {
    const block = BLOCKS[blockId];
    if (!block) continue;
    for (const dep of block.dependencies) {
      if (!seen.has(dep.service)) {
        seen.add(dep.service);
        deps.push(dep);
      }
    }
  }
  return deps;
}

/** Assert a block ID exists in the registry. Throws if not. */
export function assertBlockExists(blockId: string): NodeBlock {
  const block = BLOCKS[blockId];
  if (!block) {
    throw new Error(`Block "${blockId}" is not in the registry. Only registered blocks may be used.`);
  }
  return block;
}
