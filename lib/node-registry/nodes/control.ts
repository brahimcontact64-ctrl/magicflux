import { GitBranch, Clock } from 'lucide-react';
import type { NodeDef } from '../types';

export const conditionNode: NodeDef = {
  type: 'n8n-nodes-base.if',
  label: 'Condition (IF)',
  category: 'control',
  description: 'Routes execution to a true or false branch based on a condition.',
  icon: GitBranch,
  iconColor: 'bg-violet-100 text-violet-700',
  fields: [
    {
      key: 'field',
      label: 'Field / Expression',
      type: 'text',
      required: true,
      placeholder: '{{$node["Webhook"].json["status"]}}',
      description: 'The value or expression to evaluate.',
    },
    {
      key: 'operation',
      label: 'Comparison',
      type: 'select',
      required: true,
      default: 'equals',
      options: [
        { label: 'equals', value: 'equals' },
        { label: 'not equals', value: 'notEquals' },
        { label: 'contains', value: 'contains' },
        { label: 'does not contain', value: 'notContains' },
        { label: 'greater than', value: 'greaterThan' },
        { label: 'less than', value: 'lessThan' },
        { label: 'is empty', value: 'isEmpty' },
        { label: 'is not empty', value: 'isNotEmpty' },
      ],
    },
    {
      key: 'value',
      label: 'Value',
      type: 'text',
      placeholder: 'active',
      description: 'Value to compare against. Not required for isEmpty / isNotEmpty.',
    },
  ],
};

export const waitNode: NodeDef = {
  type: 'n8n-nodes-base.wait',
  label: 'Wait',
  category: 'control',
  description: 'Pauses workflow execution for a fixed duration.',
  icon: Clock,
  iconColor: 'bg-gray-100 text-gray-700',
  fields: [
    {
      key: 'amount',
      label: 'Amount',
      type: 'number',
      required: true,
      default: 1,
      min: 1,
      description: 'How long to wait.',
    },
    {
      key: 'unit',
      label: 'Unit',
      type: 'select',
      required: true,
      default: 'minutes',
      options: [
        { label: 'Seconds', value: 'seconds' },
        { label: 'Minutes', value: 'minutes' },
        { label: 'Hours', value: 'hours' },
        { label: 'Days', value: 'days' },
      ],
    },
  ],
};
