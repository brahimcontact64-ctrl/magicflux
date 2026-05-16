/**
 * Intent Validator
 *
 * Enforces that a user prompt contains a real automation intent
 * before the planner is allowed to generate a workflow.
 *
 * A valid intent MUST have:
 *   - A trigger signal (when / if / every / schedule / on event)
 *   - An action signal (send / save / notify / create / log / report)
 *
 * OR at minimum a service reference (shopify/slack/airtable/email)
 * combined with any single action or trigger word.
 *
 * Single words, names, greetings, random text → INVALID.
 */

import type { IntegrationProvider } from '@/lib/integrations';

export type MissingIntentPart = 'trigger' | 'action' | 'data';

export type IntentValidation = {
  valid: boolean;
  reason: string;
  confidence: number;
};

export type StrictIntentAssessment = {
  valid: boolean;
  confidence: number;
  triggerDetected: boolean;
  actionDetected: boolean;
  dataDetected: boolean;
  missing: MissingIntentPart[];
  providers: IntegrationProvider[];
  unsupportedProviders: string[];
};

// Explicit trigger keywords — indicate WHEN something starts
const TRIGGER_PATTERNS = [
  'webhook',
  'when ', "when's", 'whenever',
  'if ', 'every ', 'each ',
  'on ', 'once ',
  'schedule', 'scheduled',
  'daily', 'weekly', 'monthly', 'hourly',
  'at 9', 'at 8', 'at 10', 'at noon', 'at midnight',
  'each morning', 'each day', 'each week',
  'every morning', 'every day', 'every week', 'every hour',
  'after ', 'upon ',
  'trigger',
  'new order', 'new customer', 'new lead', 'new message', 'new email',
  'order is', 'order created', 'form submitted', 'form is submitted',
  'receive', 'received', 'incoming',
  '9am', '10am', '8am',
];

// Action keywords — indicate WHAT should happen
const ACTION_PATTERNS = [
  'send', 'sends', 'sending',
  'save', 'saves', 'saving',
  'notify', 'notif',
  'create', 'creates',
  'log', 'logs', 'logging',
  'update', 'updates',
  'post', 'posts',
  'forward', 'forwards',
  'store', 'stores',
  'record', 'records',
  'message', 'messages',
  'alert', 'alerts',
  'report', 'reports',
  'email', 'emails',
  'slack', // having slack is always an action/service intent
  'airtable', // having airtable is always an action/service intent
  'shopify', // having shopify is always a service intent
  'http request',
  'summarize', 'summary',
  'generate report', 'send report',
  'push', 'sync',
  'broadcast',
  'add to', 'write to',
];

const DATA_PATTERNS = [
  'order', 'orders',
  'email', 'emails',
  'message', 'messages',
  'report', 'reports',
  'lead', 'leads',
  'ticket', 'tickets',
  'form', 'forms',
  'request', 'requests',
  'submission', 'submissions',
  'record', 'records',
  'customer', 'customers',
  'event', 'events',
  'payload',
  'summary',
];

// Known service keywords — having two of these implies a real integration
const SERVICE_KEYWORDS = [
  'shopify', 'slack', 'airtable', 'email', 'gmail', 'smtp',
  'webhook', 'http', 'twilio', 'sms', 'whatsapp',
  'google sheets', 'sheets', 'hubspot', 'crm',
];

const SUPPORTED_PROVIDERS: IntegrationProvider[] = ['shopify', 'slack', 'airtable', 'email'];

const UNSUPPORTED_PROVIDER_SIGNALS: Array<{ provider: string; signals: string[] }> = [
  { provider: 'twilio', signals: ['twilio', 'sms', 'whatsapp'] },
  { provider: 'hubspot', signals: ['hubspot'] },
  { provider: 'google_sheets', signals: ['google sheets', 'spreadsheet'] },
  { provider: 'stripe', signals: ['stripe', 'payment'] },
];

// Words that indicate human names, greetings, gibberish, one-word commands
const NOISE_ONLY_WORDS = new Set([
  'hi', 'hello', 'hey', 'yo', 'ok', 'okay', 'sure', 'yes', 'no', 'maybe',
  'test', 'testing', 'check', 'try', 'run', 'go', 'start', 'begin', 'debug',
  'fix', 'make', 'do', 'just', 'help', 'pls', 'please', 'thanks', 'thank',
  'workflow', 'automation', 'automate', 'flow', 'build', 'create',
  'example', 'demo', 'dummy',
  'nothing', 'random', 'anything', 'something',
  // Common first names (non-exhaustive but covers most obvious cases)
  'brahim', 'ali', 'john', 'jane', 'bob', 'alice', 'mike', 'sarah',
  'david', 'max', 'alex', 'tom', 'sam', 'joe', 'kevin', 'adam', 'chris',
  'jessica', 'emily', 'daniel', 'noah',
]);

export const CLARIFICATION_EXAMPLES = [
  'When I receive an email, send a Slack message',
  'When a Shopify order is created, save it in Airtable',
  'Every morning at 9am, send a summary email',
];

export function validatePromptIntent(prompt: string): IntentValidation {
  const strict = assessPromptIntent(prompt);
  if (!strict.valid) {
    if (strict.missing.length > 0) {
      return {
        valid: false,
        reason: `Missing: ${strict.missing.join(', ')}.`,
        confidence: strict.confidence,
      };
    }
    if (strict.unsupportedProviders.length > 0) {
      return {
        valid: false,
        reason: 'Unsupported services requested.',
        confidence: strict.confidence,
      };
    }
    return {
      valid: false,
      reason: 'Prompt is ambiguous. Please clarify trigger and action.',
      confidence: strict.confidence,
    };
  }

  return { valid: true, reason: '', confidence: strict.confidence };
}

function detectSupportedProviders(lower: string): IntegrationProvider[] {
  const providers: IntegrationProvider[] = [];
  if (lower.includes('shopify')) providers.push('shopify');
  if (lower.includes('slack')) providers.push('slack');
  if (lower.includes('airtable')) providers.push('airtable');
  if (lower.includes('email') || lower.includes('gmail') || lower.includes('smtp')) providers.push('email');
  return providers;
}

function detectUnsupportedProviders(lower: string): string[] {
  return UNSUPPORTED_PROVIDER_SIGNALS
    .filter((entry) => entry.signals.some((signal) => lower.includes(signal)))
    .map((entry) => entry.provider);
}

export function assessPromptIntent(prompt: string): StrictIntentAssessment {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);

  const meaningfulWords = words.filter((w) => !NOISE_ONLY_WORDS.has(w));
  const hasServiceKeyword = SERVICE_KEYWORDS.some((s) => lower.includes(s));
  const noiseRatio = words.length > 0 ? (words.length - meaningfulWords.length) / words.length : 1;

  const triggerDetected = TRIGGER_PATTERNS.some((p) => lower.includes(p));
  const actionDetected = ACTION_PATTERNS.some((p) => lower.includes(p));
  const dataDetected = DATA_PATTERNS.some((p) => lower.includes(p));

  const providers = detectSupportedProviders(lower);
  const unsupportedProviders = detectUnsupportedProviders(lower);

  const missing: MissingIntentPart[] = [];
  if (!triggerDetected) missing.push('trigger');
  if (!actionDetected) missing.push('action');
  if (triggerDetected && actionDetected && !dataDetected) missing.push('data');

  const vaguePrompt =
    !triggerDetected &&
    !actionDetected &&
    providers.length === 0 &&
    (meaningfulWords.length <= 2 || noiseRatio > 0.5);
  if (vaguePrompt) {
    // Treat generic text as ambiguity, not structured incompleteness.
    missing.length = 0;
  }

  let confidence = 52;
  if (triggerDetected) confidence += 18;
  if (actionDetected) confidence += 14;
  if (dataDetected) confidence += 10;
  if (providers.length >= 1) confidence += 6;
  if (providers.length >= 2) confidence += 6;
  if (words.length >= 6) confidence += 5;
  if (words.length >= 10) confidence += 4;
  if (noiseRatio > 0.5 && !hasServiceKeyword) confidence -= 35;
  if (meaningfulWords.length === 0) confidence = 0;
  if (words.length < 2) confidence = 0;
  confidence = Math.max(0, Math.min(95, confidence));

  const hasIncompleteIntent = missing.length > 0;
  const hasUnsupported = unsupportedProviders.length > 0;
  const valid = !hasIncompleteIntent && !hasUnsupported && confidence >= 85;

  return {
    valid,
    confidence,
    triggerDetected,
    actionDetected,
    dataDetected,
    missing,
    providers: providers.filter((p) => SUPPORTED_PROVIDERS.includes(p)),
    unsupportedProviders,
  };
}

export type ClarificationRequiredError = {
  code: 'CLARIFICATION_REQUIRED';
  mode: 'clarification';
  message: string;
  questions: string[];
  examples: string[];
  suggestions: string[];
  missing?: MissingIntentPart[];
};

export type IncompleteIntentError = {
  error: 'INCOMPLETE_INTENT';
  message: string;
  missing: MissingIntentPart[];
  suggestions: string[];
};

export type UnsupportedRequirementsError = {
  error: 'UNSUPPORTED_REQUIREMENTS';
  message: string;
  unsupported: string[];
};

export function buildIncompleteIntentError(missing: MissingIntentPart[]): IncompleteIntentError {
  return {
    error: 'INCOMPLETE_INTENT',
    message: 'Your request is missing required parts.',
    missing,
    suggestions: CLARIFICATION_EXAMPLES,
  };
}

export function buildUnsupportedRequirementsError(unsupported: string[]): UnsupportedRequirementsError {
  return {
    error: 'UNSUPPORTED_REQUIREMENTS',
    message: 'This automation cannot be built with current capabilities.',
    unsupported,
  };
}

export function buildClarificationError(): ClarificationRequiredError {
  const questions = [
    'What should trigger this automation?',
    'What action should happen after the trigger?',
    'What data should be used or processed?',
  ];

  return {
    code: 'CLARIFICATION_REQUIRED',
    mode: 'clarification',
    message:
      'Please describe what should trigger the automation and what action should happen.',
    questions,
    examples: CLARIFICATION_EXAMPLES,
    suggestions: CLARIFICATION_EXAMPLES,
  };
}

export function buildClarificationFromMissing(missing: MissingIntentPart[]): ClarificationRequiredError {
  const questionMap: Record<MissingIntentPart, string> = {
    trigger: 'When should this automation run? (for example: when a new order arrives, every morning at 9am)',
    action: 'What should the automation do? (for example: send Slack message, send email, save to Airtable)',
    data: 'Which data should it use? (for example: order details, customer email, report summary)',
  };

  const questions = missing.map((part) => questionMap[part]);

  return {
    code: 'CLARIFICATION_REQUIRED',
    mode: 'clarification',
    message: 'I need a few details before I can build this automation.',
    questions,
    examples: CLARIFICATION_EXAMPLES,
    suggestions: CLARIFICATION_EXAMPLES,
    missing,
  };
}
