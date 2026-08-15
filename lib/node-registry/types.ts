import type { LucideIcon } from 'lucide-react';

// ─── Field schema ─────────────────────────────────────────────────────────────

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'email'
  | 'url'
  | 'password'
  | 'select'
  | 'json';

export interface SelectOption {
  label: string;
  value: string;
}

export interface FieldSchema {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  description?: string;
  /** Only used when type === 'select' */
  options?: SelectOption[];
  /** Only used when type === 'number' */
  min?: number;
  max?: number;
  step?: number;
  default?: string | number | boolean;
}

// ─── Node definition ──────────────────────────────────────────────────────────

export type NodeCategory =
  | 'trigger'
  | 'messaging'
  | 'storage'
  | 'control'
  | 'ai'
  | 'http';

export interface NodeDef {
  /** Matches WorkflowJsonNode.type (e.g. 'n8n-nodes-base.slack') */
  type: string;
  /** Human-readable label shown in palette and panel header */
  label: string;
  /** Palette grouping category */
  category: NodeCategory;
  /** Short description shown in the settings panel */
  description: string;
  /** Lucide icon component */
  icon: LucideIcon;
  /** Tailwind bg + text classes for the icon badge */
  iconColor: string;
  /** Ordered list of configurable fields */
  fields: FieldSchema[];
  /** Whether this node can start a workflow (trigger semantics) */
  isTrigger?: boolean;
  /**
   * The credentials provider key required by this node (e.g. 'openai', 'slack').
   * When set, NodeSettingsPanel shows a CredentialPicker for this provider.
   * Maps to keys in lib/credentials/provider-registry.ts.
   */
  credentialProvider?: string;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

export interface FieldError {
  key: string;
  message: string;
}

export function validateNodeConfig(
  parameters: Record<string, unknown>,
  fields: FieldSchema[],
): FieldError[] {
  const errors: FieldError[] = [];
  for (const field of fields) {
    if (!field.required) continue;
    const val = parameters[field.key];
    if (val === undefined || val === null || String(val).trim() === '') {
      errors.push({ key: field.key, message: `${field.label} is required` });
    }
  }
  return errors;
}
