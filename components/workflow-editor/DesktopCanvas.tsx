'use client';

import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  BackgroundVariant,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
  type OnNodesChange,
  type OnEdgesChange,
} from '@xyflow/react';

import { WorkflowNodeCard } from './WorkflowNodeCard';
import { NodePalette } from './NodePalette';
import { NodeSettingsPanel } from './NodeSettingsPanel';
import { ExecutionPreview } from './ExecutionPreview';
import type { WorkflowNodeData } from '@/lib/workflow-editor/types';
import type { WorkflowJson } from '@/lib/workflow-editor/types';

const NODE_TYPES: NodeTypes = { workflowNode: WorkflowNodeCard };

/**
 * Phase 9.4.2 — the desktop React Flow canvas, split out of WorkflowEditor
 * so it can be loaded via next/dynamic(..., { ssr: false }) and never ship
 * in the bundle a mobile visitor downloads. All state/callbacks are owned
 * by WorkflowEditorInner and passed in as props -- this component holds no
 * business logic of its own, only the desktop-specific rendering
 * (graph, minimap, floating palette, side settings panel).
 */
export interface DesktopCanvasProps {
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node<WorkflowNodeData>>;
  onEdgesChange: OnEdgesChange<Edge>;
  onConnect: (connection: Connection) => void;
  onNodeClick: (e: React.MouseEvent, node: Node<WorkflowNodeData>) => void;
  onPaneClick: () => void;
  onNodeDragStop: () => void;
  onEdgesDelete: (deleted: Edge[]) => void;
  onAddNode: (type: string, label: string) => void;
  selectedNode: Node<WorkflowNodeData> | null;
  onUpdateNodeParameters: (id: string, parameters: Record<string, unknown>) => void;
  onCloseSettings: () => void;
  readOnly?: boolean;
  showExecutionPreview: boolean;
  previewWorkflow: WorkflowJson | null;
  onClosePreview: () => void;
}

export default function DesktopCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onPaneClick,
  onNodeDragStop,
  onEdgesDelete,
  onAddNode,
  selectedNode,
  onUpdateNodeParameters,
  onCloseSettings,
  readOnly,
  showExecutionPreview,
  previewWorkflow,
  onClosePreview,
}: DesktopCanvasProps) {
  return (
    <div className="flex flex-1 min-h-0">
      <div className="flex-1 min-w-0 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(c) => onConnect(c)}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onNodeDragStop={onNodeDragStop}
          onEdgesDelete={onEdgesDelete}
          nodeTypes={NODE_TYPES}
          deleteKeyCode={readOnly ? null : 'Delete'}
          multiSelectionKeyCode="Shift"
          fitView
          fitViewOptions={{ padding: 0.2 }}
          snapToGrid
          snapGrid={[16, 16]}
          minZoom={0.2}
          maxZoom={2}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--border))" />
          <Controls showInteractive={false} />
          <MiniMap nodeColor="hsl(var(--muted))" maskColor="hsl(var(--background) / 0.7)" className="!border !border-border !rounded-lg" />
          {!readOnly && (
            <Panel position="top-left">
              <NodePalette onAddNode={onAddNode} />
            </Panel>
          )}
        </ReactFlow>

        {showExecutionPreview && previewWorkflow && (
          <ExecutionPreview workflow={previewWorkflow} onClose={onClosePreview} />
        )}
      </div>

      {selectedNode && !readOnly && (
        <NodeSettingsPanel
          node={selectedNode}
          onUpdate={onUpdateNodeParameters}
          onClose={onCloseSettings}
        />
      )}
    </div>
  );
}
