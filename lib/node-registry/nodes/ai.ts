import { Sparkles, Code2 } from 'lucide-react';
import type { NodeDef } from '../types';

export const openAiNode: NodeDef = {
  type: 'n8n-nodes-base.openAi',
  label: 'OpenAI',
  category: 'ai',
  description: 'Sends a prompt to an OpenAI model and returns the completion.',
  icon: Sparkles,
  iconColor: 'bg-emerald-100 text-emerald-700',
  credentialProvider: 'openai',
  fields: [
    {
      key: 'model',
      label: 'Model',
      type: 'select',
      required: true,
      default: 'gpt-4o-mini',
      options: [
        { label: 'GPT-4o', value: 'gpt-4o' },
        { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
        { label: 'GPT-4 Turbo', value: 'gpt-4-turbo' },
        { label: 'GPT-3.5 Turbo', value: 'gpt-3.5-turbo' },
      ],
    },
    {
      key: 'prompt',
      label: 'User Prompt',
      type: 'textarea',
      required: true,
      placeholder: 'Summarise the following text: {{$node["Webhook"].json["text"]}}',
    },
    {
      key: 'systemMessage',
      label: 'System Message',
      type: 'textarea',
      placeholder: 'You are a helpful assistant.',
      description: 'Optional instruction that sets the behaviour of the model.',
    },
    {
      key: 'temperature',
      label: 'Temperature',
      type: 'number',
      default: 0.7,
      min: 0,
      max: 2,
      step: 0.1,
      description: '0 = deterministic, 2 = very creative.',
    },
    {
      key: 'maxTokens',
      label: 'Max Tokens',
      type: 'number',
      default: 1000,
      min: 1,
      max: 32000,
    },
  ],
};

export const codeNode: NodeDef = {
  type: 'n8n-nodes-base.code',
  label: 'Code',
  category: 'ai',
  description: 'Runs a custom JavaScript snippet and returns its output.',
  icon: Code2,
  iconColor: 'bg-gray-100 text-gray-700',
  // Phase 9.5.1A: arbitrary code execution is permanently disabled in live
  // mode by product policy (not safely sandboxable -- see
  // lib/workflow-runtime/node-handlers/code.ts) and is now correctly
  // blocked at the capability layer (lib/workflow-runtime/
  // node-capabilities.ts). Same "Coming Soon" treatment already used for
  // Google Drive / Gmail-watch below -- kept registered (not deleted) so
  // the concept stays visible for future product direction, but disabled
  // and explained rather than offered as if functional.
  unavailableReason: 'Custom code execution isn\'t available yet.',
  fields: [
    {
      key: 'language',
      label: 'Language',
      type: 'select',
      default: 'javaScript',
      options: [
        { label: 'JavaScript', value: 'javaScript' },
        { label: 'Python', value: 'python' },
      ],
    },
    {
      key: 'code',
      label: 'Code',
      type: 'textarea',
      required: true,
      placeholder: 'return items.map(item => ({ json: { ...item.json, processed: true } }));',
      description: 'Must return an array of items with a json property.',
    },
  ],
};
