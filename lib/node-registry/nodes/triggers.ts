import { Webhook, Clock, ShoppingBag, Mail } from 'lucide-react';
import type { NodeDef } from '../types';

export const webhookNode: NodeDef = {
  type: 'n8n-nodes-base.webhook',
  label: 'Webhook',
  category: 'trigger',
  description: 'Starts the workflow when an HTTP request hits the webhook URL.',
  icon: Webhook,
  iconColor: 'bg-orange-100 text-orange-700',
  isTrigger: true,
  fields: [
    {
      key: 'path',
      label: 'Webhook Path',
      type: 'text',
      required: true,
      placeholder: '/my-webhook',
      description: 'URL path segment appended to the base webhook URL.',
    },
    {
      key: 'httpMethod',
      label: 'HTTP Method',
      type: 'select',
      default: 'POST',
      options: [
        { label: 'POST', value: 'POST' },
        { label: 'GET', value: 'GET' },
        { label: 'PUT', value: 'PUT' },
        { label: 'DELETE', value: 'DELETE' },
      ],
    },
    {
      key: 'responseMode',
      label: 'Response Mode',
      type: 'select',
      default: 'onLastNode',
      options: [
        { label: 'When last node finishes', value: 'onLastNode' },
        { label: 'Immediately', value: 'immediately' },
      ],
    },
  ],
};

export const scheduleTriggerNode: NodeDef = {
  type: 'n8n-nodes-base.scheduleTrigger',
  label: 'Schedule',
  category: 'trigger',
  description: 'Starts the workflow on a cron schedule.',
  icon: Clock,
  iconColor: 'bg-orange-100 text-orange-700',
  isTrigger: true,
  fields: [
    {
      key: 'cronExpression',
      label: 'Cron Expression',
      type: 'text',
      required: true,
      placeholder: '0 9 * * 1-5',
      description: 'Standard cron syntax. Example: "0 9 * * 1-5" = 09:00 Mon–Fri.',
    },
    {
      key: 'timezone',
      label: 'Timezone',
      type: 'text',
      placeholder: 'UTC',
      description: 'IANA timezone string. Defaults to UTC.',
    },
  ],
};

export const shopifyTriggerNode: NodeDef = {
  type: 'n8n-nodes-base.shopifyTrigger',
  label: 'Shopify Order',
  category: 'trigger',
  description: 'Triggers when a Shopify event occurs (order created, updated, etc.).',
  icon: ShoppingBag,
  iconColor: 'bg-green-100 text-green-700',
  isTrigger: true,
  fields: [
    {
      key: 'topic',
      label: 'Event Topic',
      type: 'select',
      required: true,
      default: 'orders/create',
      options: [
        { label: 'Order Created', value: 'orders/create' },
        { label: 'Order Updated', value: 'orders/updated' },
        { label: 'Order Fulfilled', value: 'orders/fulfilled' },
        { label: 'Order Cancelled', value: 'orders/cancelled' },
        { label: 'Product Created', value: 'products/create' },
        { label: 'Customer Created', value: 'customers/create' },
      ],
    },
    {
      key: 'shopDomain',
      label: 'Shop Domain',
      type: 'text',
      required: true,
      placeholder: 'my-store.myshopify.com',
    },
  ],
};

export const gmailTriggerNode: NodeDef = {
  type: 'n8n-nodes-base.gmailTrigger',
  label: 'Gmail Trigger',
  category: 'trigger',
  description: 'Triggers when a new email arrives in your Gmail inbox.',
  icon: Mail,
  iconColor: 'bg-blue-100 text-blue-700',
  isTrigger: true,
  fields: [
    {
      key: 'pollTimes',
      label: 'Poll Interval (minutes)',
      type: 'number',
      default: 5,
      min: 1,
      max: 60,
    },
    {
      key: 'filters',
      label: 'Gmail Filter Query',
      type: 'text',
      placeholder: 'from:boss@example.com subject:urgent',
      description: 'Gmail search query to filter which emails trigger this node.',
    },
  ],
};
