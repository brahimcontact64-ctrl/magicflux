'use client';

import { cn } from '@/lib/utils';
import type { FieldSchema } from '@/lib/node-registry/types';

interface FieldInputProps {
  field: FieldSchema;
  value: unknown;
  onChange: (key: string, value: string | number) => void;
  error?: string;
  readOnly?: boolean;
}

const INPUT_BASE =
  'w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs ' +
  'text-foreground placeholder:text-muted-foreground ' +
  'focus:outline-none focus:ring-1 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50 ' +
  'transition-colors';

const ERROR_INPUT = 'border-destructive focus:ring-destructive/40';

export function FieldInput({ field, value, onChange, error, readOnly }: FieldInputProps) {
  const strVal = value === undefined || value === null ? '' : String(value);
  const hasError = !!error;

  if (field.type === 'select') {
    return (
      <select
        id={`field-${field.key}`}
        value={strVal || String(field.default ?? '')}
        onChange={(e) => onChange(field.key, e.target.value)}
        disabled={readOnly}
        className={cn(
          INPUT_BASE,
          'h-8',
          hasError && ERROR_INPUT,
        )}
      >
        {(field.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'textarea' || field.type === 'json') {
    return (
      <textarea
        id={`field-${field.key}`}
        value={strVal}
        placeholder={field.placeholder}
        onChange={(e) => onChange(field.key, e.target.value)}
        disabled={readOnly}
        rows={field.type === 'json' ? 4 : 3}
        className={cn(
          INPUT_BASE,
          'resize-y min-h-[64px] font-mono text-[11px]',
          hasError && ERROR_INPUT,
        )}
        spellCheck={false}
      />
    );
  }

  if (field.type === 'number') {
    return (
      <input
        id={`field-${field.key}`}
        type="number"
        value={strVal || String(field.default ?? '')}
        min={field.min}
        max={field.max}
        step={field.step ?? 1}
        placeholder={field.placeholder}
        onChange={(e) => onChange(field.key, e.target.valueAsNumber)}
        disabled={readOnly}
        className={cn(INPUT_BASE, 'h-8', hasError && ERROR_INPUT)}
      />
    );
  }

  // text | email | url | password
  return (
    <input
      id={`field-${field.key}`}
      type={field.type}
      value={strVal}
      placeholder={field.placeholder}
      onChange={(e) => onChange(field.key, e.target.value)}
      disabled={readOnly}
      className={cn(INPUT_BASE, 'h-8', hasError && ERROR_INPUT)}
    />
  );
}
