/**
 * AI Workflow Generator — Training Dataset
 *
 * 120 natural-language → workflow JSON pairs covering all supported patterns.
 * Every workflow is built with spec helpers and validated against the runtime rules.
 */

import {
  type WorkflowJson,
  buildLinearWorkflow,
  buildFanoutWorkflow,
  buildConditionalWorkflow,
  buildWaitWorkflow,
  webhookNode,
  shopifyTriggerNode,
  slackNode,
  emailNode,
  airtableNode,
  conditionNode,
  waitNode,
} from './ai-workflow-spec';

export interface TrainingPair {
  id: string;
  naturalLanguage: string;
  intent: string;
  workflow: WorkflowJson;
  tags: string[];
}

// ─── Shared node factories ────────────────────────────────────────────────────

const WH  = () => webhookNode('Webhook Trigger');
const ST  = () => shopifyTriggerNode('Shopify Order Trigger');
const SL  = (ch: string, msg: string) => slackNode('Send Slack Message', ch, msg);
const SL2 = (name: string, ch: string, msg: string) => slackNode(name, ch, msg);
const EM  = (to: string, subj: string, body: string) => emailNode('Send Email', to, subj, body);
const EM2 = (name: string, to: string, subj: string, body: string) => emailNode(name, to, subj, body);
const AT  = (table: string) => airtableNode('Save to Airtable', table);
const AT2 = (name: string, table: string) => airtableNode(name, table);
const CN  = (name: string, field: string, op: string, val: string) =>
  conditionNode(name, [{ field, operator: op as never, value: val }]);
const WT  = (name: string, sec: number) => waitNode(name, sec);

// ─── Dataset ─────────────────────────────────────────────────────────────────

export const TRAINING_DATASET: TrainingPair[] = [

  // ── Group 1: Webhook → single action (7) ──────────────────────────────────
  {
    id: 'TD-001',
    naturalLanguage: 'When a webhook is received, send a Slack message to the general channel',
    intent: 'webhook_to_slack',
    workflow: buildLinearWorkflow('Webhook to Slack', [WH(), SL('#general', 'New webhook event received')]),
    tags: ['webhook', 'slack', 'simple'],
  },
  {
    id: 'TD-002',
    naturalLanguage: 'Send an email notification when a webhook fires',
    intent: 'webhook_to_email',
    workflow: buildLinearWorkflow('Webhook to Email', [
      WH(),
      EM('team@example.com', 'Webhook Event', 'A webhook event was received.'),
    ]),
    tags: ['webhook', 'email', 'simple'],
  },
  {
    id: 'TD-003',
    naturalLanguage: 'Log webhook data to an Airtable database',
    intent: 'webhook_to_airtable',
    workflow: buildLinearWorkflow('Webhook to Airtable', [WH(), AT('Events')]),
    tags: ['webhook', 'airtable', 'simple'],
  },
  {
    id: 'TD-004',
    naturalLanguage: 'Post a Slack alert to #alerts when a webhook arrives',
    intent: 'webhook_to_slack',
    workflow: buildLinearWorkflow('Webhook Alert to Slack', [WH(), SL('#alerts', 'Alert: new webhook event')]),
    tags: ['webhook', 'slack', 'alert'],
  },
  {
    id: 'TD-005',
    naturalLanguage: 'Record every incoming webhook event in the Events table',
    intent: 'webhook_to_airtable',
    workflow: buildLinearWorkflow('Webhook Events Logger', [WH(), AT('Webhook Events')]),
    tags: ['webhook', 'airtable', 'logging'],
  },
  {
    id: 'TD-006',
    naturalLanguage: 'Send a confirmation email when a form submission webhook fires',
    intent: 'webhook_to_email',
    workflow: buildLinearWorkflow('Form Submission Confirmation', [
      WH(),
      EM('user@example.com', 'Form Received', 'We received your submission. Thank you!'),
    ]),
    tags: ['webhook', 'email', 'form'],
  },
  {
    id: 'TD-007',
    naturalLanguage: 'Notify the team on Slack when the API receives a webhook',
    intent: 'webhook_to_slack',
    workflow: buildLinearWorkflow('API Webhook Notification', [
      WH(),
      SL('#engineering', 'API webhook received — check the dashboard'),
    ]),
    tags: ['webhook', 'slack', 'api'],
  },

  // ── Group 2: Shopify → single action (7) ──────────────────────────────────
  {
    id: 'TD-008',
    naturalLanguage: 'When a new Shopify order is placed, send a Slack message',
    intent: 'shopify_to_slack',
    workflow: buildLinearWorkflow('Shopify Order Alert', [ST(), SL('#orders', 'New Shopify order received!')]),
    tags: ['shopify', 'slack', 'ecommerce'],
  },
  {
    id: 'TD-009',
    naturalLanguage: 'Email the team when a Shopify order is created',
    intent: 'shopify_to_email',
    workflow: buildLinearWorkflow('Shopify Order Email', [
      ST(),
      EM('orders@example.com', 'New Order', 'A new order has been placed.'),
    ]),
    tags: ['shopify', 'email', 'ecommerce'],
  },
  {
    id: 'TD-010',
    naturalLanguage: 'Log every Shopify order in Airtable for tracking',
    intent: 'shopify_to_airtable',
    workflow: buildLinearWorkflow('Shopify Order Logger', [ST(), AT('Orders')]),
    tags: ['shopify', 'airtable', 'tracking'],
  },
  {
    id: 'TD-011',
    naturalLanguage: 'Alert the #store channel on Slack for each new purchase',
    intent: 'shopify_to_slack',
    workflow: buildLinearWorkflow('Purchase Alert', [ST(), SL('#store', 'New purchase — check Shopify dashboard')]),
    tags: ['shopify', 'slack', 'purchase'],
  },
  {
    id: 'TD-012',
    naturalLanguage: 'Send order confirmation email to the fulfilment team on new Shopify order',
    intent: 'shopify_to_email',
    workflow: buildLinearWorkflow('Fulfilment Email', [
      ST(),
      EM('fulfilment@example.com', 'New Order for Fulfilment', 'Please process the new Shopify order.'),
    ]),
    tags: ['shopify', 'email', 'fulfilment'],
  },
  {
    id: 'TD-013',
    naturalLanguage: 'Save Shopify order details in the Sales database',
    intent: 'shopify_to_airtable',
    workflow: buildLinearWorkflow('Sales Database Logger', [ST(), AT('Sales')]),
    tags: ['shopify', 'airtable', 'sales'],
  },
  {
    id: 'TD-014',
    naturalLanguage: 'Notify #revenue on Slack for every Shopify sale',
    intent: 'shopify_to_slack',
    workflow: buildLinearWorkflow('Revenue Notification', [ST(), SL('#revenue', 'New sale recorded in Shopify')]),
    tags: ['shopify', 'slack', 'revenue'],
  },

  // ── Group 3: Linear multi-step (8) ────────────────────────────────────────
  {
    id: 'TD-015',
    naturalLanguage: 'When a webhook fires, notify Slack then record in Airtable',
    intent: 'webhook_slack_airtable',
    workflow: buildLinearWorkflow('Webhook → Slack → Airtable', [
      WH(), SL('#general', 'Event received'), AT('Events'),
    ]),
    tags: ['webhook', 'slack', 'airtable', 'multi-step'],
  },
  {
    id: 'TD-016',
    naturalLanguage: 'Send a Slack message then email when order arrives',
    intent: 'shopify_slack_email',
    workflow: buildLinearWorkflow('Order Slack + Email', [
      ST(),
      SL('#orders', 'Order received'),
      EM('manager@example.com', 'Order Summary', 'A new order was received and Slack was notified.'),
    ]),
    tags: ['shopify', 'slack', 'email', 'multi-step'],
  },
  {
    id: 'TD-017',
    naturalLanguage: 'Log a Shopify order in Airtable then send a Slack confirmation',
    intent: 'shopify_airtable_slack',
    workflow: buildLinearWorkflow('Log then Notify', [
      ST(), AT('Orders'), SL('#confirmations', 'Order logged in database'),
    ]),
    tags: ['shopify', 'airtable', 'slack', 'multi-step'],
  },
  {
    id: 'TD-018',
    naturalLanguage: 'Send an email then save to Airtable on new webhook',
    intent: 'webhook_email_airtable',
    workflow: buildLinearWorkflow('Webhook → Email → Airtable', [
      WH(),
      EM('team@example.com', 'New Event', 'Event received'),
      AT('Events'),
    ]),
    tags: ['webhook', 'email', 'airtable', 'multi-step'],
  },
  {
    id: 'TD-019',
    naturalLanguage: 'On Shopify order: notify Slack, then record in Airtable, then send summary email',
    intent: 'shopify_slack_airtable_email',
    workflow: buildLinearWorkflow('Full Order Pipeline', [
      ST(),
      SL('#orders', 'New order — processing'),
      AT('Orders'),
      EM('ceo@example.com', 'Daily Order Summary', 'Order processed and logged.'),
    ]),
    tags: ['shopify', 'slack', 'airtable', 'email', 'pipeline'],
  },
  {
    id: 'TD-020',
    naturalLanguage: 'Alert #ops on Slack then email the operations team when webhook fires',
    intent: 'webhook_slack_email',
    workflow: buildLinearWorkflow('Ops Alert Chain', [
      WH(),
      SL('#ops', 'Operations alert triggered'),
      EM('ops@example.com', 'Operations Alert', 'An operations alert was triggered via webhook.'),
    ]),
    tags: ['webhook', 'slack', 'email', 'operations'],
  },
  {
    id: 'TD-021',
    naturalLanguage: 'When a webhook arrives, send Slack message to #monitoring and save in Airtable',
    intent: 'webhook_slack_airtable',
    workflow: buildLinearWorkflow('Monitoring Pipeline', [
      WH(), SL('#monitoring', 'System event captured'), AT('Monitoring Events'),
    ]),
    tags: ['webhook', 'slack', 'airtable', 'monitoring'],
  },
  {
    id: 'TD-022',
    naturalLanguage: 'Post to #shipping on Slack then log in Airtable for each Shopify order',
    intent: 'shopify_slack_airtable',
    workflow: buildLinearWorkflow('Shipping Pipeline', [
      ST(), SL('#shipping', 'Order ready for shipping'), AT('Shipping Queue'),
    ]),
    tags: ['shopify', 'slack', 'airtable', 'shipping'],
  },

  // ── Group 4: Fan-out (parallel) (8) ───────────────────────────────────────
  {
    id: 'TD-023',
    naturalLanguage: 'Broadcast a webhook event to Slack and email simultaneously',
    intent: 'webhook_fanout_slack_email',
    workflow: buildFanoutWorkflow('Broadcast to Slack and Email', WH(), [
      SL('#general', 'Broadcast event'),
      EM2('Email Broadcast', 'team@example.com', 'Event Broadcast', 'Event broadcast to all channels.'),
    ]),
    tags: ['webhook', 'slack', 'email', 'fanout'],
  },
  {
    id: 'TD-024',
    naturalLanguage: 'Send a Shopify order to Slack and Airtable at the same time',
    intent: 'shopify_fanout_slack_airtable',
    workflow: buildFanoutWorkflow('Shopify Order Fan-out', ST(), [
      SL2('Order Slack Alert', '#orders', 'New order received!'),
      AT2('Order Airtable Log', 'Orders'),
    ]),
    tags: ['shopify', 'slack', 'airtable', 'fanout'],
  },
  {
    id: 'TD-025',
    naturalLanguage: 'Fan out webhook to Slack, email, and Airtable simultaneously',
    intent: 'webhook_fanout_all',
    workflow: buildFanoutWorkflow('Triple Broadcast', WH(), [
      SL2('Slack Broadcast', '#general', 'New event broadcast'),
      EM2('Email Broadcast', 'all@example.com', 'Event Broadcast', 'Event sent to all channels.'),
      AT2('Airtable Broadcast', 'Events'),
    ]),
    tags: ['webhook', 'slack', 'email', 'airtable', 'fanout'],
  },
  {
    id: 'TD-026',
    naturalLanguage: 'On Shopify order, simultaneously notify Slack, send email, and log in Airtable',
    intent: 'shopify_fanout_all',
    workflow: buildFanoutWorkflow('Shopify Full Broadcast', ST(), [
      SL2('Order Slack', '#orders', 'Order received — broadcasting'),
      EM2('Order Email', 'orders@example.com', 'New Order', 'Order broadcast sent.'),
      AT2('Order DB', 'Orders'),
    ]),
    tags: ['shopify', 'slack', 'email', 'airtable', 'fanout'],
  },
  {
    id: 'TD-027',
    naturalLanguage: 'Notify both #sales and #support channels when order arrives',
    intent: 'shopify_fanout_multi_slack',
    workflow: buildFanoutWorkflow('Multi-Channel Order Alert', ST(), [
      SL2('Sales Alert', '#sales', 'New order — sales team action required'),
      SL2('Support Alert', '#support', 'New order — support team heads up'),
    ]),
    tags: ['shopify', 'slack', 'fanout', 'multi-channel'],
  },
  {
    id: 'TD-028',
    naturalLanguage: 'When webhook fires, notify Slack and save to database in parallel',
    intent: 'webhook_fanout_slack_airtable',
    workflow: buildFanoutWorkflow('Parallel Log and Notify', WH(), [
      SL2('Parallel Slack', '#notifications', 'New event — logged and notified'),
      AT2('Parallel Log', 'Events'),
    ]),
    tags: ['webhook', 'slack', 'airtable', 'fanout', 'parallel'],
  },
  {
    id: 'TD-029',
    naturalLanguage: 'Email multiple teams simultaneously when order is placed',
    intent: 'shopify_fanout_multi_email',
    workflow: buildFanoutWorkflow('Multi-Team Email', ST(), [
      EM2('Ops Email', 'ops@example.com', 'New Order', 'New order for ops.'),
      EM2('Finance Email', 'finance@example.com', 'New Order', 'New order for finance.'),
    ]),
    tags: ['shopify', 'email', 'fanout', 'multi-team'],
  },
  {
    id: 'TD-030',
    naturalLanguage: 'Broadcast event to all channels: Slack, email, and database at once',
    intent: 'webhook_fanout_all',
    workflow: buildFanoutWorkflow('Full Broadcast', WH(), [
      SL2('All Slack', '#broadcast', 'New broadcast event'),
      EM2('All Email', 'broadcast@example.com', 'Broadcast', 'Broadcast event sent.'),
      AT2('All Airtable', 'Broadcasts'),
    ]),
    tags: ['webhook', 'slack', 'email', 'airtable', 'broadcast'],
  },

  // ── Group 5: Condition / IF workflows (20) ────────────────────────────────
  {
    id: 'TD-031',
    naturalLanguage: 'Route VIP customers to Slack, standard customers to email',
    intent: 'condition_vip_routing',
    workflow: buildConditionalWorkflow(
      'VIP Customer Router',
      WH(),
      CN('Check VIP', 'customer_type', 'equals', 'vip'),
      [SL2('VIP Slack', '#vip', 'VIP customer event')],
      [EM2('Standard Email', 'support@example.com', 'Customer Event', 'Standard customer event.')]
    ),
    tags: ['webhook', 'condition', 'vip', 'routing'],
  },
  {
    id: 'TD-032',
    naturalLanguage: 'Alert on Slack for orders over $100, log all orders in Airtable',
    intent: 'condition_high_value_order',
    workflow: buildConditionalWorkflow(
      'Order Value Router',
      ST(),
      CN('Check Value', 'total_price', 'greaterThan', '100'),
      [SL2('High Value Alert', '#big-orders', 'High value order — over $100!')],
      [AT2('Standard Order Log', 'Orders')]
    ),
    tags: ['shopify', 'condition', 'order-value'],
  },
  {
    id: 'TD-033',
    naturalLanguage: 'Send Slack alert for urgent events, email for normal events',
    intent: 'condition_urgency_routing',
    workflow: buildConditionalWorkflow(
      'Urgency Router',
      WH(),
      CN('Check Urgency', 'priority', 'equals', 'urgent'),
      [SL2('Urgent Alert', '#urgent', 'URGENT: immediate action required!')],
      [EM2('Normal Email', 'team@example.com', 'Event Notification', 'A normal event occurred.')]
    ),
    tags: ['webhook', 'condition', 'urgency'],
  },
  {
    id: 'TD-034',
    naturalLanguage: 'For active customers send Slack, for inactive send email',
    intent: 'condition_customer_status',
    workflow: buildConditionalWorkflow(
      'Customer Status Router',
      WH(),
      CN('Check Status', 'status', 'equals', 'active'),
      [SL2('Active Customer', '#customers', 'Active customer event')],
      [EM2('Inactive Email', 'retention@example.com', 'Win-back', 'Inactive customer event.')]
    ),
    tags: ['webhook', 'condition', 'customer-status'],
  },
  {
    id: 'TD-035',
    naturalLanguage: 'High-value orders get Slack and Airtable; low-value only Airtable',
    intent: 'condition_value_branch',
    workflow: buildConditionalWorkflow(
      'Order Value Branch',
      ST(),
      CN('High Value Check', 'total_price', 'greaterThan', '500'),
      [SL2('Premium Alert', '#premium', 'Premium order received!'), AT2('Premium Log', 'Premium Orders')],
      [AT2('Standard Log', 'Standard Orders')]
    ),
    tags: ['shopify', 'condition', 'branching'],
  },
  {
    id: 'TD-036',
    naturalLanguage: 'If email field exists in webhook, send email; otherwise send Slack',
    intent: 'condition_field_exists',
    workflow: buildConditionalWorkflow(
      'Email Exists Router',
      WH(),
      CN('Has Email', 'email', 'exists', ''),
      [EM2('Direct Email', 'user@example.com', 'Your Event', 'Personalized email notification.')],
      [SL2('No Email Slack', '#fallback', 'Event received — no email on file')]
    ),
    tags: ['webhook', 'condition', 'field-exists'],
  },
  {
    id: 'TD-037',
    naturalLanguage: 'Route US orders to Slack, international orders to email',
    intent: 'condition_geography',
    workflow: buildConditionalWorkflow(
      'Geography Router',
      ST(),
      CN('Check Country', 'shipping_country', 'equals', 'US'),
      [SL2('US Order Alert', '#us-orders', 'US order received')],
      [EM2('International Email', 'international@example.com', 'International Order', 'New international order.')]
    ),
    tags: ['shopify', 'condition', 'geography'],
  },
  {
    id: 'TD-038',
    naturalLanguage: 'First-time customers get welcome email, returning customers get Slack alert',
    intent: 'condition_customer_type',
    workflow: buildConditionalWorkflow(
      'Customer Type Router',
      WH(),
      CN('Is New Customer', 'orders_count', 'equals', '1'),
      [EM2('Welcome Email', 'new@example.com', 'Welcome!', 'Welcome to our store!')],
      [SL2('Returning Alert', '#loyalty', 'Returning customer order')]
    ),
    tags: ['webhook', 'condition', 'customer-type'],
  },
  {
    id: 'TD-039',
    naturalLanguage: 'Large orders go to Airtable and Slack; small orders just Airtable',
    intent: 'condition_order_size',
    workflow: buildConditionalWorkflow(
      'Order Size Branch',
      ST(),
      CN('Large Order', 'quantity', 'greaterThan', '10'),
      [AT2('Large Airtable', 'Large Orders'), SL2('Large Slack', '#large-orders', 'Large order received')],
      [AT2('Small Airtable', 'Small Orders')]
    ),
    tags: ['shopify', 'condition', 'order-size'],
  },
  {
    id: 'TD-040',
    naturalLanguage: 'Route paid orders to fulfillment Slack, unpaid to finance email',
    intent: 'condition_payment_status',
    workflow: buildConditionalWorkflow(
      'Payment Status Router',
      ST(),
      CN('Is Paid', 'financial_status', 'equals', 'paid'),
      [SL2('Fulfilment Queue', '#fulfilment', 'Paid order — ready to ship')],
      [EM2('Finance Alert', 'finance@example.com', 'Unpaid Order', 'Order received but payment pending.')]
    ),
    tags: ['shopify', 'condition', 'payment'],
  },
  {
    id: 'TD-041',
    naturalLanguage: 'Webhook events containing "error" keyword go to #incidents, others to #logs',
    intent: 'condition_keyword',
    workflow: buildConditionalWorkflow(
      'Error Keyword Router',
      WH(),
      CN('Has Error', 'type', 'contains', 'error'),
      [SL2('Incident Alert', '#incidents', 'Error event detected — investigate immediately!')],
      [SL2('Log Event', '#logs', 'Normal event logged')]
    ),
    tags: ['webhook', 'condition', 'error-detection'],
  },
  {
    id: 'TD-042',
    naturalLanguage: 'If order total less than $20, just log it; otherwise notify team',
    intent: 'condition_small_order',
    workflow: buildConditionalWorkflow(
      'Small Order Filter',
      ST(),
      CN('Is Large', 'total_price', 'greaterThan', '20'),
      [SL2('Order Alert', '#orders', 'Order requires attention'), AT2('Notable Orders', 'Notable Orders')],
      [AT2('Micro Log', 'Micro Orders')]
    ),
    tags: ['shopify', 'condition', 'filter'],
  },
  {
    id: 'TD-043',
    naturalLanguage: 'Customers with loyalty_tier=gold get premium Slack, others get standard email',
    intent: 'condition_loyalty',
    workflow: buildConditionalWorkflow(
      'Loyalty Tier Router',
      WH(),
      CN('Gold Tier', 'loyalty_tier', 'equals', 'gold'),
      [SL2('Gold Alert', '#gold-members', 'Gold tier customer interaction')],
      [EM2('Standard Outreach', 'marketing@example.com', 'Customer Interaction', 'Standard tier interaction.')]
    ),
    tags: ['webhook', 'condition', 'loyalty'],
  },
  {
    id: 'TD-044',
    naturalLanguage: 'Route refund events to #refunds on Slack, normal orders to Airtable',
    intent: 'condition_refund',
    workflow: buildConditionalWorkflow(
      'Refund Detector',
      ST(),
      CN('Is Refund', 'kind', 'equals', 'refund'),
      [SL2('Refund Alert', '#refunds', 'Refund request received — action needed')],
      [AT2('Normal Orders', 'Orders')]
    ),
    tags: ['shopify', 'condition', 'refund'],
  },
  {
    id: 'TD-045',
    naturalLanguage: 'If Shopify order has discount, save to Promo Orders table; otherwise Orders table',
    intent: 'condition_discount',
    workflow: buildConditionalWorkflow(
      'Discount Detector',
      ST(),
      CN('Has Discount', 'discount_codes', 'exists', ''),
      [AT2('Promo Orders', 'Promo Orders')],
      [AT2('Standard Orders', 'Orders')]
    ),
    tags: ['shopify', 'condition', 'discount'],
  },
  {
    id: 'TD-046',
    naturalLanguage: 'High priority: Slack to #urgent AND email to manager. Low priority: Airtable only',
    intent: 'condition_priority_branch',
    workflow: buildConditionalWorkflow(
      'Priority Dispatcher',
      WH(),
      CN('High Priority', 'priority', 'equals', 'high'),
      [
        SL2('Urgent Slack', '#urgent', 'HIGH PRIORITY event requires immediate attention'),
        EM2('Manager Email', 'manager@example.com', 'HIGH PRIORITY Alert', 'Immediate review required.'),
      ],
      [AT2('Low Priority Log', 'Low Priority Events')]
    ),
    tags: ['webhook', 'condition', 'priority'],
  },
  {
    id: 'TD-047',
    naturalLanguage: 'Route webhook by region: EU to GDPR-compliant email, others to Slack',
    intent: 'condition_region',
    workflow: buildConditionalWorkflow(
      'Region Router',
      WH(),
      CN('Is EU', 'region', 'equals', 'EU'),
      [EM2('GDPR Email', 'gdpr@example.com', 'EU Customer Event', 'EU-compliant notification.')],
      [SL2('Global Slack', '#global', 'Non-EU event received')]
    ),
    tags: ['webhook', 'condition', 'region', 'gdpr'],
  },
  {
    id: 'TD-048',
    naturalLanguage: 'Wholesale orders (qty > 50) alert #wholesale; retail orders log to Airtable',
    intent: 'condition_wholesale',
    workflow: buildConditionalWorkflow(
      'Wholesale Detector',
      ST(),
      CN('Is Wholesale', 'quantity', 'greaterThan', '50'),
      [SL2('Wholesale Alert', '#wholesale', 'Wholesale order received — large quantity order!')],
      [AT2('Retail Log', 'Retail Orders')]
    ),
    tags: ['shopify', 'condition', 'wholesale'],
  },
  {
    id: 'TD-049',
    naturalLanguage: 'If webhook has source=mobile, send push via Slack; if source=web send email',
    intent: 'condition_source',
    workflow: buildConditionalWorkflow(
      'Source Router',
      WH(),
      CN('Is Mobile', 'source', 'equals', 'mobile'),
      [SL2('Mobile Alert', '#mobile', 'Mobile event received')],
      [EM2('Web Alert', 'web@example.com', 'Web Event', 'Web source event received.')]
    ),
    tags: ['webhook', 'condition', 'source'],
  },
  {
    id: 'TD-050',
    naturalLanguage: 'Condition: if order note contains "gift", send gift Slack; else standard email',
    intent: 'condition_gift',
    workflow: buildConditionalWorkflow(
      'Gift Detector',
      ST(),
      CN('Has Gift Note', 'note', 'contains', 'gift'),
      [SL2('Gift Order', '#gifts', 'Gift order received — special packaging required!')],
      [EM2('Standard Email', 'orders@example.com', 'New Order', 'Standard order received.')]
    ),
    tags: ['shopify', 'condition', 'gift'],
  },

  // ── Group 6: Wait workflows (15) ──────────────────────────────────────────
  {
    id: 'TD-051',
    naturalLanguage: 'Wait 10 minutes after webhook then send email',
    intent: 'webhook_wait_email',
    workflow: buildWaitWorkflow('Webhook → Wait 10min → Email', WH(), 600, 'Wait 10 Minutes', [
      EM('user@example.com', 'Follow Up', 'Following up 10 minutes after your event.'),
    ]),
    tags: ['webhook', 'wait', 'email'],
  },
  {
    id: 'TD-052',
    naturalLanguage: 'Send a Slack reminder 5 minutes after webhook fires',
    intent: 'webhook_wait_slack',
    workflow: buildWaitWorkflow('Webhook → Wait 5min → Slack', WH(), 300, 'Wait 5 Minutes', [
      SL('#reminders', 'Reminder: review your recent event'),
    ]),
    tags: ['webhook', 'wait', 'slack'],
  },
  {
    id: 'TD-053',
    naturalLanguage: 'Wait 30 minutes after Shopify order then alert fulfilment team',
    intent: 'shopify_wait_slack',
    workflow: buildWaitWorkflow('Shopify → Wait 30min → Slack', ST(), 1800, 'Wait 30 Minutes', [
      SL('#fulfilment', 'Order placed 30 min ago — please check fulfilment status'),
    ]),
    tags: ['shopify', 'wait', 'slack', 'fulfilment'],
  },
  {
    id: 'TD-054',
    naturalLanguage: 'Log Shopify order to Airtable, wait 1 hour, then send summary email',
    intent: 'shopify_airtable_wait_email',
    workflow: buildLinearWorkflow('Shopify → Airtable → Wait 1h → Email', [
      ST(),
      AT2('Order DB', 'Orders'),
      WT('Wait 1 Hour', 3600),
      EM2('Hourly Summary', 'summary@example.com', 'Hourly Order Summary', 'Orders logged in the past hour.'),
    ]),
    tags: ['shopify', 'airtable', 'wait', 'email'],
  },
  {
    id: 'TD-055',
    naturalLanguage: 'After receiving webhook, wait 2 minutes then log to Airtable',
    intent: 'webhook_wait_airtable',
    workflow: buildWaitWorkflow('Webhook → Wait 2min → Airtable', WH(), 120, 'Wait 2 Minutes', [
      AT('Delayed Events'),
    ]),
    tags: ['webhook', 'wait', 'airtable'],
  },
  {
    id: 'TD-056',
    naturalLanguage: 'Send Slack notification, wait 15 minutes, then follow up with email',
    intent: 'webhook_slack_wait_email',
    workflow: buildLinearWorkflow('Notify then Follow Up', [
      WH(),
      SL2('Initial Slack', '#notifications', 'Event received — follow-up coming'),
      WT('Wait 15 Minutes', 900),
      EM2('Follow Up', 'user@example.com', 'Follow Up', 'Following up on the event from 15 minutes ago.'),
    ]),
    tags: ['webhook', 'slack', 'wait', 'email'],
  },
  {
    id: 'TD-057',
    naturalLanguage: 'Wait 1 day after Shopify order then send review request email',
    intent: 'shopify_wait_review_email',
    workflow: buildWaitWorkflow('Order Review Request', ST(), 86400, 'Wait 24 Hours', [
      EM2('Review Request', 'reviews@example.com', 'How was your order?', 'Please leave a review for your recent purchase.'),
    ]),
    tags: ['shopify', 'wait', 'email', 'review'],
  },
  {
    id: 'TD-058',
    naturalLanguage: 'After webhook: wait 30 seconds then Slack, wait another 30 then email',
    intent: 'webhook_staggered_notifications',
    workflow: buildLinearWorkflow('Staggered Notifications', [
      WH(),
      WT('First Wait', 30),
      SL2('First Notification', '#immediate', 'First notification sent'),
      WT('Second Wait', 30),
      EM2('Delayed Email', 'delayed@example.com', 'Follow-up', 'Second notification email.'),
    ]),
    tags: ['webhook', 'wait', 'slack', 'email', 'staggered'],
  },
  {
    id: 'TD-059',
    naturalLanguage: 'On Shopify order, wait 5 minutes then notify two channels simultaneously',
    intent: 'shopify_wait_fanout',
    workflow: buildLinearWorkflow('Delayed Fan-out', [
      ST(),
      WT('Wait 5 Minutes', 300),
      SL2('Channel 1', '#orders', 'Order processed after 5 min delay'),
    ]),
    tags: ['shopify', 'wait', 'fanout'],
  },
  {
    id: 'TD-060',
    naturalLanguage: 'Wait 10 minutes then send Slack message to the #delayed channel',
    intent: 'webhook_wait_slack',
    workflow: buildWaitWorkflow('Delayed Slack', WH(), 600, 'Wait 10 Minutes', [
      SL2('Delayed Slack', '#delayed', 'Delayed notification — 10 minutes after event'),
    ]),
    tags: ['webhook', 'wait', 'slack'],
  },
  {
    id: 'TD-061',
    naturalLanguage: 'After signup webhook, wait 30 minutes before sending onboarding email',
    intent: 'signup_wait_email',
    workflow: buildWaitWorkflow('Onboarding Email', WH(), 1800, 'Wait for Onboarding', [
      EM2('Onboarding', 'welcome@example.com', 'Welcome aboard!', 'Here is how to get started.'),
    ]),
    tags: ['webhook', 'wait', 'email', 'onboarding'],
  },
  {
    id: 'TD-062',
    naturalLanguage: 'Send immediate Slack alert for order, then wait 1 hour and send email digest',
    intent: 'shopify_immediate_then_delayed',
    workflow: buildLinearWorkflow('Immediate + Delayed', [
      ST(),
      SL2('Immediate Alert', '#orders', 'Order received immediately'),
      WT('Wait 1 Hour', 3600),
      EM2('Hourly Digest', 'digest@example.com', 'Order Digest', 'Here is your order summary.'),
    ]),
    tags: ['shopify', 'slack', 'wait', 'email', 'digest'],
  },
  {
    id: 'TD-063',
    naturalLanguage: 'When webhook fires, wait 45 seconds then log to Airtable',
    intent: 'webhook_wait_airtable',
    workflow: buildWaitWorkflow('Quick Delay Logger', WH(), 45, 'Wait 45 Seconds', [AT('Delayed Logs')]),
    tags: ['webhook', 'wait', 'airtable'],
  },
  {
    id: 'TD-064',
    naturalLanguage: 'Delay Shopify order processing by 15 minutes then notify Airtable and Slack',
    intent: 'shopify_wait_multi',
    workflow: buildLinearWorkflow('Delayed Order Processing', [
      ST(),
      WT('Processing Delay', 900),
      AT2('Order Record', 'Orders'),
      SL2('Processing Complete', '#orders', 'Order processed after 15 minute delay'),
    ]),
    tags: ['shopify', 'wait', 'airtable', 'slack'],
  },
  {
    id: 'TD-065',
    naturalLanguage: 'Send cart abandonment email 1 hour after webhook event',
    intent: 'cart_abandonment',
    workflow: buildWaitWorkflow('Cart Abandonment Email', WH(), 3600, 'Wait 1 Hour', [
      EM2('Cart Recovery', 'cart@example.com', 'Did you forget something?', 'You left items in your cart.'),
    ]),
    tags: ['webhook', 'wait', 'email', 'cart-abandonment'],
  },

  // ── Group 7: Business scenarios (30) ──────────────────────────────────────
  {
    id: 'TD-066',
    naturalLanguage: 'Automatically notify my team when a customer signs up',
    intent: 'signup_notification',
    workflow: buildLinearWorkflow('Customer Signup Alert', [
      WH(), SL('#signups', 'New customer signed up — welcome them!'),
    ]),
    tags: ['webhook', 'slack', 'signup'],
  },
  {
    id: 'TD-067',
    naturalLanguage: 'Track all form submissions in Airtable',
    intent: 'form_tracking',
    workflow: buildLinearWorkflow('Form Submission Tracker', [WH(), AT('Form Submissions')]),
    tags: ['webhook', 'airtable', 'forms'],
  },
  {
    id: 'TD-068',
    naturalLanguage: 'Send an order confirmation email to customer and notify team on Slack',
    intent: 'order_confirmation',
    workflow: buildLinearWorkflow('Order Confirmation Flow', [
      ST(),
      EM2('Customer Confirmation', 'customer@example.com', 'Order Confirmed', 'Your order has been confirmed.'),
      SL2('Team Notification', '#orders', 'Order confirmed and customer emailed'),
    ]),
    tags: ['shopify', 'email', 'slack', 'confirmation'],
  },
  {
    id: 'TD-069',
    naturalLanguage: 'Alert me immediately when a payment fails',
    intent: 'payment_failure_alert',
    workflow: buildLinearWorkflow('Payment Failure Alert', [
      WH(), SL('#payments', 'PAYMENT FAILED — immediate review required'), EM2('Finance', 'finance@example.com', 'Payment Failed', 'A payment has failed.'),
    ]),
    tags: ['webhook', 'slack', 'email', 'payment-failure'],
  },
  {
    id: 'TD-070',
    naturalLanguage: 'Log all API errors in a database for analysis',
    intent: 'error_logging',
    workflow: buildLinearWorkflow('API Error Logger', [WH(), AT('API Errors')]),
    tags: ['webhook', 'airtable', 'error-logging'],
  },
  {
    id: 'TD-071',
    naturalLanguage: 'Send daily sales summary to the team via email',
    intent: 'daily_summary',
    workflow: buildLinearWorkflow('Daily Sales Summary', [
      WH(), EM('sales@example.com', 'Daily Sales Summary', 'Here is your daily sales report.'),
    ]),
    tags: ['webhook', 'email', 'daily-summary'],
  },
  {
    id: 'TD-072',
    naturalLanguage: 'Notify the fulfilment team when a high-priority order arrives',
    intent: 'high_priority_fulfilment',
    workflow: buildConditionalWorkflow(
      'Priority Order Handler',
      ST(),
      CN('Is High Priority', 'tags', 'contains', 'priority'),
      [SL2('Priority Alert', '#fulfilment', 'HIGH PRIORITY ORDER — immediate fulfilment required')],
      [AT2('Normal Queue', 'Fulfilment Queue')]
    ),
    tags: ['shopify', 'condition', 'fulfilment', 'priority'],
  },
  {
    id: 'TD-073',
    naturalLanguage: 'Track customer support tickets in Airtable and alert the team on Slack',
    intent: 'support_ticket_tracking',
    workflow: buildLinearWorkflow('Support Ticket Processor', [
      WH(), AT2('Ticket Log', 'Support Tickets'), SL2('Ticket Alert', '#support', 'New support ticket logged'),
    ]),
    tags: ['webhook', 'airtable', 'slack', 'support'],
  },
  {
    id: 'TD-074',
    naturalLanguage: 'Send a welcome email series starting 5 minutes after registration',
    intent: 'welcome_series',
    workflow: buildWaitWorkflow('Welcome Email Series', WH(), 300, 'Wait Before Welcome', [
      EM2('Welcome Email', 'welcome@example.com', 'Welcome to MagicFlux!', 'Thank you for registering.'),
    ]),
    tags: ['webhook', 'wait', 'email', 'welcome'],
  },
  {
    id: 'TD-075',
    naturalLanguage: 'Monitor inventory and alert team when webhook fires for low stock',
    intent: 'inventory_alert',
    workflow: buildLinearWorkflow('Inventory Alert', [
      WH(), SL('#inventory', 'Low stock alert received — check inventory'), EM2('Stock Email', 'ops@example.com', 'Low Stock Alert', 'Inventory is running low.'),
    ]),
    tags: ['webhook', 'slack', 'email', 'inventory'],
  },
  {
    id: 'TD-076',
    naturalLanguage: 'Create a CRM record and notify sales team for every new lead',
    intent: 'lead_management',
    workflow: buildLinearWorkflow('Lead Capture Pipeline', [
      WH(), AT2('Lead CRM', 'Leads'), SL2('Sales Alert', '#sales', 'New lead captured — follow up ASAP'),
    ]),
    tags: ['webhook', 'airtable', 'slack', 'leads', 'crm'],
  },
  {
    id: 'TD-077',
    naturalLanguage: 'Alert fraud detection team when order location differs from billing address',
    intent: 'fraud_detection',
    workflow: buildConditionalWorkflow(
      'Fraud Detector',
      ST(),
      CN('Location Mismatch', 'shipping_country', 'notEquals', 'billing_country'),
      [SL2('Fraud Alert', '#fraud', 'POTENTIAL FRAUD: shipping/billing mismatch detected'), AT2('Fraud Log', 'Fraud Alerts')],
      [AT2('Clean Orders', 'Orders')]
    ),
    tags: ['shopify', 'condition', 'fraud'],
  },
  {
    id: 'TD-078',
    naturalLanguage: 'Send a Slack message to the engineering team when a deployment webhook fires',
    intent: 'deployment_notification',
    workflow: buildLinearWorkflow('Deployment Notifier', [
      WH(), SL('#engineering', 'Deployment triggered — monitoring for issues'),
    ]),
    tags: ['webhook', 'slack', 'devops', 'deployment'],
  },
  {
    id: 'TD-079',
    naturalLanguage: 'Record every Shopify refund in Airtable and notify the finance team',
    intent: 'refund_recording',
    workflow: buildLinearWorkflow('Refund Processor', [
      ST(), AT2('Refund Log', 'Refunds'), EM2('Finance Email', 'finance@example.com', 'Refund Processed', 'A refund has been processed.'),
    ]),
    tags: ['shopify', 'airtable', 'email', 'refund'],
  },
  {
    id: 'TD-080',
    naturalLanguage: 'Send re-engagement email to customers who have not ordered in 30 days',
    intent: 'reengagement',
    workflow: buildLinearWorkflow('Re-engagement Email', [
      WH(), EM('customer@example.com', 'We miss you!', 'It has been a while — here is a special offer.'),
    ]),
    tags: ['webhook', 'email', 're-engagement'],
  },
  {
    id: 'TD-081',
    naturalLanguage: 'Create event entry in Airtable and post to Slack when webhook from CRM arrives',
    intent: 'crm_webhook_handling',
    workflow: buildFanoutWorkflow('CRM Event Handler', WH(), [
      AT2('CRM Events', 'CRM Events'),
      SL2('CRM Alert', '#crm', 'New CRM event recorded'),
    ]),
    tags: ['webhook', 'airtable', 'slack', 'crm'],
  },
  {
    id: 'TD-082',
    naturalLanguage: 'Notify #devops and log to Airtable when health check webhook fails',
    intent: 'health_check_failure',
    workflow: buildFanoutWorkflow('Health Check Alert', WH(), [
      SL2('DevOps Alert', '#devops', 'HEALTH CHECK FAILED — investigate immediately!'),
      AT2('Incident Log', 'Incidents'),
    ]),
    tags: ['webhook', 'slack', 'airtable', 'monitoring'],
  },
  {
    id: 'TD-083',
    naturalLanguage: 'For enterprise customers: Slack + Airtable + email. For others: just Airtable',
    intent: 'tier_based_handling',
    workflow: buildConditionalWorkflow(
      'Enterprise Tier Handler',
      WH(),
      CN('Is Enterprise', 'tier', 'equals', 'enterprise'),
      [
        SL2('Enterprise Slack', '#enterprise', 'Enterprise customer event'),
        AT2('Enterprise DB', 'Enterprise Events'),
        EM2('Enterprise Email', 'enterprise@example.com', 'Enterprise Alert', 'Enterprise event processed.'),
      ],
      [AT2('Standard DB', 'Events')]
    ),
    tags: ['webhook', 'condition', 'tier', 'enterprise'],
  },
  {
    id: 'TD-084',
    naturalLanguage: 'Post to #marketing and email CMO when a marketing webhook fires',
    intent: 'marketing_notification',
    workflow: buildLinearWorkflow('Marketing Alert Chain', [
      WH(),
      SL2('Marketing Alert', '#marketing', 'Marketing event received — check campaign'),
      EM2('CMO Email', 'cmo@example.com', 'Marketing Event', 'A marketing automation event was triggered.'),
    ]),
    tags: ['webhook', 'slack', 'email', 'marketing'],
  },
  {
    id: 'TD-085',
    naturalLanguage: 'Save each Shopify order to Airtable, email the warehouse, and notify #logistics',
    intent: 'order_logistics',
    workflow: buildLinearWorkflow('Order Logistics Pipeline', [
      ST(),
      AT2('Order Record', 'Orders'),
      EM2('Warehouse Email', 'warehouse@example.com', 'New Order for Warehouse', 'Please prepare for dispatch.'),
      SL2('Logistics Alert', '#logistics', 'New order logged and warehouse notified'),
    ]),
    tags: ['shopify', 'airtable', 'email', 'slack', 'logistics'],
  },
  {
    id: 'TD-086',
    naturalLanguage: 'Alert #security when a webhook indicates a suspicious login',
    intent: 'security_alert',
    workflow: buildLinearWorkflow('Security Alert', [
      WH(),
      SL2('Security Alert', '#security', 'SUSPICIOUS LOGIN DETECTED — investigate immediately'),
      AT2('Security Log', 'Security Incidents'),
    ]),
    tags: ['webhook', 'slack', 'airtable', 'security'],
  },
  {
    id: 'TD-087',
    naturalLanguage: 'Process subscription renewals: log, notify, and email customer',
    intent: 'subscription_renewal',
    workflow: buildLinearWorkflow('Subscription Renewal Handler', [
      WH(),
      AT2('Renewal Log', 'Subscriptions'),
      SL2('Renewal Alert', '#subscriptions', 'Subscription renewal processed'),
      EM2('Customer Receipt', 'customer@example.com', 'Subscription Renewed', 'Your subscription has been renewed.'),
    ]),
    tags: ['webhook', 'airtable', 'slack', 'email', 'subscription'],
  },
  {
    id: 'TD-088',
    naturalLanguage: 'Notify #incidents and email CTO when error rate exceeds threshold',
    intent: 'error_threshold_alert',
    workflow: buildConditionalWorkflow(
      'Error Rate Monitor',
      WH(),
      CN('High Error Rate', 'error_rate', 'greaterThan', '5'),
      [
        SL2('Incident Alert', '#incidents', 'ERROR RATE CRITICAL — immediate response required'),
        EM2('CTO Alert', 'cto@example.com', 'Critical Error Rate Alert', 'Error rate has exceeded threshold.'),
      ],
      [SL2('Normal Status', '#monitoring', 'Error rate within normal range')]
    ),
    tags: ['webhook', 'condition', 'slack', 'email', 'monitoring'],
  },
  {
    id: 'TD-089',
    naturalLanguage: 'When a Shopify order ships, wait 1 day then ask for review',
    intent: 'post_shipment_review',
    workflow: buildLinearWorkflow('Post-Shipment Review Request', [
      WH(),
      WT('Wait 1 Day', 86400),
      EM2('Review Request', 'customer@example.com', 'How was your delivery?', 'Please review your recent order.'),
    ]),
    tags: ['webhook', 'wait', 'email', 'review', 'post-shipment'],
  },
  {
    id: 'TD-090',
    naturalLanguage: 'Handle onboarding: save to Airtable, wait 10 min, send welcome email, notify #onboarding',
    intent: 'full_onboarding',
    workflow: buildLinearWorkflow('Full Onboarding Pipeline', [
      WH(),
      AT2('User Record', 'Users'),
      WT('Onboarding Delay', 600),
      EM2('Welcome Email', 'welcome@example.com', 'Welcome!', 'Glad to have you onboard.'),
      SL2('Onboarding Alert', '#onboarding', 'New user onboarded and welcomed'),
    ]),
    tags: ['webhook', 'airtable', 'wait', 'email', 'slack', 'onboarding'],
  },
  {
    id: 'TD-091',
    naturalLanguage: 'Track all Shopify customer events in CRM and alert account managers',
    intent: 'customer_tracking',
    workflow: buildFanoutWorkflow('Customer Event Tracker', ST(), [
      AT2('Customer CRM', 'Customer Events'),
      SL2('Account Manager Alert', '#account-management', 'Customer event tracked in CRM'),
    ]),
    tags: ['shopify', 'airtable', 'slack', 'crm'],
  },
  {
    id: 'TD-092',
    naturalLanguage: 'Send Slack to #operations and email ops team for every production deployment',
    intent: 'production_deployment',
    workflow: buildFanoutWorkflow('Production Deployment Alert', WH(), [
      SL2('Ops Slack', '#operations', 'Production deployment in progress — all hands on deck'),
      EM2('Ops Team Email', 'ops@example.com', 'Production Deployment', 'A production deployment has been triggered.'),
    ]),
    tags: ['webhook', 'slack', 'email', 'deployment'],
  },
  {
    id: 'TD-093',
    naturalLanguage: 'When webhook fires: alert Slack, log to Airtable, email stakeholders all at once',
    intent: 'stakeholder_broadcast',
    workflow: buildFanoutWorkflow('Stakeholder Broadcast', WH(), [
      SL2('Stakeholder Slack', '#stakeholders', 'Important event — stakeholder notification'),
      AT2('Event Record', 'Stakeholder Events'),
      EM2('Stakeholder Email', 'stakeholders@example.com', 'Important Update', 'Please review the attached event.'),
    ]),
    tags: ['webhook', 'slack', 'airtable', 'email', 'stakeholder'],
  },
  {
    id: 'TD-094',
    naturalLanguage: 'Process order cancellation: notify team, log it, and email customer',
    intent: 'cancellation_flow',
    workflow: buildLinearWorkflow('Order Cancellation Handler', [
      ST(),
      SL2('Cancellation Alert', '#operations', 'Order cancelled — review reason'),
      AT2('Cancellation Log', 'Cancellations'),
      EM2('Cancellation Confirm', 'customer@example.com', 'Order Cancelled', 'Your order has been cancelled.'),
    ]),
    tags: ['shopify', 'slack', 'airtable', 'email', 'cancellation'],
  },
  {
    id: 'TD-095',
    naturalLanguage: 'When new user registers: immediately save to Airtable, notify team on Slack',
    intent: 'user_registration',
    workflow: buildFanoutWorkflow('User Registration Handler', WH(), [
      AT2('User Database', 'Users'),
      SL2('New User Alert', '#growth', 'New user registered — welcome them!'),
    ]),
    tags: ['webhook', 'airtable', 'slack', 'registration'],
  },

  // ── Group 8: Additional patterns (25) ─────────────────────────────────────
  {
    id: 'TD-096',
    naturalLanguage: 'Notify on Slack when webhook arrives from partner API',
    intent: 'partner_webhook',
    workflow: buildLinearWorkflow('Partner API Notifier', [WH(), SL('#partners', 'Partner API event received')]),
    tags: ['webhook', 'slack', 'partner'],
  },
  {
    id: 'TD-097',
    naturalLanguage: 'Track Shopify order metrics in Airtable for business intelligence',
    intent: 'business_intelligence',
    workflow: buildLinearWorkflow('Order Metrics Tracker', [ST(), AT('Order Metrics')]),
    tags: ['shopify', 'airtable', 'analytics'],
  },
  {
    id: 'TD-098',
    naturalLanguage: 'Send email digest of all webhook events every hour',
    intent: 'event_digest',
    workflow: buildLinearWorkflow('Event Digest', [WH(), EM('digest@example.com', 'Event Digest', 'Here is your hourly event digest.')]),
    tags: ['webhook', 'email', 'digest'],
  },
  {
    id: 'TD-099',
    naturalLanguage: 'Sync Shopify orders to Airtable for accounting',
    intent: 'accounting_sync',
    workflow: buildLinearWorkflow('Accounting Sync', [ST(), AT('Accounting Records')]),
    tags: ['shopify', 'airtable', 'accounting'],
  },
  {
    id: 'TD-100',
    naturalLanguage: 'Alert #monitoring channel on Slack for every system webhook',
    intent: 'system_monitoring',
    workflow: buildLinearWorkflow('System Monitor', [WH(), SL('#monitoring', 'System event captured')]),
    tags: ['webhook', 'slack', 'monitoring'],
  },
  {
    id: 'TD-101',
    naturalLanguage: 'Email the admin team and log to Airtable for every Shopify order',
    intent: 'order_admin',
    workflow: buildFanoutWorkflow('Admin Order Handler', ST(), [
      EM2('Admin Email', 'admin@example.com', 'New Order', 'New Shopify order details attached.'),
      AT2('Order Archive', 'Orders'),
    ]),
    tags: ['shopify', 'email', 'airtable', 'admin'],
  },
  {
    id: 'TD-102',
    naturalLanguage: 'Immediately alert on Slack, then wait 24 hours and follow up via email',
    intent: 'immediate_then_followup',
    workflow: buildLinearWorkflow('Alert then Follow Up', [
      WH(),
      SL2('Immediate Alert', '#alerts', 'Alert received — follow-up in 24 hours'),
      WT('Wait 24 Hours', 86400),
      EM2('Follow Up Email', 'team@example.com', 'Follow Up Alert', 'Following up on the alert from yesterday.'),
    ]),
    tags: ['webhook', 'slack', 'wait', 'email'],
  },
  {
    id: 'TD-103',
    naturalLanguage: 'Handle checkout events: log to Airtable and send confirmation email',
    intent: 'checkout_handling',
    workflow: buildLinearWorkflow('Checkout Handler', [
      WH(), AT2('Checkout Log', 'Checkout Events'), EM2('Checkout Email', 'customer@example.com', 'Checkout Received', 'We received your checkout.'),
    ]),
    tags: ['webhook', 'airtable', 'email', 'checkout'],
  },
  {
    id: 'TD-104',
    naturalLanguage: 'For B2B orders over $1000, notify account manager; otherwise standard processing',
    intent: 'b2b_routing',
    workflow: buildConditionalWorkflow(
      'B2B Order Router',
      ST(),
      CN('B2B Threshold', 'total_price', 'greaterThan', '1000'),
      [SL2('Account Manager', '#account-management', 'Large B2B order — assign account manager immediately'), AT2('B2B Orders', 'B2B Orders')],
      [AT2('Standard Queue', 'Orders')]
    ),
    tags: ['shopify', 'condition', 'b2b'],
  },
  {
    id: 'TD-105',
    naturalLanguage: 'Post to #growth channel and record in Airtable for every trial signup',
    intent: 'trial_signup',
    workflow: buildFanoutWorkflow('Trial Signup Handler', WH(), [
      SL2('Growth Alert', '#growth', 'New trial signup — nurture this lead!'),
      AT2('Trial Users', 'Trial Signups'),
    ]),
    tags: ['webhook', 'slack', 'airtable', 'trial'],
  },
  {
    id: 'TD-106',
    naturalLanguage: 'When Shopify order has note, send to #special-orders; otherwise process normally',
    intent: 'special_order_routing',
    workflow: buildConditionalWorkflow(
      'Special Order Detector',
      ST(),
      CN('Has Note', 'note', 'exists', ''),
      [SL2('Special Order Alert', '#special-orders', 'Order with special note — review required')],
      [AT2('Standard Orders', 'Orders')]
    ),
    tags: ['shopify', 'condition', 'special-orders'],
  },
  {
    id: 'TD-107',
    naturalLanguage: 'Route international orders to the global team, domestic to local team',
    intent: 'domestic_international',
    workflow: buildConditionalWorkflow(
      'Domestic vs International',
      ST(),
      CN('Is Domestic', 'shipping_country', 'equals', 'US'),
      [SL2('Local Team', '#domestic', 'Domestic order — assign to local team')],
      [SL2('Global Team', '#international', 'International order — assign to global team')]
    ),
    tags: ['shopify', 'condition', 'international'],
  },
  {
    id: 'TD-108',
    naturalLanguage: 'Save webhook event immediately, then wait 5 minutes and send Slack summary',
    intent: 'save_then_delayed_summary',
    workflow: buildLinearWorkflow('Save Then Summarise', [
      WH(), AT('Events'), WT('Wait 5 Minutes', 300), SL2('Summary', '#summaries', 'Event saved 5 minutes ago — summary ready'),
    ]),
    tags: ['webhook', 'airtable', 'wait', 'slack'],
  },
  {
    id: 'TD-109',
    naturalLanguage: 'Run automatic Shopify order audit: log, email ops, and notify #audit',
    intent: 'order_audit',
    workflow: buildLinearWorkflow('Order Audit Pipeline', [
      ST(),
      AT2('Audit Log', 'Order Audit'),
      EM2('Ops Audit Email', 'ops@example.com', 'Order Audit', 'Order audit completed — please review.'),
      SL2('Audit Complete', '#audit', 'Order audit logged and ops notified'),
    ]),
    tags: ['shopify', 'airtable', 'email', 'slack', 'audit'],
  },
  {
    id: 'TD-110',
    naturalLanguage: 'End-to-end: receive webhook, route by type, log all results',
    intent: 'webhook_type_routing',
    workflow: buildConditionalWorkflow(
      'Webhook Type Router',
      WH(),
      CN('Is Payment', 'type', 'equals', 'payment'),
      [SL2('Payment Alert', '#payments', 'Payment webhook received'), AT2('Payment Log', 'Payments')],
      [SL2('Generic Alert', '#events', 'Generic webhook received'), AT2('Event Log', 'Events')]
    ),
    tags: ['webhook', 'condition', 'routing'],
  },
  {
    id: 'TD-111',
    naturalLanguage: 'Broadcast new feature announcement to #product and email beta users',
    intent: 'product_announcement',
    workflow: buildFanoutWorkflow('Feature Announcement', WH(), [
      SL2('Product Channel', '#product', 'New feature launched — update the docs!'),
      EM2('Beta Email', 'beta@example.com', 'New Feature Available', 'Check out the new feature!'),
    ]),
    tags: ['webhook', 'slack', 'email', 'product'],
  },
  {
    id: 'TD-112',
    naturalLanguage: 'Process webhook: notify team, wait 2 hours, then close ticket via email',
    intent: 'ticket_resolution',
    workflow: buildLinearWorkflow('Ticket Auto-Close', [
      WH(),
      SL2('Ticket Created', '#support', 'Support ticket created — response in 2 hours'),
      WT('SLA Window', 7200),
      EM2('Auto-Close', 'support@example.com', 'Ticket Closed', 'Your ticket has been automatically resolved.'),
    ]),
    tags: ['webhook', 'slack', 'wait', 'email', 'support'],
  },
  {
    id: 'TD-113',
    naturalLanguage: 'When webhook fires, store in Airtable and notify three Slack channels',
    intent: 'airtable_multi_slack',
    workflow: buildLinearWorkflow('Log and Multi-Notify', [
      WH(),
      AT2('Event DB', 'Events'),
      SL2('Channel A', '#channel-a', 'Event logged'),
    ]),
    tags: ['webhook', 'airtable', 'slack'],
  },
  {
    id: 'TD-114',
    naturalLanguage: 'Flash-sale workflow: detect sale order, notify #flash-sales and email VIP list',
    intent: 'flash_sale',
    workflow: buildConditionalWorkflow(
      'Flash Sale Detector',
      ST(),
      CN('Is Flash Sale', 'source', 'equals', 'flash_sale'),
      [
        SL2('Flash Sale Alert', '#flash-sales', 'Flash sale order received!'),
        EM2('VIP Email', 'vip@example.com', 'Flash Sale Order', 'Your flash sale order has been received.'),
      ],
      [AT2('Regular Orders', 'Orders')]
    ),
    tags: ['shopify', 'condition', 'flash-sale', 'slack', 'email'],
  },
  {
    id: 'TD-115',
    naturalLanguage: 'Capture customer feedback via webhook, analyse and log in Airtable',
    intent: 'feedback_capture',
    workflow: buildLinearWorkflow('Feedback Capture', [WH(), AT('Customer Feedback')]),
    tags: ['webhook', 'airtable', 'feedback'],
  },
  {
    id: 'TD-116',
    naturalLanguage: 'Post to Slack #alerts when webhook signals a service outage',
    intent: 'outage_detection',
    workflow: buildLinearWorkflow('Outage Alert', [
      WH(), SL('#alerts', 'SERVICE OUTAGE DETECTED — all hands on deck!'), AT2('Incident DB', 'Incidents'),
    ]),
    tags: ['webhook', 'slack', 'airtable', 'outage'],
  },
  {
    id: 'TD-117',
    naturalLanguage: 'Record Shopify order in accounting, notify finance, wait 1 hour then send report',
    intent: 'accounting_report',
    workflow: buildLinearWorkflow('Accounting Report Pipeline', [
      ST(),
      AT2('Accounting', 'Accounting'),
      SL2('Finance Alert', '#finance', 'Order recorded in accounting'),
      WT('Report Delay', 3600),
      EM2('Finance Report', 'cfo@example.com', 'Accounting Report Ready', 'Your hourly accounting report is ready.'),
    ]),
    tags: ['shopify', 'airtable', 'slack', 'wait', 'email', 'accounting'],
  },
  {
    id: 'TD-118',
    naturalLanguage: 'For every API key rotation webhook: log to Airtable and alert #security and email security team',
    intent: 'api_key_rotation',
    workflow: buildLinearWorkflow('API Key Rotation Alert', [
      WH(),
      AT2('Key Rotation Log', 'Security Events'),
      SL2('Security Slack', '#security', 'API key rotation detected — verify if authorised'),
      EM2('Security Email', 'security@example.com', 'API Key Rotation', 'An API key was rotated. Please verify.'),
    ]),
    tags: ['webhook', 'airtable', 'slack', 'email', 'security'],
  },
  {
    id: 'TD-119',
    naturalLanguage: 'Process subscription cancellation: log, notify customer success team, email customer',
    intent: 'subscription_cancel',
    workflow: buildLinearWorkflow('Subscription Cancellation', [
      WH(),
      AT2('Cancellation Record', 'Cancellations'),
      SL2('CS Alert', '#customer-success', 'Subscription cancelled — reach out to customer'),
      EM2('Customer Email', 'customer@example.com', 'Subscription Cancelled', 'Your subscription has been cancelled.'),
    ]),
    tags: ['webhook', 'airtable', 'slack', 'email', 'subscription'],
  },
  {
    id: 'TD-120',
    naturalLanguage: 'Complete e-commerce pipeline: Shopify order → log → notify ops → wait → confirm customer',
    intent: 'full_ecommerce_pipeline',
    workflow: buildLinearWorkflow('Full E-commerce Pipeline', [
      ST(),
      AT2('Order DB', 'Orders'),
      SL2('Ops Notify', '#operations', 'New order logged — ops team take action'),
      WT('Processing Delay', 300),
      EM2('Customer Confirm', 'customer@example.com', 'Order Confirmed!', 'Your order is being processed.'),
    ]),
    tags: ['shopify', 'airtable', 'slack', 'wait', 'email', 'pipeline'],
  },
];

export const DATASET_STATS = {
  total:         TRAINING_DATASET.length,
  byTag: {
    webhook:     TRAINING_DATASET.filter(p => p.tags.includes('webhook')).length,
    shopify:     TRAINING_DATASET.filter(p => p.tags.includes('shopify')).length,
    slack:       TRAINING_DATASET.filter(p => p.tags.includes('slack')).length,
    email:       TRAINING_DATASET.filter(p => p.tags.includes('email')).length,
    airtable:    TRAINING_DATASET.filter(p => p.tags.includes('airtable')).length,
    condition:   TRAINING_DATASET.filter(p => p.tags.includes('condition')).length,
    wait:        TRAINING_DATASET.filter(p => p.tags.includes('wait')).length,
    fanout:      TRAINING_DATASET.filter(p => p.tags.includes('fanout')).length,
  },
};
