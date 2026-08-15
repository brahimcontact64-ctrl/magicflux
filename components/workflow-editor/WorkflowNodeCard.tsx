'use client';

import { useContext, useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NodeTypeIcon } from '@/components/execution/NodeTypeIcon';
import { isConditionNodeType } from '@/lib/workflow-editor/convert';
import { WorkflowEditorContext } from './context';
import type { WorkflowNodeData } from '@/lib/workflow-editor/types';

// ─── Style helpers (mirrors existing workflow-canvas.tsx colour scheme) ────────

const HANDLE_BASE =
  '!w-3 !h-3 !rounded-full !border-2 !border-background transition-colors';

// ─── Component ────────────────────────────────────────────────────────────────

type WFNodeProps = NodeProps & { data: WorkflowNodeData };

export function WorkflowNodeCard({ id, data, selected, dragging }: WFNodeProps) {
  const { onRenameNode, onDeleteNode } = useContext(WorkflowEditorContext);
  const isCondition = isConditionNodeType(data.nodeType);

  // Inline rename state
  const [editing, setEditing] = useState(false);
  const [localName, setLocalName] = useState(data.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync if parent updates data (e.g. undo/redo)
  useEffect(() => {
    if (!editing) setLocalName(data.name);
  }, [data.name, editing]);

  function startEditing() {
    setEditing(true);
    setLocalName(data.name);
    // Focus happens after state update
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function commitRename() {
    setEditing(false);
    const trimmed = localName.trim();
    if (trimmed && trimmed !== data.name) {
      onRenameNode(id, trimmed);
    } else {
      setLocalName(data.name);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') {
      setEditing(false);
      setLocalName(data.name);
    }
    e.stopPropagation(); // prevent ReactFlow from capturing arrow keys during rename
  }

  return (
    <div
      className={cn(
        'relative min-w-[180px] max-w-[220px] rounded-lg border bg-card shadow-sm select-none',
        'transition-shadow',
        selected && 'ring-2 ring-violet-500 ring-offset-1 ring-offset-background',
        dragging && 'shadow-lg opacity-90',
        isCondition ? 'border-violet-400/60 bg-violet-500/5' : 'border-border',
      )}
    >
      {/* ── Target handle (left) ── */}
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className={cn(HANDLE_BASE, '!bg-muted-foreground hover:!bg-foreground')}
      />

      {/* ── Node body ── */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <NodeTypeIcon nodeType={data.nodeType} size="sm" className="flex-shrink-0" />

        {editing ? (
          <input
            ref={inputRef}
            value={localName}
            onChange={(e) => setLocalName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={onKeyDown}
            className={cn(
              'flex-1 min-w-0 text-xs font-medium bg-transparent',
              'border-b border-violet-400 outline-none text-foreground',
            )}
            aria-label="Rename node"
          />
        ) : (
          <span
            onDoubleClick={startEditing}
            className="flex-1 min-w-0 text-xs font-medium text-foreground truncate cursor-default"
            title={`${data.name} — double-click to rename`}
          >
            {data.name}
          </span>
        )}

        {/* Delete button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDeleteNode(id);
          }}
          className={cn(
            'flex-shrink-0 rounded p-0.5',
            'text-muted-foreground hover:text-destructive',
            'hover:bg-destructive/10 transition-colors',
          )}
          title="Delete node"
          aria-label="Delete node"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* ── Condition node: true / false labels + dual handles ── */}
      {isCondition && (
        <div className="flex justify-between px-3 pb-2">
          <span className="text-[10px] text-emerald-500 font-medium">true</span>
          <span className="text-[10px] text-rose-500 font-medium">false</span>
        </div>
      )}

      {/* ── Source handle(s) (right) ── */}
      {isCondition ? (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="port-0"
            style={{ top: '38%' }}
            className={cn(HANDLE_BASE, '!bg-emerald-500 hover:!bg-emerald-400')}
            title="True branch"
          />
          <Handle
            type="source"
            position={Position.Right}
            id="port-1"
            style={{ top: '68%' }}
            className={cn(HANDLE_BASE, '!bg-rose-500 hover:!bg-rose-400')}
            title="False branch"
          />
        </>
      ) : (
        <Handle
          type="source"
          position={Position.Right}
          id="port-0"
          className={cn(HANDLE_BASE, '!bg-muted-foreground hover:!bg-foreground')}
        />
      )}
    </div>
  );
}
