import { Mail, MessageSquare } from 'lucide-react';
import type { NodeDef } from '../types';

export const emailNode: NodeDef = {
  type: 'n8n-nodes-base.emailSend',
  label: 'Email Send',
  category: 'messaging',
  description: 'Sends an email via SMTP.',
  icon: Mail,
  iconColor: 'bg-blue-100 text-blue-700',
  credentialProvider: 'gmail',
  fields: [
    {
      key: 'to',
      label: 'Recipient',
      type: 'email',
      required: true,
      placeholder: 'recipient@example.com',
    },
    {
      key: 'subject',
      label: 'Subject',
      type: 'text',
      required: true,
      placeholder: 'Hello from MagicFlux',
    },
    {
      key: 'body',
      label: 'Body',
      type: 'textarea',
      required: true,
      placeholder: 'Email body content…',
    },
    {
      key: 'from',
      label: 'From',
      type: 'email',
      placeholder: 'noreply@example.com',
      description: 'Overrides the default sender address.',
    },
    {
      key: 'cc',
      label: 'CC',
      type: 'email',
      placeholder: 'cc@example.com',
    },
  ],
};

export const slackNode: NodeDef = {
  type: 'n8n-nodes-base.slack',
  label: 'Slack',
  category: 'messaging',
  description: 'Sends a message to a Slack channel or user.',
  icon: MessageSquare,
  iconColor: 'bg-purple-100 text-purple-700',
  credentialProvider: 'slack',
  fields: [
    {
      key: 'channel',
      label: 'Channel',
      type: 'text',
      required: true,
      placeholder: '#general',
      description: 'Channel name (with #) or user ID to message.',
    },
    {
      key: 'message',
      label: 'Message',
      type: 'textarea',
      required: true,
      placeholder: 'Hello from MagicFlux!',
    },
    {
      key: 'username',
      label: 'Bot Username',
      type: 'text',
      placeholder: 'MagicFlux Bot',
      description: 'Display name for the bot.',
    },
    {
      key: 'iconEmoji',
      label: 'Icon Emoji',
      type: 'text',
      placeholder: ':robot_face:',
    },
  ],
};
