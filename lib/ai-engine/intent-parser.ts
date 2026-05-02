import { ParsedIntent, ModificationType } from './types';
import { Industry } from '../templates';

const INDUSTRY_SIGNALS: Record<Industry, string[]> = {
  'property-management': [
    'property', 'tenant', 'landlord', 'apartment', 'building', 'unit', 'lease',
    'rent', 'maintenance', 'leasing', 'property manager', 'facility', 'repair'
  ],
  'airbnb': [
    'airbnb', 'short-term', 'vacation', 'guest', 'host', 'rental', 'vrbo',
    'listing', 'checkout', 'check-in', 'cleaning', 'turnover', 'booking'
  ],
  'shopify': [
    'shopify', 'store', 'ecommerce', 'e-commerce', 'shop', 'order', 'product',
    'customer', 'cart', 'abandoned', 'fulfillment', 'refund', 'return', 'shipping'
  ]
};

const MODIFICATION_PATTERNS: Record<ModificationType, string[]> = {
  add_slack: ['slack', 'slack notification', 'slack message', 'slack alert'],
  add_sms: ['sms', 'text message', 'twilio', 'whatsapp', 'phone notification'],
  add_email: ['add email', 'email notification', 'switch to email', 'email instead'],
  add_approval: ['approval', 'approve', 'approval step', 'manager approval', 'review step'],
  add_delay: ['delay', 'wait', 'pause', 'timer', 'after x hours', 'after x minutes'],
  add_sheets: ['google sheets', 'spreadsheet', 'sheets', 'excel', 'log to sheets'],
  add_webhook: ['webhook', 'add trigger', 'http trigger', 'api trigger'],
  switch_channel: ['switch to', 'use instead', 'replace with', 'change to'],
  add_error_handling: ['error handling', 'error notification', 'on failure', 'catch error'],
  generic: ['add', 'include', 'also', 'additionally', 'plus', 'with']
};

const MODIFICATION_TRIGGERS = [
  'add ', 'remove ', 'switch ', 'change ', 'update ', 'include ', 'also ',
  'instead of', 'replace', 'modify', 'customize', 'adjust', 'use '
];

export function parseIntent(prompt: string): ParsedIntent {
  const normalized = prompt.toLowerCase().trim();
  const words = normalized.split(/\s+/);

  const industry = detectIndustry(normalized);
  const isModification = detectIsModification(normalized);
  const action = detectAction(normalized, isModification);
  const modificationType = isModification ? detectModificationType(normalized) : null;
  const integrationsRequested = detectIntegrations(normalized);
  const triggersRequested = detectTriggers(normalized);
  const confidence = computeIntentConfidence(normalized, industry, isModification);

  return {
    rawPrompt: prompt,
    action,
    industry,
    keywords: words.filter(w => w.length > 3),
    integrationsRequested,
    triggersRequested,
    modificationType,
    isModification,
    confidence
  };
}

function detectIndustry(prompt: string): Industry | null {
  const scores: Record<Industry, number> = {
    'property-management': 0,
    'airbnb': 0,
    'shopify': 0
  };

  for (const [industry, signals] of Object.entries(INDUSTRY_SIGNALS) as [Industry, string[]][]) {
    for (const signal of signals) {
      if (prompt.includes(signal)) {
        scores[industry] += signal.split(' ').length > 1 ? 3 : 1;
      }
    }
  }

  const topIndustry = (Object.entries(scores) as [Industry, number][])
    .sort((a, b) => b[1] - a[1])[0];

  return topIndustry[1] > 0 ? topIndustry[0] : null;
}

function detectIsModification(prompt: string): boolean {
  return MODIFICATION_TRIGGERS.some(trigger => prompt.includes(trigger));
}

function detectAction(
  prompt: string,
  isModification: boolean
): ParsedIntent['action'] {
  if (isModification) {
    if (prompt.startsWith('add ') || prompt.includes('include ')) return 'add';
    if (prompt.includes('remove ') || prompt.includes('delete ')) return 'remove';
    if (prompt.includes('switch') || prompt.includes('change') || prompt.includes('replace')) return 'switch';
    return 'customize';
  }
  return 'build';
}

function detectModificationType(prompt: string): ModificationType {
  for (const [type, patterns] of Object.entries(MODIFICATION_PATTERNS) as [ModificationType, string[]][]) {
    if (patterns.some(p => prompt.includes(p))) {
      return type;
    }
  }
  return 'generic';
}

function detectIntegrations(prompt: string): string[] {
  const integrations: Record<string, string[]> = {
    'email': ['email', 'gmail', 'smtp', 'sendgrid', 'mailgun'],
    'slack': ['slack'],
    'airtable': ['airtable'],
    'hubspot': ['hubspot', 'crm'],
    'shopify': ['shopify'],
    'twilio': ['twilio', 'sms', 'whatsapp'],
    'google_sheets': ['google sheets', 'sheets', 'spreadsheet'],
    'google_calendar': ['google calendar', 'calendar'],
    'notion': ['notion'],
    'zapier': ['zapier']
  };

  return Object.entries(integrations)
    .filter(([, patterns]) => patterns.some(p => prompt.includes(p)))
    .map(([name]) => name);
}

function detectTriggers(prompt: string): string[] {
  const triggers: Record<string, string[]> = {
    'webhook': ['webhook', 'form submission', 'api call', 'http request'],
    'schedule': ['daily', 'weekly', 'monthly', 'every day', 'cron', 'scheduled', 'automatically'],
    'email': ['email received', 'incoming email', 'when email'],
    'shopify_event': ['new order', 'checkout', 'cart abandoned', 'return request']
  };

  return Object.entries(triggers)
    .filter(([, patterns]) => patterns.some(p => prompt.includes(p)))
    .map(([name]) => name);
}

function computeIntentConfidence(
  prompt: string,
  industry: Industry | null,
  isModification: boolean
): number {
  let score = 50;
  if (industry) score += 20;
  if (prompt.length > 20) score += 10;
  if (prompt.length > 50) score += 5;
  if (isModification) score += 10;
  const integrations = detectIntegrations(prompt);
  score += integrations.length * 5;
  return Math.min(98, score);
}
