'use client';

import { useMemo, useState } from 'react';
import type { Node, Edge } from '@xyflow/react';
import { AlertCircle, CheckCircle2, ChevronRight, KeyRound, Plus, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { NodeTypeIcon } from '@/components/execution/NodeTypeIcon';
import { cn } from '@/lib/utils';
import { getNodeDef, validateNodeConfig } from '@/lib/node-registry';
import { computeMobileOrder, type MobileOrderEntry } from '@/lib/workflow-editor/mobile-order';
import type { WorkflowNodeData } from '@/lib/workflow-editor/types';
import { NodeSettingsPanel } from './NodeSettingsPanel';
import { NodePalette } from './NodePalette';

/**
 * Phase 9.4.2 — mobile-first workflow editing surface.
 *
 * Operates on the exact same React Flow nodes/edges state
 * WorkflowEditorInner already owns (no forked persistence/business logic):
 * steps render in graph order (lib/workflow-editor/mobile-order.ts, a pure
 * read-only derivation), branches render as labelled Yes/No sections
 * mapped straight from the same connections, and every mutation
 * (add/remove/configure) goes through the identical callbacks the desktop
 * canvas uses -- onAddNode/onDeleteNode/onUpdateNodeParameters -- so a
 * workflow edited on a phone and reopened on desktop (or vice versa) is
 * indistinguishable from one only ever touched on one device.
 *
 * No drag-and-drop anywhere in this component. Reordering steps by
 * dragging is intentionally not offered here even on desktop it only
 * repositions a node visually and never changes execution order (order is
 * graph-derived, not array-index-derived) -- there is nothing to
 * replicate.
 */

interface MobileStepEditorProps {
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
  onAddNode: (type: string, label: string) => void;
  onDeleteNode: (id: string) => void;
  onUpdateNodeParameters: (id: string, parameters: Record<string, unknown>) => void;
  readOnly?: boolean;
}

function useNodeValidation(node: Node<WorkflowNodeData>) {
  const def = getNodeDef(node.data.nodeType);
  return useMemo(() => {
    if (!def) return { errors: [], def };
    return { errors: validateNodeConfig(node.data.parameters ?? {}, def.fields), def };
  }, [def, node.data.parameters]);
}

function StepCard({
  node,
  onOpen,
  onDelete,
  readOnly,
}: {
  node: Node<WorkflowNodeData>;
  onOpen: () => void;
  onDelete: () => void;
  readOnly?: boolean;
}) {
  const { errors, def } = useNodeValidation(node);
  const hasErrors = errors.length > 0;

  return (
    <div className="flex items-stretch rounded-xl border border-border bg-card overflow-hidden">
      <button
        onClick={onOpen}
        className="flex-1 min-w-0 flex items-center gap-3 px-3 py-3 text-left active:bg-muted/40 transition-colors"
        aria-label={`Configure ${node.data.name}`}
      >
        <NodeTypeIcon nodeType={node.data.nodeType} size="sm" className="flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{node.data.name}</p>
          <p className="text-xs text-muted-foreground truncate">
            {def?.label ?? node.data.nodeType}
            {def?.description ? ` · ${def.description}` : ''}
          </p>
        </div>
        {def?.credentialProvider && (
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" aria-hidden="true" />
        )}
        {hasErrors ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-destructive flex-shrink-0">
            <AlertCircle className="h-3.5 w-3.5" />
            {errors.length}
          </span>
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" aria-hidden="true" />
        )}
        <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
      </button>
      {!readOnly && (
        <button
          onClick={onDelete}
          aria-label={`Delete ${node.data.name}`}
          className="flex-shrink-0 w-11 flex items-center justify-center border-l border-border text-muted-foreground hover:text-destructive hover:bg-destructive/5 active:bg-destructive/10 transition-colors"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function BranchLabel({ label }: { label: string }) {
  const isYes = label.toLowerCase() === 'yes';
  const isNo = label.toLowerCase() === 'no';
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide',
        isYes && 'text-emerald-500',
        isNo && 'text-rose-500',
        !isYes && !isNo && 'text-muted-foreground',
      )}
    >
      <span>↳</span>
      {label}
    </div>
  );
}

export function MobileStepEditor({
  nodes,
  edges,
  onAddNode,
  onDeleteNode,
  onUpdateNodeParameters,
  readOnly,
}: MobileStepEditorProps) {
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const order = useMemo(() => computeMobileOrder(nodes, edges), [nodes, edges]);
  const openNode = openNodeId ? nodes.find((n) => n.id === openNodeId) ?? null : null;
  const pendingDeleteNode = pendingDeleteId ? nodes.find((n) => n.id === pendingDeleteId) ?? null : null;

  const reachableEntries = order.filter((e): e is Extract<MobileOrderEntry, { kind: 'step' | 'reference' }> => e.kind !== 'unreachable');
  const unreachable = order.filter((e): e is Extract<MobileOrderEntry, { kind: 'unreachable' }> => e.kind === 'unreachable');

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2" style={{ WebkitOverflowScrolling: 'touch' }}>
        {nodes.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center gap-2">
            <p className="text-sm text-muted-foreground">No steps yet.</p>
          </div>
        )}

        {reachableEntries.map((entry, i) => {
          const node = entry.kind === 'step' ? entry.node : entry.targetNode;
          return (
            <div key={`${node.id}-${i}`} style={{ marginLeft: entry.depth * 16 }} className="space-y-2">
              {entry.branchLabel && <BranchLabel label={entry.branchLabel} />}
              {entry.kind === 'step' ? (
                <StepCard
                  node={node}
                  onOpen={() => setOpenNodeId(node.id)}
                  onDelete={() => setPendingDeleteId(node.id)}
                  readOnly={readOnly}
                />
              ) : (
                <button
                  onClick={() => setOpenNodeId(node.id)}
                  className="w-full text-left text-xs text-muted-foreground italic px-3 py-2 rounded-lg border border-dashed border-border hover:bg-muted/20 transition-colors"
                >
                  ↳ continues at &ldquo;{node.data.name}&rdquo; (already shown above)
                </button>
              )}
            </div>
          );
        })}

        {unreachable.length > 0 && (
          <div className="pt-2 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">
              Not connected to the flow
            </p>
            {unreachable.map(({ node }) => (
              <StepCard
                key={node.id}
                node={node}
                onOpen={() => setOpenNodeId(node.id)}
                onDelete={() => setPendingDeleteId(node.id)}
                readOnly={readOnly}
              />
            ))}
          </div>
        )}

        {!readOnly && (
          <button
            onClick={() => setPaletteOpen(true)}
            className="w-full flex items-center justify-center gap-2 rounded-xl border border-dashed border-border py-3.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground/40 active:bg-muted/30 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add step
          </button>
        )}
      </div>

      {/* Full-height configuration sheet */}
      {openNode && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }} role="dialog" aria-modal="true" aria-label={`Configure ${openNode.data.name}`}>
          <NodeSettingsPanel
            node={openNode}
            onUpdate={onUpdateNodeParameters}
            onClose={() => setOpenNodeId(null)}
            readOnly={readOnly}
            fullWidth
          />
        </div>
      )}

      {/* Add-step sheet */}
      {paletteOpen && !readOnly && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-background"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          role="dialog"
          aria-modal="true"
          aria-label="Add a step"
        >
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border bg-muted/20 flex-shrink-0">
            <p className="text-sm font-semibold text-foreground">Add a step</p>
            <Button variant="ghost" size="sm" onClick={() => setPaletteOpen(false)} className="h-11 w-11 p-0" aria-label="Close">
              <X className="h-5 w-5" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <NodePalette
              onAddNode={(type, label) => {
                onAddNode(type, label);
                setPaletteOpen(false);
              }}
            />
          </div>
        </div>
      )}

      {/* Delete confirmation — deleting a step is not easily undoable from
          a thumb-reach standpoint the way Ctrl+Z is on desktop, so mobile
          gets an explicit confirm step rather than a single accidental tap. */}
      {pendingDeleteNode && (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 p-3" role="alertdialog" aria-modal="true" aria-label="Confirm delete step">
          <div className="w-full sm:max-w-sm rounded-xl border border-border bg-card p-4 space-y-3" style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
            <p className="text-sm font-medium text-foreground">Delete &ldquo;{pendingDeleteNode.data.name}&rdquo;?</p>
            <p className="text-xs text-muted-foreground">This removes the step and its connections. You can undo this from the desktop editor's undo history if needed.</p>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1 h-11" onClick={() => setPendingDeleteId(null)}>Cancel</Button>
              <Button variant="destructive" className="flex-1 h-11" onClick={() => { onDeleteNode(pendingDeleteNode.id); setPendingDeleteId(null); }}>Delete</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
