export type Industry = 'property-management' | 'airbnb' | 'shopify';
export type Complexity = 'beginner' | 'intermediate' | 'advanced';

export interface AutomationTemplate {
  id: string;
  name: string;
  industry: Industry;
  description: string;
  keywords: string[];
  nodeCount: number;
  complexity: Complexity;
  estimatedSetupTime: string;
  tags: string[];
  workflow: object;
  envConfig: string;
  setupGuide: string;
}

const propertyMaintenanceWorkflow = {
  name: 'Tenant Maintenance Request Automation',
  nodes: [
    { parameters: {}, name: 'Webhook Trigger', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [250, 300], webhookId: 'maintenance-webhook' },
    { parameters: { jsCode: "const data = $input.all()[0].json;\nconst ticket = {\n  id: `MR-${Date.now()}`,\n  tenant: data.tenant_name,\n  unit: data.unit_number,\n  issue: data.issue_description,\n  priority: data.urgency || 'normal',\n  timestamp: new Date().toISOString()\n};\nreturn [{ json: ticket }];" }, name: 'Process Request', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300] },
    { parameters: { resource: 'record', operation: 'create', base: { value: '{{$env.AIRTABLE_BASE_ID}}' }, table: { value: 'Maintenance Tickets' }, columns: { mappingMode: 'defineBelow', value: { Ticket_ID: '={{$json.id}}', Tenant: '={{$json.tenant}}', Unit: '={{$json.unit}}', Issue: '={{$json.issue}}', Priority: '={{$json.priority}}', Status: 'Open', Created: '={{$json.timestamp}}' } } }, name: 'Create Airtable Record', type: 'n8n-nodes-base.airtable', typeVersion: 2, position: [650, 200] },
    { parameters: { fromEmail: '={{$env.FROM_EMAIL}}', toEmail: '={{$env.PROPERTY_MANAGER_EMAIL}}', subject: '🔧 New Maintenance Request - Unit {{$json.unit}}', emailType: 'html', message: '<h2>New Maintenance Request</h2><p><strong>Ticket ID:</strong> {{$json.id}}</p><p><strong>Tenant:</strong> {{$json.tenant}}</p><p><strong>Unit:</strong> {{$json.unit}}</p><p><strong>Issue:</strong> {{$json.issue}}</p><p><strong>Priority:</strong> {{$json.priority}}</p>' }, name: 'Notify Property Manager', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [650, 400] },
    { parameters: { fromEmail: '={{$env.FROM_EMAIL}}', toEmail: '={{$input.first().json.tenant_email}}', subject: 'Maintenance Request Received - {{$json.id}}', emailType: 'html', message: '<h2>We Received Your Request</h2><p>Hi {{$json.tenant}},</p><p>Your maintenance request ({{$json.id}}) has been received and will be addressed within 24–48 hours.</p><p><strong>Issue:</strong> {{$json.issue}}</p><p>We\'ll keep you updated on the progress.</p>' }, name: 'Confirm to Tenant', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [850, 400] }
  ],
  connections: {
    'Webhook Trigger': { main: [[{ node: 'Process Request', type: 'main', index: 0 }]] },
    'Process Request': { main: [[{ node: 'Create Airtable Record', type: 'main', index: 0 }, { node: 'Notify Property Manager', type: 'main', index: 0 }]] },
    'Notify Property Manager': { main: [[{ node: 'Confirm to Tenant', type: 'main', index: 0 }]] }
  },
  active: false,
  settings: { executionOrder: 'v1', saveManualExecutions: true },
  id: 'tenant-maintenance-v1',
  meta: { templateId: 'tenant-maintenance', instanceId: 'ai-automation-builder' }
};

const rentReminderWorkflow = {
  name: 'Rent Reminder Automation',
  nodes: [
    { parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 9 1 * *' }] } }, name: 'Monthly Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1, position: [250, 300] },
    { parameters: { operation: 'search', base: { value: '={{$env.AIRTABLE_BASE_ID}}' }, table: { value: 'Tenants' }, filterByFormula: "AND({Status}='Active', {Rent_Due_Day}=1)" }, name: 'Get Active Tenants', type: 'n8n-nodes-base.airtable', typeVersion: 2, position: [450, 300] },
    { parameters: { jsCode: "return $input.all().map(item => ({\n  json: {\n    ...item.json,\n    due_date: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),\n    days_until_due: 5\n  }\n}));" }, name: 'Prepare Data', type: 'n8n-nodes-base.code', typeVersion: 2, position: [650, 300] },
    { parameters: { fromEmail: '={{$env.FROM_EMAIL}}', toEmail: '={{$json.Email}}', subject: 'Rent Reminder - Due {{$json.due_date}}', emailType: 'html', message: '<h2>Rent Reminder</h2><p>Hi {{$json.Name}},</p><p>This is a friendly reminder that your rent of <strong>${{$json.Monthly_Rent}}</strong> is due on <strong>{{$json.due_date}}</strong>.</p><p>Please ensure payment is made on time to avoid any late fees.</p><p>Payment methods: {{$env.PAYMENT_METHODS}}</p>' }, name: 'Send Reminder Email', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [850, 300] },
    { parameters: { operation: 'update', base: { value: '={{$env.AIRTABLE_BASE_ID}}' }, table: { value: 'Tenants' }, id: '={{$json.id}}', columns: { mappingMode: 'defineBelow', value: { Last_Reminder_Sent: '={{new Date().toISOString()}}' } } }, name: 'Update Reminder Log', type: 'n8n-nodes-base.airtable', typeVersion: 2, position: [1050, 300] }
  ],
  connections: {
    'Monthly Schedule': { main: [[{ node: 'Get Active Tenants', type: 'main', index: 0 }]] },
    'Get Active Tenants': { main: [[{ node: 'Prepare Data', type: 'main', index: 0 }]] },
    'Prepare Data': { main: [[{ node: 'Send Reminder Email', type: 'main', index: 0 }]] },
    'Send Reminder Email': { main: [[{ node: 'Update Reminder Log', type: 'main', index: 0 }]] }
  },
  active: false,
  settings: { executionOrder: 'v1', saveManualExecutions: true },
  id: 'rent-reminder-v1',
  meta: { templateId: 'rent-reminder', instanceId: 'ai-automation-builder' }
};

const leasingInquiryWorkflow = {
  name: 'Leasing Inquiry Automation',
  nodes: [
    { parameters: {}, name: 'Form Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [250, 300] },
    { parameters: { jsCode: "const d = $input.first().json;\nreturn [{ json: { name: d.name, email: d.email, phone: d.phone || 'Not provided', interested_unit: d.unit || 'General Inquiry', move_in_date: d.move_in_date || 'Flexible', budget: d.budget || 'Not specified', lead_id: `LEAD-${Date.now()}`, received_at: new Date().toISOString() } }];" }, name: 'Parse Inquiry', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300] },
    { parameters: { resource: 'contact', operation: 'create', additionalFields: { firstName: '={{$json.name.split(\" \")[0]}}', lastName: '={{$json.name.split(\" \").slice(1).join(\" \")}}', email: '={{$json.email}}', phone: '={{$json.phone}}', properties: { lead_source: 'Website Form', status: 'New Lead', interested_unit: '={{$json.interested_unit}}' } } }, name: 'Add to CRM', type: 'n8n-nodes-base.hubspot', typeVersion: 2, position: [650, 200] },
    { parameters: { fromEmail: '={{$env.FROM_EMAIL}}', toEmail: '={{$json.email}}', subject: 'Thanks for Your Interest - {{$json.interested_unit}}', emailType: 'html', message: '<h2>Thanks for Reaching Out!</h2><p>Hi {{$json.name}},</p><p>We received your inquiry about <strong>{{$json.interested_unit}}</strong>. Our leasing team will contact you within 2 business hours.</p><p>In the meantime, feel free to browse our available units at {{$env.LISTINGS_URL}}.</p>' }, name: 'Confirm to Prospect', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [650, 400] },
    { parameters: { fromEmail: '={{$env.FROM_EMAIL}}', toEmail: '={{$env.LEASING_AGENT_EMAIL}}', subject: '🏠 New Leasing Inquiry - {{$json.name}}', emailType: 'html', message: '<h2>New Leasing Inquiry</h2><p><strong>Lead ID:</strong> {{$json.lead_id}}</p><p><strong>Name:</strong> {{$json.name}}</p><p><strong>Email:</strong> {{$json.email}}</p><p><strong>Phone:</strong> {{$json.phone}}</p><p><strong>Interested In:</strong> {{$json.interested_unit}}</p><p><strong>Move-In Date:</strong> {{$json.move_in_date}}</p><p><strong>Budget:</strong> {{$json.budget}}</p>' }, name: 'Notify Leasing Agent', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [850, 300] }
  ],
  connections: {
    'Form Webhook': { main: [[{ node: 'Parse Inquiry', type: 'main', index: 0 }]] },
    'Parse Inquiry': { main: [[{ node: 'Add to CRM', type: 'main', index: 0 }, { node: 'Confirm to Prospect', type: 'main', index: 0 }]] },
    'Confirm to Prospect': { main: [[{ node: 'Notify Leasing Agent', type: 'main', index: 0 }]] }
  },
  active: false,
  settings: { executionOrder: 'v1' },
  id: 'leasing-inquiry-v1',
  meta: { templateId: 'leasing-inquiry', instanceId: 'ai-automation-builder' }
};

const guestMessagingWorkflow = {
  name: 'Airbnb Guest Messaging Automation',
  nodes: [
    { parameters: {}, name: 'Booking Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [250, 300] },
    { parameters: { jsCode: "const b = $input.first().json;\nconst checkIn = new Date(b.check_in_date);\nconst checkOut = new Date(b.check_out_date);\nconst preArrival = new Date(checkIn.getTime() - 24*60*60*1000);\nreturn [{ json: { guest_name: b.guest_name, guest_email: b.guest_email, confirmation: b.confirmation_code, check_in: checkIn.toLocaleDateString(), check_out: checkOut.toLocaleDateString(), pre_arrival_send: preArrival.toISOString(), nights: Math.round((checkOut - checkIn) / (1000*60*60*24)), property: b.listing_name || 'Our Property' } }];" }, name: 'Parse Booking', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300] },
    { parameters: { fromEmail: '={{$env.HOST_EMAIL}}', toEmail: '={{$json.guest_email}}', subject: '🏡 Booking Confirmed - {{$json.property}}', emailType: 'html', message: '<h2>Your Stay is Confirmed!</h2><p>Hi {{$json.guest_name}},</p><p>We\'re excited to host you at <strong>{{$json.property}}</strong>!</p><p>📅 <strong>Check-in:</strong> {{$json.check_in}}<br>📅 <strong>Check-out:</strong> {{$json.check_out}}<br>🌙 <strong>Nights:</strong> {{$json.nights}}</p><p>We\'ll send your check-in instructions 24 hours before arrival.</p><p>Confirmation: {{$json.confirmation}}</p>' }, name: 'Send Welcome Message', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [650, 200] },
    { parameters: { amount: 1, unit: 'days' }, name: 'Wait 24h Before Checkin', type: 'n8n-nodes-base.wait', typeVersion: 1, position: [650, 400] },
    { parameters: { fromEmail: '={{$env.HOST_EMAIL}}', toEmail: '={{$json.guest_email}}', subject: '🔑 Check-In Instructions - Tomorrow!', emailType: 'html', message: '<h2>Your Arrival is Tomorrow!</h2><p>Hi {{$json.guest_name}},</p><p>Here are your check-in details:</p><p>🔑 <strong>Access Code:</strong> {{$env.PROPERTY_ACCESS_CODE}}<br>📍 <strong>Address:</strong> {{$env.PROPERTY_ADDRESS}}<br>🕒 <strong>Check-in Time:</strong> {{$env.CHECKIN_TIME}}</p><p><strong>House Rules & WiFi</strong><br>WiFi: {{$env.WIFI_NETWORK}}<br>Password: {{$env.WIFI_PASSWORD}}</p><p>Enjoy your stay!</p>' }, name: 'Send Pre-Arrival Instructions', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [850, 400] }
  ],
  connections: {
    'Booking Webhook': { main: [[{ node: 'Parse Booking', type: 'main', index: 0 }]] },
    'Parse Booking': { main: [[{ node: 'Send Welcome Message', type: 'main', index: 0 }, { node: 'Wait 24h Before Checkin', type: 'main', index: 0 }]] },
    'Wait 24h Before Checkin': { main: [[{ node: 'Send Pre-Arrival Instructions', type: 'main', index: 0 }]] }
  },
  active: false,
  settings: { executionOrder: 'v1' },
  id: 'guest-messaging-v1',
  meta: { templateId: 'guest-messaging', instanceId: 'ai-automation-builder' }
};

const cleaningTurnoverWorkflow = {
  name: 'Cleaning Turnover Workflow',
  nodes: [
    { parameters: {}, name: 'Checkout Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [250, 300] },
    { parameters: { jsCode: "const data = $input.first().json;\nreturn [{ json: { property: data.listing_name, checkout_time: data.checkout_time || '11:00 AM', next_checkin: data.next_checkin || 'TBD', next_guest: data.next_guest_name || 'Next Guest', task_id: `CLEAN-${Date.now()}`, areas: ['Kitchen', 'Bathrooms', 'Bedrooms', 'Living Room', 'Outdoor Areas'] } }];" }, name: 'Process Checkout', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300] },
    { parameters: { fromEmail: '={{$env.HOST_EMAIL}}', toEmail: '={{$env.CLEANING_TEAM_EMAIL}}', subject: '🧹 Turnover Required - {{$json.property}}', emailType: 'html', message: '<h2>Turnover Assignment</h2><p>Task ID: {{$json.task_id}}</p><p><strong>Property:</strong> {{$json.property}}</p><p><strong>Checkout:</strong> {{$json.checkout_time}}</p><p><strong>Next Check-in:</strong> {{$json.next_checkin}}</p><p><strong>Next Guest:</strong> {{$json.next_guest}}</p><h3>Checklist Areas:</h3><ul>{{$json.areas.map(a => `<li>${a}</li>`).join(\"\")}}</ul><p>Please confirm completion by replying to this email.</p>' }, name: 'Notify Cleaning Team', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [650, 300] },
    { parameters: { amount: 3, unit: 'hours' }, name: 'Wait for Cleaning', type: 'n8n-nodes-base.wait', typeVersion: 1, position: [850, 300] },
    { parameters: { fromEmail: '={{$env.HOST_EMAIL}}', toEmail: '={{$env.HOST_EMAIL}}', subject: '✅ Turnover Complete Check - {{$json.property}}', emailType: 'html', message: '<p>Please confirm the property is ready for {{$json.next_guest}} checking in at {{$json.next_checkin}}.</p>' }, name: 'Completion Check', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [1050, 300] }
  ],
  connections: {
    'Checkout Webhook': { main: [[{ node: 'Process Checkout', type: 'main', index: 0 }]] },
    'Process Checkout': { main: [[{ node: 'Notify Cleaning Team', type: 'main', index: 0 }]] },
    'Notify Cleaning Team': { main: [[{ node: 'Wait for Cleaning', type: 'main', index: 0 }]] },
    'Wait for Cleaning': { main: [[{ node: 'Completion Check', type: 'main', index: 0 }]] }
  },
  active: false,
  settings: { executionOrder: 'v1' },
  id: 'cleaning-turnover-v1',
  meta: { templateId: 'cleaning-turnover', instanceId: 'ai-automation-builder' }
};

const checkInOutWorkflow = {
  name: 'Check-In / Check-Out Automation',
  nodes: [
    { parameters: {}, name: 'Event Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [250, 300] },
    { parameters: { conditions: { string: [{ value1: '={{$json.event_type}}', operation: 'equals', value2: 'check_in' }] } }, name: 'Is Check-In?', type: 'n8n-nodes-base.if', typeVersion: 1, position: [450, 300] },
    { parameters: { fromEmail: '={{$env.HOST_EMAIL}}', toEmail: '={{$json.guest_email}}', subject: '🏡 Welcome to {{$json.property}}!', emailType: 'html', message: '<h2>Welcome!</h2><p>Hi {{$json.guest_name}}, you\'ve officially checked in! Enjoy your stay.</p><p>Need anything? Contact us at {{$env.HOST_PHONE}}.</p>' }, name: 'Send Check-In Welcome', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [650, 200] },
    { parameters: { fromEmail: '={{$env.HOST_EMAIL}}', toEmail: '={{$json.guest_email}}', subject: '👋 Thanks for Staying at {{$json.property}}', emailType: 'html', message: '<h2>Thanks for Staying!</h2><p>Hi {{$json.guest_name}}, we hope you had a wonderful stay. Please leave us a review!</p><p>Review link: {{$env.REVIEW_LINK}}</p>' }, name: 'Send Check-Out Thanks', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [650, 400] },
    { parameters: { resource: 'event', operation: 'create', calendar: '={{$env.GOOGLE_CALENDAR_ID}}', start: '={{$json.timestamp}}', summary: '={{$json.event_type === \"check_in\" ? \"✅ Check-In\" : \"👋 Check-Out\"}}: {{$json.guest_name}}' }, name: 'Log to Calendar', type: 'n8n-nodes-base.googleCalendar', typeVersion: 1, position: [850, 300] }
  ],
  connections: {
    'Event Webhook': { main: [[{ node: 'Is Check-In?', type: 'main', index: 0 }]] },
    'Is Check-In?': { main: [[{ node: 'Send Check-In Welcome', type: 'main', index: 0 }], [{ node: 'Send Check-Out Thanks', type: 'main', index: 0 }]] },
    'Send Check-In Welcome': { main: [[{ node: 'Log to Calendar', type: 'main', index: 0 }]] },
    'Send Check-Out Thanks': { main: [[{ node: 'Log to Calendar', type: 'main', index: 0 }]] }
  },
  active: false,
  settings: { executionOrder: 'v1' },
  id: 'checkin-checkout-v1',
  meta: { templateId: 'checkin-checkout', instanceId: 'ai-automation-builder' }
};

const abandonedCartWorkflow = {
  name: 'Shopify Abandoned Cart Recovery',
  nodes: [
    { parameters: {}, name: 'Cart Abandoned Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [250, 300] },
    { parameters: { jsCode: "const cart = $input.first().json;\nreturn [{ json: { customer_name: cart.customer?.first_name || 'there', customer_email: cart.email, cart_token: cart.token, total_price: parseFloat(cart.total_price || 0).toFixed(2), item_count: cart.line_items?.length || 0, items: (cart.line_items || []).slice(0, 3).map(i => i.title).join(', '), recovery_url: cart.abandoned_checkout_url, cart_id: cart.id } }];" }, name: 'Parse Cart Data', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300] },
    { parameters: { amount: 1, unit: 'hours' }, name: 'Wait 1 Hour', type: 'n8n-nodes-base.wait', typeVersion: 1, position: [650, 300] },
    { parameters: { fromEmail: '={{$env.STORE_EMAIL}}', toEmail: '={{$json.customer_email}}', subject: 'You left something behind, {{$json.customer_name}} 👀', emailType: 'html', message: '<h2>Did you forget something?</h2><p>Hi {{$json.customer_name}},</p><p>You left <strong>{{$json.item_count}} item(s)</strong> worth <strong>${{$json.total_price}}</strong> in your cart.</p><p>Items: {{$json.items}}</p><p><a href="{{$json.recovery_url}}" style="background:#000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Complete Your Purchase</a></p>' }, name: 'First Recovery Email', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [850, 300] },
    { parameters: { amount: 23, unit: 'hours' }, name: 'Wait 23 More Hours', type: 'n8n-nodes-base.wait', typeVersion: 1, position: [1050, 300] },
    { parameters: { fromEmail: '={{$env.STORE_EMAIL}}', toEmail: '={{$json.customer_email}}', subject: 'Still thinking? Here\'s 10% off 🎁', emailType: 'html', message: '<h2>Still interested?</h2><p>Hi {{$json.customer_name}},</p><p>Your cart is about to expire! Use code <strong>{{$env.CART_RECOVERY_DISCOUNT}}</strong> for 10% off your order.</p><p><a href="{{$json.recovery_url}}" style="background:#000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Claim Your Discount</a></p>' }, name: 'Discount Recovery Email', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [1250, 300] }
  ],
  connections: {
    'Cart Abandoned Webhook': { main: [[{ node: 'Parse Cart Data', type: 'main', index: 0 }]] },
    'Parse Cart Data': { main: [[{ node: 'Wait 1 Hour', type: 'main', index: 0 }]] },
    'Wait 1 Hour': { main: [[{ node: 'First Recovery Email', type: 'main', index: 0 }]] },
    'First Recovery Email': { main: [[{ node: 'Wait 23 More Hours', type: 'main', index: 0 }]] },
    'Wait 23 More Hours': { main: [[{ node: 'Discount Recovery Email', type: 'main', index: 0 }]] }
  },
  active: false,
  settings: { executionOrder: 'v1', timezone: 'America/New_York' },
  id: 'abandoned-cart-v1',
  meta: { templateId: 'abandoned-cart', instanceId: 'ai-automation-builder' }
};

const orderFulfillmentWorkflow = {
  name: 'Order Fulfillment Automation',
  nodes: [
    { parameters: {}, name: 'New Order Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [250, 300] },
    { parameters: { jsCode: "const order = $input.first().json;\nreturn [{ json: { order_id: order.id, order_number: order.order_number, customer_name: `${order.customer?.first_name} ${order.customer?.last_name}`, customer_email: order.email, items: order.line_items?.map(i => `${i.quantity}x ${i.title}`).join(', '), total: parseFloat(order.total_price || 0).toFixed(2), shipping_address: order.shipping_address ? `${order.shipping_address.address1}, ${order.shipping_address.city}` : 'N/A', status: 'Processing' } }];" }, name: 'Parse Order', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300] },
    { parameters: { fromEmail: '={{$env.STORE_EMAIL}}', toEmail: '={{$json.customer_email}}', subject: '✅ Order Confirmed #{{$json.order_number}}', emailType: 'html', message: '<h2>Order Confirmed!</h2><p>Hi {{$json.customer_name}},</p><p>Thanks for your order! We\'re processing it now.</p><p><strong>Order #{{$json.order_number}}</strong><br>Items: {{$json.items}}<br>Total: ${{$json.total}}</p><p>You\'ll receive shipping confirmation soon.</p>' }, name: 'Order Confirmation Email', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [650, 200] },
    { parameters: { fromEmail: '={{$env.STORE_EMAIL}}', toEmail: '={{$env.WAREHOUSE_EMAIL}}', subject: '📦 New Order to Fulfill #{{$json.order_number}}', emailType: 'html', message: '<h2>New Order</h2><p><strong>Order:</strong> #{{$json.order_number}}</p><p><strong>Items:</strong> {{$json.items}}</p><p><strong>Ship To:</strong> {{$json.shipping_address}}</p><p>Please process and ship within 24 hours.</p>' }, name: 'Notify Warehouse', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [650, 400] },
    { parameters: { resource: 'order', operation: 'addTags', orderId: '={{$json.order_id}}', tags: ['automation-processed'] }, name: 'Tag Order in Shopify', type: 'n8n-nodes-base.shopify', typeVersion: 1, position: [850, 300] }
  ],
  connections: {
    'New Order Webhook': { main: [[{ node: 'Parse Order', type: 'main', index: 0 }]] },
    'Parse Order': { main: [[{ node: 'Order Confirmation Email', type: 'main', index: 0 }, { node: 'Notify Warehouse', type: 'main', index: 0 }]] },
    'Order Confirmation Email': { main: [[{ node: 'Tag Order in Shopify', type: 'main', index: 0 }]] }
  },
  active: false,
  settings: { executionOrder: 'v1' },
  id: 'order-fulfillment-v1',
  meta: { templateId: 'order-fulfillment', instanceId: 'ai-automation-builder' }
};

const returnsWorkflow = {
  name: 'Returns & Refund Workflow',
  nodes: [
    { parameters: {}, name: 'Return Request Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [250, 300] },
    { parameters: { jsCode: "const ret = $input.first().json;\nreturn [{ json: { return_id: `RET-${Date.now()}`, order_id: ret.order_id, order_number: ret.order_number, customer_name: ret.customer_name, customer_email: ret.customer_email, reason: ret.reason || 'Not specified', items: ret.items || 'All items', refund_amount: ret.refund_amount || 'Full refund', created_at: new Date().toISOString() } }];" }, name: 'Process Return Request', type: 'n8n-nodes-base.code', typeVersion: 2, position: [450, 300] },
    { parameters: { fromEmail: '={{$env.STORE_EMAIL}}', toEmail: '={{$json.customer_email}}', subject: 'Return Approved - {{$json.return_id}}', emailType: 'html', message: '<h2>Return Request Approved</h2><p>Hi {{$json.customer_name}},</p><p>Your return request ({{$json.return_id}}) for Order #{{$json.order_number}} has been approved.</p><p><strong>Items:</strong> {{$json.items}}<br><strong>Reason:</strong> {{$json.reason}}</p><p>📦 Please ship your return to:<br>{{$env.RETURN_ADDRESS}}</p><p>Your refund of {{$json.refund_amount}} will be processed within 5-7 business days after we receive your return.</p>' }, name: 'Send Return Instructions', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [650, 200] },
    { parameters: { fromEmail: '={{$env.STORE_EMAIL}}', toEmail: '={{$env.RETURNS_TEAM_EMAIL}}', subject: '↩️ New Return Request - {{$json.return_id}}', emailType: 'html', message: '<h2>Return Request</h2><p><strong>Return ID:</strong> {{$json.return_id}}</p><p><strong>Order:</strong> #{{$json.order_number}}</p><p><strong>Customer:</strong> {{$json.customer_name}} ({{$json.customer_email}})</p><p><strong>Items:</strong> {{$json.items}}</p><p><strong>Reason:</strong> {{$json.reason}}</p><p><strong>Refund:</strong> {{$json.refund_amount}}</p>' }, name: 'Notify Returns Team', type: 'n8n-nodes-base.emailSend', typeVersion: 2, position: [650, 400] },
    { parameters: { resource: 'refund', operation: 'create', orderId: '={{$json.order_id}}', note: 'Automated return - {{$json.return_id}}' }, name: 'Initiate Shopify Refund', type: 'n8n-nodes-base.shopify', typeVersion: 1, position: [850, 300] }
  ],
  connections: {
    'Return Request Webhook': { main: [[{ node: 'Process Return Request', type: 'main', index: 0 }]] },
    'Process Return Request': { main: [[{ node: 'Send Return Instructions', type: 'main', index: 0 }, { node: 'Notify Returns Team', type: 'main', index: 0 }]] },
    'Send Return Instructions': { main: [[{ node: 'Initiate Shopify Refund', type: 'main', index: 0 }]] }
  },
  active: false,
  settings: { executionOrder: 'v1' },
  id: 'returns-workflow-v1',
  meta: { templateId: 'returns-workflow', instanceId: 'ai-automation-builder' }
};

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'tenant-maintenance',
    name: 'Tenant Maintenance Requests',
    industry: 'property-management',
    description: 'Automatically capture, log, and route maintenance requests from tenants to the right team with instant confirmations.',
    keywords: ['maintenance', 'repair', 'tenant', 'request', 'fix', 'broken', 'property', 'issue', 'ticket', 'facility'],
    nodeCount: 5,
    complexity: 'intermediate',
    estimatedSetupTime: '20 minutes',
    tags: ['webhook', 'email', 'airtable', 'property'],
    workflow: propertyMaintenanceWorkflow,
    envConfig: `# Tenant Maintenance Request Automation
# Generated by MagicFlux

# ── Email Configuration ──────────────────────────────
FROM_EMAIL=noreply@yourproperty.com
PROPERTY_MANAGER_EMAIL=manager@yourproperty.com

# ── Airtable Configuration ───────────────────────────
AIRTABLE_API_KEY=your_airtable_api_key_here
AIRTABLE_BASE_ID=your_airtable_base_id_here

# ── n8n Configuration ────────────────────────────────
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/maintenance-webhook

# ── Optional: SMTP (if not using n8n built-in) ───────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
`,
    setupGuide: `# Tenant Maintenance Request Automation - Setup Guide

## Overview
This automation captures maintenance requests via a webhook, creates a ticket in Airtable, notifies your property manager, and sends a confirmation to the tenant.

## Prerequisites
- n8n instance (self-hosted or cloud)
- Airtable account with a base set up
- SMTP email access (Gmail, SendGrid, etc.)

## Step 1: Set Up Airtable Base
1. Create a new Airtable base called **"Property Management"**
2. Add a table called **"Maintenance Tickets"** with these fields:
   - \`Ticket_ID\` (Single line text)
   - \`Tenant\` (Single line text)
   - \`Unit\` (Single line text)
   - \`Issue\` (Long text)
   - \`Priority\` (Single select: Low, Normal, High, Emergency)
   - \`Status\` (Single select: Open, In Progress, Resolved)
   - \`Created\` (Date)
   - \`Last_Reminder_Sent\` (Date)
3. Get your **Base ID** from the Airtable URL: \`airtable.com/{BASE_ID}/...\`

## Step 2: Import the Workflow
1. Open your n8n instance
2. Click **"Add workflow"** → **"Import from file"**
3. Upload the \`workflow.json\` file from this package

## Step 3: Configure Credentials
1. In n8n, go to **Settings** → **Credentials**
2. Add **Airtable API** credentials using your API key
3. Add **SMTP** credentials for email sending

## Step 4: Configure Environment Variables
1. Copy \`.env.example\` to \`.env\`
2. Fill in all values
3. In n8n, set these as workflow variables or environment variables

## Step 5: Set Up Your Intake Form
Create a form (Typeform, Tally, or your website) that sends a POST request to the webhook URL with:
\`\`\`json
{
  "tenant_name": "John Smith",
  "tenant_email": "john@email.com",
  "unit_number": "4B",
  "issue_description": "Leaking faucet in bathroom",
  "urgency": "normal"
}
\`\`\`

## Step 6: Activate & Test
1. Click **"Active"** toggle in n8n to enable the workflow
2. Submit a test form
3. Verify the Airtable record was created
4. Check that both emails were sent

## Troubleshooting
- **Webhook not receiving data**: Check your n8n webhook URL and ensure it's publicly accessible
- **Airtable errors**: Verify your API key and Base ID are correct
- **Email not sending**: Check SMTP credentials and that less secure app access is enabled

## Support
For help, contact support@magicflux.ai
`
  },
  {
    id: 'rent-reminder',
    name: 'Rent Reminder Automation',
    industry: 'property-management',
    description: 'Schedule and send automated rent reminders to all active tenants on the 1st of each month with payment instructions.',
    keywords: ['rent', 'reminder', 'payment', 'due', 'monthly', 'schedule', 'tenant', 'invoice', 'bill', 'overdue'],
    nodeCount: 5,
    complexity: 'beginner',
    estimatedSetupTime: '15 minutes',
    tags: ['schedule', 'email', 'airtable', 'cron'],
    workflow: rentReminderWorkflow,
    envConfig: `# Rent Reminder Automation
# Generated by MagicFlux

# ── Email Configuration ──────────────────────────────
FROM_EMAIL=noreply@yourproperty.com
PAYMENT_METHODS=Bank transfer, Zelle, or check

# ── Airtable Configuration ───────────────────────────
AIRTABLE_API_KEY=your_airtable_api_key_here
AIRTABLE_BASE_ID=your_airtable_base_id_here

# ── SMTP Configuration ───────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# ── Schedule ─────────────────────────────────────────
REMINDER_CRON=0 9 1 * *
# Runs at 9:00 AM on the 1st of every month
`,
    setupGuide: `# Rent Reminder Automation - Setup Guide

## Overview
Automatically send rent reminder emails to all active tenants on the 1st of every month.

## Prerequisites
- n8n instance
- Airtable account
- SMTP email access

## Step 1: Airtable Tenant Table
Create a **"Tenants"** table in Airtable with:
- \`Name\` (Single line text)
- \`Email\` (Email field)
- \`Unit\` (Single line text)
- \`Monthly_Rent\` (Currency)
- \`Rent_Due_Day\` (Number — set to 1 for all tenants)
- \`Status\` (Single select: Active, Inactive)
- \`Last_Reminder_Sent\` (Date)

## Step 2: Import & Configure
1. Import \`workflow.json\` into n8n
2. Update the Schedule Trigger cron expression if needed (default: 1st of month, 9 AM)
3. Configure Airtable and SMTP credentials

## Step 3: Customize the Email
Edit the "Send Reminder Email" node to match your brand and payment instructions.

## Step 4: Test
1. Temporarily change the cron to \`* * * * *\` (every minute) for testing
2. Verify emails are sent correctly
3. Restore the original cron schedule
4. Activate the workflow

## Notes
- The workflow automatically logs the last reminder date to Airtable
- Only tenants with \`Status = Active\` receive reminders
`
  },
  {
    id: 'leasing-inquiry',
    name: 'Leasing Inquiry Automation',
    industry: 'property-management',
    description: 'Capture leasing inquiries, add leads to your CRM, and auto-respond while notifying your leasing agent instantly.',
    keywords: ['leasing', 'inquiry', 'lead', 'prospect', 'apartment', 'unit', 'available', 'showing', 'application', 'rental'],
    nodeCount: 5,
    complexity: 'intermediate',
    estimatedSetupTime: '25 minutes',
    tags: ['webhook', 'hubspot', 'email', 'crm'],
    workflow: leasingInquiryWorkflow,
    envConfig: `# Leasing Inquiry Automation
# Generated by MagicFlux

# ── Email Configuration ──────────────────────────────
FROM_EMAIL=leasing@yourproperty.com
LEASING_AGENT_EMAIL=agent@yourproperty.com
LISTINGS_URL=https://yourproperty.com/listings

# ── HubSpot CRM ──────────────────────────────────────
HUBSPOT_API_KEY=your_hubspot_private_app_token

# ── SMTP Configuration ───────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# ── Webhook ──────────────────────────────────────────
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/leasing-inquiry
`,
    setupGuide: `# Leasing Inquiry Automation - Setup Guide

## Overview
Automatically respond to leasing inquiries, add prospects to HubSpot CRM, and notify your leasing agent.

## Prerequisites
- n8n instance
- HubSpot account (free tier works)
- SMTP email access

## Step 1: HubSpot Setup
1. Create a HubSpot Private App with **CRM** permissions
2. Copy the access token

## Step 2: Connect Your Intake Form
The webhook accepts POST requests with:
\`\`\`json
{
  "name": "Jane Doe",
  "email": "jane@email.com",
  "phone": "555-0100",
  "unit": "Studio - Building A",
  "move_in_date": "2024-03-01",
  "budget": "1500"
}
\`\`\`

## Step 3: Import & Configure
1. Import workflow into n8n
2. Add HubSpot credentials
3. Add SMTP credentials
4. Set all environment variables

## Step 4: Test & Activate
Submit a test inquiry and verify:
- Contact appears in HubSpot
- Auto-reply sent to prospect
- Notification sent to leasing agent
`
  },
  {
    id: 'guest-messaging',
    name: 'Guest Messaging Automation',
    industry: 'airbnb',
    description: 'Send automated welcome messages, pre-arrival instructions, and check-in details to every Airbnb guest.',
    keywords: ['guest', 'message', 'airbnb', 'booking', 'welcome', 'checkin', 'arrival', 'instructions', 'host', 'rental'],
    nodeCount: 5,
    complexity: 'intermediate',
    estimatedSetupTime: '20 minutes',
    tags: ['webhook', 'email', 'airbnb', 'automation'],
    workflow: guestMessagingWorkflow,
    envConfig: `# Airbnb Guest Messaging Automation
# Generated by MagicFlux

# ── Host Email ───────────────────────────────────────
HOST_EMAIL=yourname@email.com
HOST_PHONE=+1 (555) 000-0000

# ── Property Details ─────────────────────────────────
PROPERTY_ADDRESS=123 Main St, City, State 12345
PROPERTY_ACCESS_CODE=1234
CHECKIN_TIME=3:00 PM
CHECKOUT_TIME=11:00 AM

# ── WiFi Details ─────────────────────────────────────
WIFI_NETWORK=PropertyName_Guest
WIFI_PASSWORD=your-wifi-password

# ── SMTP Configuration ───────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# ── Webhook ──────────────────────────────────────────
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/airbnb-booking
`,
    setupGuide: `# Guest Messaging Automation - Setup Guide

## Overview
Automatically send personalized welcome messages and check-in instructions to every new guest booking.

## Prerequisites
- n8n instance
- SMTP email (or SendGrid/Mailgun)
- A way to receive Airbnb booking notifications (Zapier, Make, or custom integration)

## Step 1: Connect Airbnb Bookings
Since Airbnb doesn't have a native webhook, use one of these methods:
- **Zapier**: Use "New Booking" trigger → POST to n8n webhook
- **Email Parse**: Forward Airbnb booking emails → parse with n8n Email Trigger
- **iCal Sync**: Monitor Airbnb iCal feed with n8n Schedule Trigger

## Step 2: Configure Property Details
Update all \`.env\` variables with your property details, access codes, and WiFi info.

## Step 3: Import & Test
1. Import the workflow into n8n
2. Create a test booking payload
3. Verify both emails (welcome + pre-arrival) arrive correctly

## Step 4: Customize Messages
Edit the email content in each node to match your tone and add any property-specific information.

## Step 5: Activate
Turn on the workflow and monitor your first real booking.
`
  },
  {
    id: 'cleaning-turnover',
    name: 'Cleaning Turnover Workflow',
    industry: 'airbnb',
    description: 'Automatically notify your cleaning team after every checkout and track turnover completion between guests.',
    keywords: ['cleaning', 'turnover', 'checkout', 'housekeeper', 'clean', 'team', 'schedule', 'between guests', 'checklist'],
    nodeCount: 5,
    complexity: 'beginner',
    estimatedSetupTime: '15 minutes',
    tags: ['webhook', 'email', 'cleaning', 'schedule'],
    workflow: cleaningTurnoverWorkflow,
    envConfig: `# Cleaning Turnover Workflow
# Generated by MagicFlux

# ── Contact Emails ───────────────────────────────────
HOST_EMAIL=yourname@email.com
CLEANING_TEAM_EMAIL=cleaners@email.com

# ── SMTP Configuration ───────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# ── Optional: Slack Notifications ────────────────────
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/your/webhook/url

# ── Webhook ──────────────────────────────────────────
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/checkout-event
`,
    setupGuide: `# Cleaning Turnover Workflow - Setup Guide

## Overview
Notify your cleaning team automatically after every checkout, with a built-in 3-hour wait for completion check.

## Step 1: Connect Checkout Events
Trigger this workflow when a guest checks out via:
- Manual trigger from your Airbnb management app
- Airbnb iCal monitoring (checkout date detection)
- Zapier/Make Airbnb checkout trigger

Send a POST to the webhook with:
\`\`\`json
{
  "listing_name": "Beach House - Unit A",
  "checkout_time": "11:00 AM",
  "next_checkin": "March 15, 2024 at 3:00 PM",
  "next_guest_name": "Smith Family"
}
\`\`\`

## Step 2: Import & Configure
1. Import workflow into n8n
2. Update CLEANING_TEAM_EMAIL to your cleaner's email
3. Optionally add a Slack notification node

## Step 3: Activate & Test
Test with a dummy checkout event and verify your cleaning team receives the email.
`
  },
  {
    id: 'checkin-checkout',
    name: 'Check-In / Check-Out Automation',
    industry: 'airbnb',
    description: 'Automate welcome messages at check-in and thank-you notes with review requests at check-out.',
    keywords: ['check-in', 'checkout', 'arrival', 'departure', 'welcome', 'review', 'guest', 'airbnb', 'message'],
    nodeCount: 5,
    complexity: 'beginner',
    estimatedSetupTime: '15 minutes',
    tags: ['webhook', 'email', 'calendar', 'reviews'],
    workflow: checkInOutWorkflow,
    envConfig: `# Check-In / Check-Out Automation
# Generated by MagicFlux

# ── Host Contact ─────────────────────────────────────
HOST_EMAIL=yourname@email.com
HOST_PHONE=+1 (555) 000-0000
REVIEW_LINK=https://airbnb.com/your-review-link

# ── Google Calendar ──────────────────────────────────
GOOGLE_CALENDAR_ID=your-calendar-id@group.calendar.google.com

# ── SMTP Configuration ───────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# ── Webhook ──────────────────────────────────────────
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/guest-event
`,
    setupGuide: `# Check-In / Check-Out Automation - Setup Guide

## Overview
Send personalized check-in welcomes and checkout thank-you emails, while logging events to Google Calendar.

## Trigger Format
Send a POST request with \`event_type\` as either \`"check_in"\` or \`"check_out"\`:
\`\`\`json
{
  "event_type": "check_in",
  "guest_name": "John Smith",
  "guest_email": "john@email.com",
  "property": "Beach House",
  "timestamp": "2024-03-10T15:00:00Z"
}
\`\`\`

## Google Calendar Setup
1. Create a Google Cloud project
2. Enable the Calendar API
3. Create OAuth2 credentials
4. Add Google Calendar credentials in n8n

## Activate
Import, configure, and activate the workflow.
`
  },
  {
    id: 'abandoned-cart',
    name: 'Abandoned Cart Recovery',
    industry: 'shopify',
    description: 'Recover lost revenue with a 3-touch email sequence: immediate reminder, 24h follow-up, and 48h discount offer.',
    keywords: ['abandoned', 'cart', 'recovery', 'shopify', 'email', 'ecommerce', 'checkout', 'lost', 'revenue', 'discount'],
    nodeCount: 6,
    complexity: 'intermediate',
    estimatedSetupTime: '25 minutes',
    tags: ['webhook', 'email', 'shopify', 'ecommerce', 'sequence'],
    workflow: abandonedCartWorkflow,
    envConfig: `# Abandoned Cart Recovery Automation
# Generated by MagicFlux

# ── Store Configuration ──────────────────────────────
STORE_EMAIL=noreply@yourstore.com
SHOPIFY_STORE_URL=your-store.myshopify.com
SHOPIFY_API_KEY=your_shopify_api_key
SHOPIFY_API_SECRET=your_shopify_api_secret
SHOPIFY_ACCESS_TOKEN=your_shopify_access_token

# ── Recovery Campaign ────────────────────────────────
CART_RECOVERY_DISCOUNT=COMEBACK10
# 10% off discount code for second email

# ── SMTP Configuration ───────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# ── Webhook ──────────────────────────────────────────
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/cart-abandoned
`,
    setupGuide: `# Abandoned Cart Recovery - Setup Guide

## Overview
A 3-email sequence to recover abandoned carts:
1. **1 hour** after abandonment: Friendly reminder
2. **24 hours** after abandonment: Follow-up with urgency
3. **48 hours** after abandonment: 10% discount offer

## Step 1: Shopify Webhook Setup
1. In Shopify Admin → **Settings** → **Notifications** → **Webhooks**
2. Add webhook for **"Checkout abandoned"** event
3. Set URL to your n8n webhook URL

## Step 2: Create Discount Code
1. In Shopify: **Discounts** → **Create discount**
2. Name it \`COMEBACK10\` (10% off)
3. Set expiry date

## Step 3: Import & Configure
1. Import workflow into n8n
2. Configure SMTP credentials
3. Update the store details in the email nodes

## Step 4: Activate
Enable the workflow. Monitor the first few runs to ensure emails are sending correctly.

## Expected Results
- Average cart recovery rate: 5–15%
- Email sequence timing: 1h, 24h, 48h post-abandonment
`
  },
  {
    id: 'order-fulfillment',
    name: 'Order Fulfillment Automation',
    industry: 'shopify',
    description: 'Instantly confirm new orders with customers and notify your warehouse team with all fulfillment details.',
    keywords: ['order', 'fulfillment', 'shopify', 'shipping', 'warehouse', 'confirmation', 'processing', 'dispatch', 'ecommerce'],
    nodeCount: 5,
    complexity: 'beginner',
    estimatedSetupTime: '20 minutes',
    tags: ['webhook', 'shopify', 'email', 'fulfillment'],
    workflow: orderFulfillmentWorkflow,
    envConfig: `# Order Fulfillment Automation
# Generated by MagicFlux

# ── Store Configuration ──────────────────────────────
STORE_EMAIL=orders@yourstore.com
SHOPIFY_STORE_URL=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=your_shopify_access_token

# ── Warehouse ────────────────────────────────────────
WAREHOUSE_EMAIL=warehouse@yourstore.com

# ── SMTP Configuration ───────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# ── Webhook ──────────────────────────────────────────
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/new-order
`,
    setupGuide: `# Order Fulfillment Automation - Setup Guide

## Overview
Automatically send order confirmation emails to customers and notify your warehouse team for every new Shopify order.

## Step 1: Shopify Webhook
1. Shopify Admin → **Settings** → **Notifications** → **Webhooks**
2. Add webhook for **"Order created"** event
3. Point to your n8n webhook URL

## Step 2: Configure Emails
Update the email templates in n8n to match your brand.

## Step 3: Warehouse Notification
Set \`WAREHOUSE_EMAIL\` to your fulfillment team's email. If you use a 3PL, many accept order notifications via email.

## Step 4: Test
Create a test order and verify both emails send correctly.

## Extensions
- Add SMS notification via Twilio
- Integrate with ShipStation or EasyPost for shipping labels
- Add inventory update via Google Sheets or Airtable
`
  },
  {
    id: 'returns-workflow',
    name: 'Returns Workflow',
    industry: 'shopify',
    description: 'Streamline returns with automatic approval emails, return instructions, team notifications, and Shopify refund initiation.',
    keywords: ['returns', 'refund', 'return', 'shopify', 'customer service', 'exchange', 'policy', 'rma', 'reverse logistics'],
    nodeCount: 5,
    complexity: 'advanced',
    estimatedSetupTime: '30 minutes',
    tags: ['webhook', 'shopify', 'email', 'refunds'],
    workflow: returnsWorkflow,
    envConfig: `# Returns & Refund Workflow
# Generated by MagicFlux

# ── Store Configuration ──────────────────────────────
STORE_EMAIL=support@yourstore.com
SHOPIFY_STORE_URL=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=your_shopify_access_token

# ── Return Handling ──────────────────────────────────
RETURNS_TEAM_EMAIL=returns@yourstore.com
RETURN_ADDRESS=123 Returns St, Warehouse City, CA 90210

# ── SMTP Configuration ───────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# ── Webhook ──────────────────────────────────────────
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/return-request
`,
    setupGuide: `# Returns & Refund Workflow - Setup Guide

## Overview
Automate the full returns process: customer notification, team alert, and Shopify refund initiation.

## Step 1: Return Request Form
Create a returns form (Typeform, Tally, Google Forms) that posts to the webhook with:
\`\`\`json
{
  "order_id": "5678901234",
  "order_number": "1234",
  "customer_name": "Jane Smith",
  "customer_email": "jane@email.com",
  "reason": "Wrong size",
  "items": "Blue T-Shirt (L)",
  "refund_amount": "$49.99"
}
\`\`\`

## Step 2: Shopify API Access
The workflow uses the Shopify API to initiate refunds. Ensure your access token has **write_orders** and **write_customers** permissions.

## Step 3: Configure Return Policy
Update the email templates with your return policy, timeframe, and shipping address.

## Step 4: Test
Submit a test return request with a real order ID and verify all steps complete.

## Important Notes
- Shopify refunds are initiated automatically; review your return policy before activating
- Consider adding a conditional node to require manager approval for high-value refunds
`
  }
];

export const INDUSTRIES = [
  {
    id: 'property-management' as Industry,
    name: 'Property Management',
    icon: 'Building2',
    description: 'Automate tenant operations, maintenance, and leasing workflows',
    color: 'blue',
    templates: AUTOMATION_TEMPLATES.filter(t => t.industry === 'property-management')
  },
  {
    id: 'airbnb' as Industry,
    name: 'Short-Term Rentals',
    icon: 'Home',
    description: 'Streamline guest communications and turnover operations',
    color: 'cyan',
    templates: AUTOMATION_TEMPLATES.filter(t => t.industry === 'airbnb')
  },
  {
    id: 'shopify' as Industry,
    name: 'Shopify Operators',
    icon: 'ShoppingBag',
    description: 'Boost conversions and automate order management',
    color: 'emerald',
    templates: AUTOMATION_TEMPLATES.filter(t => t.industry === 'shopify')
  }
];

export const PROMPT_EXAMPLES = [
  'Build a tenant maintenance request automation',
  'Create an Airbnb guest messaging workflow',
  'Set up Shopify abandoned cart recovery emails',
  'Automate rent reminders for my tenants',
  'Create a cleaning turnover notification system',
  'Build an order fulfillment automation for my Shopify store',
  'Automate leasing inquiry responses and CRM updates',
  'Create a check-in and check-out workflow for my rental',
  'Set up an automated returns and refund workflow'
];
