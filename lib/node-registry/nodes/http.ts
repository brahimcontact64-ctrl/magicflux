import { Globe } from 'lucide-react';
import type { NodeDef } from '../types';

export const httpRequestNode: NodeDef = {
  type: 'n8n-nodes-base.httpRequest',
  label: 'HTTP Request',
  category: 'http',
  description: 'Makes an HTTP request to any API or URL.',
  icon: Globe,
  iconColor: 'bg-cyan-100 text-cyan-700',
  // Optional — a generic/custom API-key credential can be selected to have its
  // header injected automatically at runtime (see httpHandler). The node still
  // works with manually-entered headers when no credential is connected.
  credentialProvider: 'custom',
  fields: [
    {
      key: 'url',
      label: 'URL',
      type: 'url',
      required: true,
      placeholder: 'https://api.example.com/endpoint',
    },
    {
      key: 'method',
      label: 'Method',
      type: 'select',
      required: true,
      default: 'GET',
      options: [
        { label: 'GET', value: 'GET' },
        { label: 'POST', value: 'POST' },
        { label: 'PUT', value: 'PUT' },
        { label: 'PATCH', value: 'PATCH' },
        { label: 'DELETE', value: 'DELETE' },
      ],
    },
    {
      key: 'headers',
      label: 'Headers',
      type: 'json',
      placeholder: '{\n  "Authorization": "Bearer TOKEN",\n  "Content-Type": "application/json"\n}',
      description: 'JSON object of request headers.',
    },
    {
      key: 'body',
      label: 'Body',
      type: 'json',
      placeholder: '{\n  "key": "value"\n}',
      description: 'Request body as JSON. Only sent for POST / PUT / PATCH.',
    },
    {
      key: 'timeout',
      label: 'Timeout (ms)',
      type: 'number',
      default: 10000,
      min: 100,
      max: 120000,
    },
  ],
};
