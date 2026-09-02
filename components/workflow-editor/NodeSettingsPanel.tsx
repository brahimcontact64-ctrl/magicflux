'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, AlertCircle, CheckCircle2, KeyRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { NodeTypeIcon } from '@/components/execution/NodeTypeIcon';
import { cn } from '@/lib/utils';

import { getNodeDef, validateNodeConfig } from '@/lib/node-registry';
import type { FieldError } from '@/lib/node-registry';
import { FieldInput } from './FieldInput';
import { CredentialPicker } from '@/components/credentials/CredentialPicker';
import type { WorkflowNodeData } from '@/lib/workflow-editor/types';
import type { Node } from '@xyflow/react';

// ─── Props ────────────────────────────────────────────────────────────────────

interface NodeSettingsPanelProps {
  node: Node<WorkflowNodeData>;
  onUpdate: (nodeId: string, parameters: Record<string, unknown>) => void;
  onClose: () => void;
  readOnly?: boolean;
  /**
   * Phase 9.4.2: the desktop canvas renders this as a fixed-width (18rem)
   * side panel next to the graph. The mobile step editor reuses this same
   * component unmodified inside a full-height sheet instead of forking a
   * second settings UI -- passing `fullWidth` drops the fixed width/border
   * so it fills its container there. Desktop behavior is unchanged
   * (fullWidth defaults to false).
   */
  fullWidth?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NodeSettingsPanel({
  node,
  onUpdate,
  onClose,
  readOnly,
  fullWidth,
}: NodeSettingsPanelProps) {
  const def = getNodeDef(node.data.nodeType);

  // Local parameter state — pre-filled with existing parameters.
  const [params, setParams] = useState<Record<string, unknown>>(
    () => ({ ...node.data.parameters }),
  );

  // Sync when a different node is selected or undo/redo changes data.
  const prevNodeId = useRef(node.id);
  useEffect(() => {
    if (prevNodeId.current !== node.id) {
      setParams({ ...node.data.parameters });
      prevNodeId.current = node.id;
    }
  }, [node.id, node.data.parameters]);

  // Validation
  const errors: FieldError[] = useMemo(() => {
    if (!def) return [];
    return validateNodeConfig(params, def.fields);
  }, [params, def]);

  const errorByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of errors) map.set(e.key, e.message);
    return map;
  }, [errors]);

  // Debounced upstream propagation (150 ms — same cadence as emitChange).
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>();
  const handleChange = useCallback(
    (key: string, value: string | number) => {
      setParams((prev) => {
        const next = { ...prev, [key]: value };
        clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => onUpdate(node.id, next), 150);
        return next;
      });
    },
    [node.id, onUpdate],
  );

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className={cn(
        'flex flex-col bg-card overflow-hidden',
        fullWidth ? 'w-full h-full' : 'w-72 border-l border-border flex-shrink-0',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border bg-muted/20 flex-shrink-0">
        <NodeTypeIcon nodeType={node.data.nodeType} size="sm" />
        <div className="flex-1 min-w-0">
          <p className={cn('font-semibold text-foreground truncate', fullWidth ? 'text-sm' : 'text-xs')}>{node.data.name}</p>
          <p className={cn('text-muted-foreground truncate', fullWidth ? 'text-xs' : 'text-[10px]')}>
            {def?.label ?? node.data.nodeType}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className={cn('p-0 flex-shrink-0', fullWidth ? 'h-11 w-11' : 'h-6 w-6')}
          aria-label="Close settings"
        >
          <X className={fullWidth ? 'h-5 w-5' : 'h-3.5 w-3.5'} />
        </Button>
      </div>

      {/* Validation summary */}
      {errors.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-destructive/5 border-b border-destructive/20 flex-shrink-0">
          <AlertCircle className="h-3 w-3 text-destructive flex-shrink-0" />
          <span className="text-[10px] text-destructive font-medium">
            {errors.length} required field{errors.length !== 1 ? 's' : ''} missing
          </span>
        </div>
      )}

      {/* Credential section — shown when the node requires a provider credential */}
      {def?.credentialProvider && (
        <div className="px-3 py-2 border-b border-border bg-muted/10 flex-shrink-0 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <KeyRound className="h-3 w-3" />
            Required credential
          </div>
          <CredentialPicker provider={def.credentialProvider} />
        </div>
      )}

      {/* Fields */}
      <div className="flex-1 overflow-y-auto py-2 px-3 space-y-3">
        {def ? (
          def.fields.map((field) => (
            <div key={field.key} className="space-y-1">
              {/* Label */}
              <label
                htmlFor={`field-${field.key}`}
                className={cn(
                  'block text-[11px] font-medium',
                  errorByKey.has(field.key)
                    ? 'text-destructive'
                    : 'text-foreground/80',
                )}
              >
                {field.label}
                {field.required && (
                  <span className="text-destructive ml-0.5">*</span>
                )}
              </label>

              {/* Input */}
              <FieldInput
                field={field}
                value={params[field.key]}
                onChange={handleChange}
                error={errorByKey.get(field.key)}
                readOnly={readOnly}
              />

              {/* Inline error */}
              {errorByKey.has(field.key) && (
                <p className="text-[10px] text-destructive">
                  {errorByKey.get(field.key)}
                </p>
              )}

              {/* Description (only shown if no error and description exists) */}
              {!errorByKey.has(field.key) && field.description && (
                <p className="text-[10px] text-muted-foreground">{field.description}</p>
              )}
            </div>
          ))
        ) : (
          <div className="py-4 text-center">
            <p className="text-xs text-muted-foreground">
              No configuration available for{' '}
              <span className="font-mono">{node.data.nodeType}</span>.
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-border bg-muted/10 flex-shrink-0">
        {errors.length === 0 ? (
          <div className="flex items-center gap-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            All required fields filled
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">
            Changes auto-save to the workflow.
          </p>
        )}
      </div>
    </div>
  );
}
