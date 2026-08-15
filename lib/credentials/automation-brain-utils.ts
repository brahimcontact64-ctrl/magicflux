/**
 * Pure, non-React helpers for the Automation Brain UI.
 * Imported by both components and test scripts.
 */

import type { IntegrationStatus } from './intelligence';

export const DEBOUNCE_MS = 500;

export type StatusConfig = {
  label: string;
  /** Tailwind text colour classes */
  colorClass: string;
  /** Tailwind background colour classes */
  bgClass: string;
  /** Tailwind border colour classes */
  borderClass: string;
  /** Logical icon name — components resolve to the actual lucide icon */
  iconName: 'check-circle' | 'alert-triangle' | 'x-circle' | 'link';
};

export const STATUS_CONFIG: Record<IntegrationStatus, StatusConfig> = {
  ready: {
    label: 'Ready',
    colorClass: 'text-emerald-600 dark:text-emerald-400',
    bgClass: 'bg-emerald-500/10',
    borderClass: 'border-emerald-500/30',
    iconName: 'check-circle',
  },
  missing: {
    label: 'Missing credentials',
    colorClass: 'text-amber-600 dark:text-amber-400',
    bgClass: 'bg-amber-500/10',
    borderClass: 'border-amber-500/30',
    iconName: 'alert-triangle',
  },
  invalid: {
    label: 'Invalid',
    colorClass: 'text-red-600 dark:text-red-400',
    bgClass: 'bg-red-500/10',
    borderClass: 'border-red-500/30',
    iconName: 'x-circle',
  },
  oauth_required: {
    label: 'OAuth required',
    colorClass: 'text-blue-600 dark:text-blue-400',
    bgClass: 'bg-blue-500/10',
    borderClass: 'border-blue-500/30',
    iconName: 'link',
  },
};

export function getStatusConfig(status: IntegrationStatus): StatusConfig {
  return STATUS_CONFIG[status];
}

/**
 * Returns true when every field in the list has source === 'oauth',
 * meaning no form inputs are needed — only an OAuth redirect button.
 */
export function isOAuthOnlyProvider(
  fields: ReadonlyArray<{ source: string }>
): boolean {
  return fields.length > 0 && fields.every((f) => f.source === 'oauth');
}

/** Label for the primary action button based on integration status. */
export function getConnectButtonLabel(status: IntegrationStatus): string {
  if (status === 'oauth_required') return 'Connect with OAuth';
  if (status === 'invalid') return 'Reconnect';
  return 'Connect';
}

/** Whether to show a connect / reconnect button for this status. */
export function shouldShowConnectButton(status: IntegrationStatus): boolean {
  return status !== 'ready';
}

/**
 * Returns true when all required fields have a non-empty trimmed value.
 * Optional fields do not block submission.
 */
export function canSubmitForm(
  fields: ReadonlyArray<{ key: string; required: boolean }>,
  values: Record<string, string>
): boolean {
  return fields
    .filter((f) => f.required)
    .every((f) => (values[f.key] ?? '').trim().length > 0);
}
