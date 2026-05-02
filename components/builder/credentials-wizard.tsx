'use client';

import { useState } from 'react';
import {
  Mail, MessageSquare, ShoppingBag, Phone, Database,
  Users, Zap, Globe, CircleCheck as CheckCircle2, ChevronRight,
  ExternalLink, Key, X, ChevronDown, ChevronUp
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ServiceCredential {
  id: string;
  name: string;
  icon: React.ElementType;
  color: string;
  description: string;
  fields: CredentialField[];
  docsUrl: string;
  setupSteps: string[];
}

interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'password' | 'url' | 'email';
  helpText?: string;
}

export const SERVICES: ServiceCredential[] = [
  {
    id: 'gmail',
    name: 'Gmail / SMTP',
    icon: Mail,
    color: 'text-red-400 bg-red-500/10 border-red-500/20',
    description: 'Send automated emails through Gmail or any SMTP provider',
    docsUrl: 'https://support.google.com/accounts/answer/185833',
    setupSteps: [
      'Enable 2-Step Verification on your Google account',
      'Go to Google Account → Security → App passwords',
      'Generate an App Password for "Mail"',
      'Use your Gmail address and the 16-character app password below'
    ],
    fields: [
      { key: 'smtp_user', label: 'Gmail Address', placeholder: 'you@gmail.com', type: 'email' },
      { key: 'smtp_pass', label: 'App Password', placeholder: 'xxxx xxxx xxxx xxxx', type: 'password', helpText: '16-char Google App Password, not your regular password' },
      { key: 'from_name', label: 'From Name', placeholder: 'My Business', type: 'text' }
    ]
  },
  {
    id: 'slack',
    name: 'Slack',
    icon: MessageSquare,
    color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    description: 'Send Slack messages and alerts to channels or DMs',
    docsUrl: 'https://api.slack.com/apps',
    setupSteps: [
      'Go to api.slack.com/apps and click "Create New App"',
      'Choose "From scratch" and select your workspace',
      'Under "OAuth & Permissions", add Bot Token Scopes: chat:write',
      'Install the app to your workspace and copy the Bot User OAuth Token'
    ],
    fields: [
      { key: 'bot_token', label: 'Bot Token', placeholder: 'xoxb-...', type: 'password', helpText: 'Starts with xoxb-' },
      { key: 'channel_id', label: 'Default Channel ID', placeholder: 'C0XXXXXXXXX', type: 'text', helpText: 'Right-click channel → Copy link → extract ID from URL' }
    ]
  },
  {
    id: 'shopify',
    name: 'Shopify',
    icon: ShoppingBag,
    color: 'text-green-400 bg-green-500/10 border-green-500/20',
    description: 'Connect to your Shopify store for orders, products, and webhooks',
    docsUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
    setupSteps: [
      'In Shopify Admin go to Settings → Apps and sales channels',
      'Click "Develop apps" then "Create an app"',
      'Under API credentials, configure Admin API access scopes',
      'Install the app and copy the Admin API access token'
    ],
    fields: [
      { key: 'store_url', label: 'Store URL', placeholder: 'your-store.myshopify.com', type: 'url' },
      { key: 'access_token', label: 'Admin API Token', placeholder: 'shpat_...', type: 'password' }
    ]
  },
  {
    id: 'twilio',
    name: 'Twilio SMS',
    icon: Phone,
    color: 'text-red-400 bg-red-500/10 border-red-500/20',
    description: 'Send SMS and WhatsApp messages via Twilio',
    docsUrl: 'https://console.twilio.com',
    setupSteps: [
      'Create or log in to your Twilio account at console.twilio.com',
      'Copy your Account SID and Auth Token from the dashboard',
      'Get a Twilio phone number if you don\'t have one',
      'Add the phone number in E.164 format (e.g. +15551234567)'
    ],
    fields: [
      { key: 'account_sid', label: 'Account SID', placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', type: 'text' },
      { key: 'auth_token', label: 'Auth Token', placeholder: 'your_auth_token', type: 'password' },
      { key: 'from_number', label: 'From Number', placeholder: '+15551234567', type: 'text', helpText: 'E.164 format' }
    ]
  },
  {
    id: 'airtable',
    name: 'Airtable',
    icon: Database,
    color: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
    description: 'Store and query data in Airtable bases',
    docsUrl: 'https://airtable.com/create/tokens',
    setupSteps: [
      'Go to airtable.com/create/tokens and click "Create token"',
      'Give it a name and select scopes: data.records:read, data.records:write',
      'Add your base(s) under "Access"',
      'Copy the token (starts with pat)'
    ],
    fields: [
      { key: 'api_key', label: 'Personal Access Token', placeholder: 'patXXXXXXXXXXXXXX', type: 'password', helpText: 'Starts with "pat"' },
      { key: 'base_id', label: 'Base ID', placeholder: 'appXXXXXXXXXXXXXX', type: 'text', helpText: 'From your Airtable URL: airtable.com/{BASE_ID}/...' }
    ]
  },
  {
    id: 'n8n',
    name: 'n8n Instance',
    icon: Zap,
    color: 'text-primary bg-primary/10 border-primary/20',
    description: 'Connect your n8n instance for direct workflow deployment',
    docsUrl: 'https://docs.n8n.io/api/',
    setupSteps: [
      'Log in to your n8n instance (cloud or self-hosted)',
      'Go to Settings → API → Create an API key',
      'Copy the API key and your instance URL',
      'Ensure your instance is publicly accessible if self-hosted'
    ],
    fields: [
      { key: 'instance_url', label: 'Instance URL', placeholder: 'https://your-n8n.app.n8n.cloud', type: 'url' },
      { key: 'api_key', label: 'API Key', placeholder: 'n8n_api_...', type: 'password' }
    ]
  },
  {
    id: 'webhook',
    name: 'Webhook URL',
    icon: Globe,
    color: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
    description: 'Configure webhook endpoints for triggering automations',
    docsUrl: 'https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/',
    setupSteps: [
      'Deploy your n8n workflow with a Webhook node',
      'Click "Listen for Test Event" in n8n to get the webhook URL',
      'For production, use the Production URL (toggle in webhook node)',
      'Paste the full webhook URL below'
    ],
    fields: [
      { key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://your-n8n.com/webhook/xxxxx', type: 'url' }
    ]
  }
];

interface ServiceCardProps {
  service: ServiceCredential;
  isConfigured: boolean;
  onConfigure: (id: string) => void;
}

function ServiceCard({ service, isConfigured, onConfigure }: ServiceCardProps) {
  const Icon = service.icon;
  return (
    <button
      onClick={() => onConfigure(service.id)}
      className={cn(
        'w-full rounded-xl border p-4 flex items-center gap-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:shadow-black/10',
        isConfigured
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : 'border-border bg-card hover:border-primary/30'
      )}
    >
      <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center flex-shrink-0', service.color)}>
        <Icon className="w-4.5 h-4.5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{service.name}</p>
        <p className="text-xs text-muted-foreground truncate">{service.description}</p>
      </div>
      {isConfigured ? (
        <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
      ) : (
        <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      )}
    </button>
  );
}

interface SetupPanelProps {
  service: ServiceCredential;
  values: Record<string, string>;
  onChange: (key: string, val: string) => void;
  onSave: () => void;
  onClose: () => void;
}

function SetupPanel({ service, values, onChange, onSave, onClose }: SetupPanelProps) {
  const [showSteps, setShowSteps] = useState(true);
  const Icon = service.icon;
  const allFilled = service.fields.every(f => values[f.key]?.trim());

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/20">
        <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0', service.color)}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold">{service.name} Setup</p>
          <p className="text-xs text-muted-foreground">{service.description}</p>
        </div>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-muted/50 text-muted-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Setup steps collapsible */}
        <div className="rounded-lg border border-border bg-muted/20 overflow-hidden">
          <button
            onClick={() => setShowSteps(!showSteps)}
            className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-medium text-left"
          >
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Key className="w-3 h-3" />
              How to get credentials
            </span>
            {showSteps ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>
          {showSteps && (
            <div className="px-3 pb-3 space-y-1.5">
              {service.setupSteps.map((step, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <span className="flex-shrink-0 w-4 h-4 rounded-full border border-border flex items-center justify-center text-[10px] font-medium mt-0.5">
                    {i + 1}
                  </span>
                  <span className="leading-relaxed">{step}</span>
                </div>
              ))}
              <a
                href={service.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-primary hover:underline mt-2"
              >
                <ExternalLink className="w-3 h-3" />
                Official docs
              </a>
            </div>
          )}
        </div>

        {/* Fields */}
        <div className="space-y-3">
          {service.fields.map(field => (
            <div key={field.key}>
              <label className="block text-xs font-medium mb-1.5 text-foreground">
                {field.label}
              </label>
              <input
                type={field.type === 'password' ? 'password' : 'text'}
                placeholder={field.placeholder}
                value={values[field.key] || ''}
                onChange={e => onChange(field.key, e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background focus:outline-none focus:border-primary transition-colors font-mono"
              />
              {field.helpText && (
                <p className="text-xs text-muted-foreground mt-1">{field.helpText}</p>
              )}
            </div>
          ))}
        </div>

        {/* Save */}
        <Button
          onClick={onSave}
          disabled={!allFilled}
          className="w-full gap-2 h-9 text-sm font-medium"
        >
          <CheckCircle2 className="w-4 h-4" />
          Mark as Configured
        </Button>
        <p className="text-xs text-muted-foreground text-center">
          Credentials are stored locally in your browser session only.
          For production, add them directly to your n8n instance.
        </p>
      </div>
    </div>
  );
}

interface CredentialsWizardProps {
  requiredServices?: string[];
  onComplete?: (configured: string[]) => void;
  className?: string;
}

export function CredentialsWizard({ requiredServices, onComplete, className }: CredentialsWizardProps) {
  const visibleServices = requiredServices
    ? SERVICES.filter(s => requiredServices.includes(s.id))
    : SERVICES;

  const [configuredIds, setConfiguredIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, Record<string, string>>>({});

  const activeService = SERVICES.find(s => s.id === activeId);

  function handleFieldChange(serviceId: string, key: string, val: string) {
    setFieldValues(prev => ({
      ...prev,
      [serviceId]: { ...(prev[serviceId] || {}), [key]: val }
    }));
  }

  function handleSave(serviceId: string) {
    setConfiguredIds(prev => {
      const next = new Set(prev);
      next.add(serviceId);
      if (onComplete) onComplete(Array.from(next));
      return next;
    });
    setActiveId(null);
  }

  const configuredCount = configuredIds.size;
  const totalRequired = visibleServices.length;

  return (
    <div className={cn('space-y-4', className)}>
      {/* Progress header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">Integration Setup</p>
          <p className="text-xs text-muted-foreground">{configuredCount} of {totalRequired} configured</p>
        </div>
        <div className="flex items-center gap-1">
          {visibleServices.map(s => (
            <div
              key={s.id}
              className={cn(
                'w-1.5 h-1.5 rounded-full transition-colors',
                configuredIds.has(s.id) ? 'bg-emerald-400' : 'bg-border'
              )}
            />
          ))}
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full h-1 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-emerald-400 rounded-full transition-all duration-500"
          style={{ width: totalRequired ? `${(configuredCount / totalRequired) * 100}%` : '0%' }}
        />
      </div>

      {/* Active setup panel */}
      {activeService && (
        <SetupPanel
          service={activeService}
          values={fieldValues[activeService.id] || {}}
          onChange={(key, val) => handleFieldChange(activeService.id, key, val)}
          onSave={() => handleSave(activeService.id)}
          onClose={() => setActiveId(null)}
        />
      )}

      {/* Service list */}
      {!activeId && (
        <div className="space-y-2">
          {visibleServices.map(service => (
            <ServiceCard
              key={service.id}
              service={service}
              isConfigured={configuredIds.has(service.id)}
              onConfigure={setActiveId}
            />
          ))}
        </div>
      )}

      {configuredCount === totalRequired && totalRequired > 0 && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex items-center gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <p className="text-xs text-emerald-400 font-medium">
            All integrations configured. Ready to deploy your workflow.
          </p>
        </div>
      )}
    </div>
  );
}
