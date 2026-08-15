'use client';

// CSS for React Flow is imported globally in app/globals.css

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  BackgroundVariant,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  LayoutGrid,
  Loader2,
  Play,
  Redo2,
  Save,
  Undo2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import {
  workflowJsonToRF,
  rfToWorkflowJson,
  generateUniqueName,
  cloneNodes,
  cloneEdges,
} from '@/lib/workflow-editor/convert';
import { autoLayout } from '@/lib/workflow-editor/layout';
import { validateWorkflow, type ValidationResult } from '@/lib/workflow-validator';
import type { WorkflowJson, WorkflowNodeData, HistorySnapshot } from '@/lib/workflow-editor/types';

import { WorkflowNodeCard } from './WorkflowNodeCard';
import { NodePalette } from './NodePalette';
import { NodeSettingsPanel } from './NodeSettingsPanel';
import { ExecutionPreview } from './ExecutionPreview';
import { WorkflowEditorContext } from './context';

// ─── Config ───────────────────────────────────────────────────────────────────

const NODE_TYPES: NodeTypes = { workflowNode: WorkflowNodeCard };
const MAX_HISTORY = 50;
const INIT_NODES: Node<WorkflowNodeData>[] = [];
const INIT_EDGES: Edge[] = [];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowEditorProps {
  initialWorkflow: WorkflowJson;
  onWorkflowChange?: (wf: WorkflowJson) => void;
  showSaveButton?: boolean;
  onSave?: (wf: WorkflowJson, validation: ValidationResult) => void | Promise<void>;
  readOnly?: boolean;
  height?: string;
  className?: string;
}

// ─── Inner editor ─────────────────────────────────────────────────────────────

function WorkflowEditorInner({
  initialWorkflow,
  onWorkflowChange,
  showSaveButton,
  onSave,
  readOnly,
  height = '560px',
  className,
}: WorkflowEditorProps) {
  const { fitView, getViewport } = useReactFlow();

  // RF state
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<WorkflowNodeData>>(INIT_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(INIT_EDGES);

  const nodesRef = useRef<Node<WorkflowNodeData>[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  const wfNameRef = useRef(initialWorkflow.name);

  // Selected node (settings panel)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNode = useMemo(
    () => (selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) ?? null : null),
    [selectedNodeId, nodes],
  );

  // Execution preview
  const [showExecutionPreview, setShowExecutionPreview] = useState(false);
  const [previewWorkflow, setPreviewWorkflow] = useState<WorkflowJson | null>(null);

  // Undo / redo
  const history = useRef<HistorySnapshot[]>([]);
  const histIdx = useRef(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Validation
  const [valResult, setValResult] = useState<ValidationResult>({
    valid: true,
    errors: [],
    warnings: [],
  });

  const [saving, setSaving] = useState(false);
  const changeTimer = useRef<ReturnType<typeof setTimeout>>();

  // ─── Initialization ─────────────────────────────────────────────────────────

  useEffect(() => {
    const { rfNodes, rfEdges } = workflowJsonToRF(initialWorkflow);
    setNodes(rfNodes);
    setEdges(rfEdges);
    nodesRef.current = rfNodes;
    edgesRef.current = rfEdges;
    wfNameRef.current = initialWorkflow.name;
    history.current = [{ nodes: cloneNodes(rfNodes), edges: cloneEdges(rfEdges) }];
    histIdx.current = 0;
    setCanUndo(false);
    setCanRedo(false);
    setSelectedNodeId(null);
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 80);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── History helpers ─────────────────────────────────────────────────────────

  function pushHistory(n: Node<WorkflowNodeData>[], e: Edge[]) {
    const snapshot: HistorySnapshot = { nodes: cloneNodes(n), edges: cloneEdges(e) };
    const h = history.current.slice(0, histIdx.current + 1);
    h.push(snapshot);
    if (h.length > MAX_HISTORY) h.shift();
    history.current = h;
    histIdx.current = h.length - 1;
    setCanUndo(histIdx.current > 0);
    setCanRedo(false);
  }

  function restoreSnapshot(snap: HistorySnapshot) {
    const n = cloneNodes(snap.nodes);
    const e = cloneEdges(snap.edges);
    setNodes(n);
    setEdges(e);
    nodesRef.current = n;
    edgesRef.current = e;
    emitChange(n, e);
  }

  function doUndo() {
    if (histIdx.current <= 0) return;
    histIdx.current--;
    restoreSnapshot(history.current[histIdx.current]);
    setCanUndo(histIdx.current > 0);
    setCanRedo(true);
  }

  function doRedo() {
    if (histIdx.current >= history.current.length - 1) return;
    histIdx.current++;
    restoreSnapshot(history.current[histIdx.current]);
    setCanUndo(true);
    setCanRedo(histIdx.current < history.current.length - 1);
  }

  // ─── Change emission ─────────────────────────────────────────────────────────

  function emitChange(n: Node<WorkflowNodeData>[], e: Edge[]) {
    const wf = rfToWorkflowJson(n, e, wfNameRef.current);
    const result = validateWorkflow(wf as unknown);
    setValResult(result);
    clearTimeout(changeTimer.current);
    changeTimer.current = setTimeout(() => onWorkflowChange?.(wf), 150);
  }

  // ─── Node callbacks ──────────────────────────────────────────────────────────

  const onRenameNode = useCallback((id: string, newName: string) => {
    if (readOnly) return;
    setNodes((prev) => {
      const next = prev.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, name: newName } } : n,
      );
      pushHistory(next, edgesRef.current);
      emitChange(next, edgesRef.current);
      return next;
    });
  }, [readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDeleteNode = useCallback((id: string) => {
    if (readOnly) return;
    if (selectedNodeId === id) setSelectedNodeId(null);
    setNodes((prevNodes) => {
      const nextNodes = prevNodes.filter((n) => n.id !== id);
      setEdges((prevEdges) => {
        const nextEdges = prevEdges.filter((e) => e.source !== id && e.target !== id);
        nodesRef.current = nextNodes;
        edgesRef.current = nextEdges;
        pushHistory(nextNodes, nextEdges);
        emitChange(nextNodes, nextEdges);
        return nextEdges;
      });
      return nextNodes;
    });
  }, [readOnly, selectedNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onUpdateNodeParameters = useCallback(
    (id: string, parameters: Record<string, unknown>) => {
      if (readOnly) return;
      setNodes((prev) => {
        const next = prev.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, parameters } } : n,
        );
        pushHistory(next, edgesRef.current);
        emitChange(next, edgesRef.current);
        return next;
      });
    },
    [readOnly], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const ctx = useMemo(
    () => ({ onRenameNode, onDeleteNode, onUpdateNodeParameters }),
    [onRenameNode, onDeleteNode, onUpdateNodeParameters],
  );

  // ─── RF event handlers ───────────────────────────────────────────────────────

  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      setEdges((prev) => {
        const next = addEdge({ ...connection, type: 'smoothstep', animated: false }, prev);
        pushHistory(nodesRef.current, next);
        emitChange(nodesRef.current, next);
        return next;
      });
    },
    [readOnly], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node<WorkflowNodeData>) => {
      setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
    },
    [],
  );

  const onPaneClick = useCallback(() => setSelectedNodeId(null), []);

  const onNodeDragStop = useCallback(() => {
    if (readOnly) return;
    setNodes((current) => {
      pushHistory(current, edgesRef.current);
      emitChange(current, edgesRef.current);
      return current;
    });
  }, [readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const onEdgesDelete = useCallback((_deleted: Edge[]) => {
    if (readOnly) return;
    requestAnimationFrame(() => {
      pushHistory(nodesRef.current, edgesRef.current);
      emitChange(nodesRef.current, edgesRef.current);
    });
  }, [readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Toolbar actions ─────────────────────────────────────────────────────────

  const handleAddNode = useCallback(
    (type: string, label: string) => {
      if (readOnly) return;
      const existingNames = nodesRef.current.map((n) => n.data.name as string);
      const name = generateUniqueName(label, existingNames);
      const vp = getViewport();
      const cx = (-vp.x + window.innerWidth / 2) / vp.zoom;
      const cy = (-vp.y + window.innerHeight / 2) / vp.zoom;
      const newNode: Node<WorkflowNodeData> = {
        id: crypto.randomUUID(),
        type: 'workflowNode',
        position: { x: cx - 90, y: cy - 20 },
        data: { name, nodeType: type, parameters: {} },
      };
      setNodes((prev) => {
        const next = [...prev, newNode];
        pushHistory(next, edgesRef.current);
        emitChange(next, edgesRef.current);
        return next;
      });
      setSelectedNodeId(newNode.id);
    },
    [readOnly, getViewport], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleAutoLayout = useCallback(() => {
    if (readOnly) return;
    const wf = rfToWorkflowJson(nodesRef.current, edgesRef.current, wfNameRef.current);
    const positions = autoLayout(wf.nodes, wf.connections);
    setNodes((prev) => {
      const next = prev.map((n) => {
        const pos = positions.get(n.data.name as string);
        return pos ? { ...n, position: { x: pos.x, y: pos.y } } : n;
      });
      pushHistory(next, edgesRef.current);
      emitChange(next, edgesRef.current);
      setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 50);
      return next;
    });
  }, [readOnly, fitView]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenPreview = useCallback(() => {
    const wf = rfToWorkflowJson(nodesRef.current, edgesRef.current, wfNameRef.current);
    setPreviewWorkflow(wf);
    setShowExecutionPreview(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!onSave) return;
    const wf = rfToWorkflowJson(nodesRef.current, edgesRef.current, wfNameRef.current);
    const result = validateWorkflow(wf as unknown);
    setSaving(true);
    try {
      await onSave(wf, result);
    } finally {
      setSaving(false);
    }
  }, [onSave]);

  // ─── Keyboard shortcuts ──────────────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
      if (e.key === 'Escape') setSelectedNodeId(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Validation badge ────────────────────────────────────────────────────────

  const validationBadge = useMemo(() => {
    if (valResult.errors.length > 0) {
      return (
        <Badge variant="destructive" className="gap-1 text-[11px]">
          <AlertCircle className="h-3 w-3" />
          {valResult.errors.length} error{valResult.errors.length !== 1 ? 's' : ''}
        </Badge>
      );
    }
    if (valResult.warnings.length > 0) {
      return (
        <Badge variant="secondary" className="gap-1 text-[11px]">
          <AlertTriangle className="h-3 w-3 text-amber-500" />
          {valResult.warnings.length} warning{valResult.warnings.length !== 1 ? 's' : ''}
        </Badge>
      );
    }
    return (
      <Badge variant="secondary" className="gap-1 text-[11px]">
        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
        Valid
      </Badge>
    );
  }, [valResult]);

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <WorkflowEditorContext.Provider value={ctx}>
      <div
        className={cn(
          'relative flex flex-col rounded-xl border border-border overflow-hidden',
          className,
        )}
        style={{ height }}
      >
        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-card/80 backdrop-blur flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={doUndo} disabled={!canUndo || readOnly} className="h-7 w-7 p-0" title="Undo (Ctrl+Z)">
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={doRedo} disabled={!canRedo || readOnly} className="h-7 w-7 p-0" title="Redo (Ctrl+Y)">
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
          <div className="w-px h-4 bg-border mx-0.5" />
          <Button variant="ghost" size="sm" onClick={handleAutoLayout} disabled={readOnly} className="h-7 gap-1.5 px-2 text-xs">
            <LayoutGrid className="h-3.5 w-3.5" />
            Auto Layout
          </Button>
          <Button variant="ghost" size="sm" onClick={handleOpenPreview} className="h-7 gap-1.5 px-2 text-xs" title="Preview execution order">
            <Play className="h-3.5 w-3.5" />
            Preview Execution
          </Button>
          <div className="flex-1" />
          {validationBadge}
          {showSaveButton && onSave && (
            <>
              <div className="w-px h-4 bg-border mx-0.5" />
              <Button size="sm" onClick={handleSave} disabled={saving || !valResult.valid} className="h-7 gap-1.5 px-3 text-xs">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save
              </Button>
            </>
          )}
        </div>

        {/* Canvas row — canvas + optional settings panel */}
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-w-0 relative">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
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
                  <NodePalette onAddNode={handleAddNode} />
                </Panel>
              )}
            </ReactFlow>

            {/* Execution preview overlay */}
            {showExecutionPreview && previewWorkflow && (
              <ExecutionPreview
                workflow={previewWorkflow}
                onClose={() => setShowExecutionPreview(false)}
              />
            )}
          </div>

          {/* Settings panel */}
          {selectedNode && !readOnly && (
            <NodeSettingsPanel
              node={selectedNode}
              onUpdate={onUpdateNodeParameters}
              onClose={() => setSelectedNodeId(null)}
            />
          )}
        </div>

        {/* Validation panel */}
        {(valResult.errors.length > 0 || valResult.warnings.length > 0) && (
          <div className="flex-shrink-0 border-t border-border bg-card max-h-28 overflow-y-auto">
            <div className="px-3 py-2 space-y-1">
              {valResult.errors.map((err, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span><span className="font-mono">{err.code}</span> — {err.message}</span>
                </div>
              ))}
              {valResult.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span><span className="font-mono">{w.code}</span> — {w.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </WorkflowEditorContext.Provider>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export function WorkflowEditor(props: WorkflowEditorProps) {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner {...props} />
    </ReactFlowProvider>
  );
}
