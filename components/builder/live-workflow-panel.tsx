'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, Play, Workflow, XCircle } from 'lucide-react';

import { cn } from '@/lib/utils';

export type LiveNodeState =
  | 'generating'
  | 'configuring'
  | 'validating'
  | 'connected'
  | 'failed'
  | 'deployed';

export type LiveWorkflowNode = {
  id: string;
  label: string;
  kind: 'trigger' | 'action' | 'condition' | 'ai' | 'utility';
  position: [number, number];
  state: LiveNodeState;
  visible?: boolean;
};

export type LiveWorkflowEdge = {
  from: string;
  to: string;
  animated?: boolean;
  active?: boolean;
};

export type LiveWorkflowStatus = {
  nodes: LiveWorkflowNode[];
  edges: LiveWorkflowEdge[];
  narration: string[];
  integrationsConnected: number;
  integrationsTotal: number;
  validated: boolean;
  readyToDeploy: boolean;
};

type Props = {
  status: LiveWorkflowStatus;
  className?: string;
};

const NODE_W = 156;
const NODE_H = 58;
const PAD = 48;

const stateTone: Record<LiveNodeState, string> = {
  generating: 'border-cyan-500/35 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  configuring: 'border-blue-500/35 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  validating: 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  connected: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  failed: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  deployed: 'border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300',
};

const groupTone: Record<LiveWorkflowNode['kind'], string> = {
  trigger: 'fill-cyan-500/7 stroke-cyan-500/20',
  action: 'fill-emerald-500/7 stroke-emerald-500/20',
  condition: 'fill-amber-500/7 stroke-amber-500/20',
  ai: 'fill-fuchsia-500/7 stroke-fuchsia-500/20',
  utility: 'fill-slate-500/7 stroke-slate-500/20',
};

function normalize(nodes: LiveWorkflowNode[]) {
  if (nodes.length === 0) return nodes;
  const minX = Math.min(...nodes.map((n) => n.position[0]));
  const minY = Math.min(...nodes.map((n) => n.position[1]));
  return nodes.map((n) => ({
    ...n,
    position: [n.position[0] - minX + PAD, n.position[1] - minY + PAD] as [number, number],
  }));
}

function edgePath(from: LiveWorkflowNode, to: LiveWorkflowNode) {
  const x1 = from.position[0] + NODE_W;
  const y1 = from.position[1] + NODE_H / 2;
  const x2 = to.position[0];
  const y2 = to.position[1] + NODE_H / 2;
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
}

function NodeStateBadge({ state }: { state: LiveNodeState }) {
  if (state === 'failed') return <XCircle className="w-3.5 h-3.5" />;
  if (state === 'deployed') return <CheckCircle2 className="w-3.5 h-3.5" />;
  if (state === 'connected') return <CheckCircle2 className="w-3.5 h-3.5" />;
  if (state === 'validating') return <Clock3 className="w-3.5 h-3.5" />;
  return <Workflow className="w-3.5 h-3.5" />;
}

export function LiveWorkflowPanel({ status, className }: Props) {
  const [previewOn, setPreviewOn] = useState(false);
  const [activeNode, setActiveNode] = useState<string | null>(null);

  const visibleNodes = useMemo(
    () => status.nodes.filter((node) => node.visible !== false),
    [status.nodes]
  );

  const nodes = useMemo(() => normalize(visibleNodes), [visibleNodes]);
  const nodeMap = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);

  const edges = useMemo(
    () => status.edges.filter((edge) => nodeMap[edge.from] && nodeMap[edge.to]),
    [status.edges, nodeMap]
  );

  const bounds = useMemo(() => {
    if (nodes.length === 0) return { w: 640, h: 280 };
    const maxX = Math.max(...nodes.map((n) => n.position[0])) + NODE_W + PAD;
    const maxY = Math.max(...nodes.map((n) => n.position[1])) + NODE_H + PAD;
    return { w: Math.max(640, maxX), h: Math.max(280, maxY) };
  }, [nodes]);

  const grouped = useMemo(() => {
    const byKind = new Map<LiveWorkflowNode['kind'], LiveWorkflowNode[]>();
    for (const node of nodes) {
      const list = byKind.get(node.kind) ?? [];
      list.push(node);
      byKind.set(node.kind, list);
    }

    return Array.from(byKind.entries()).map(([kind, list]) => {
      const minX = Math.min(...list.map((n) => n.position[0])) - 16;
      const minY = Math.min(...list.map((n) => n.position[1])) - 16;
      const maxX = Math.max(...list.map((n) => n.position[0])) + NODE_W + 16;
      const maxY = Math.max(...list.map((n) => n.position[1])) + NODE_H + 16;
      return {
        kind,
        x: minX,
        y: minY,
        w: maxX - minX,
        h: maxY - minY,
      };
    });
  }, [nodes]);

  useEffect(() => {
    if (!previewOn || nodes.length === 0) return;

    const sequence = nodes.map((node) => node.id);
    let idx = 0;

    const timer = window.setInterval(() => {
      setActiveNode(sequence[idx] ?? null);
      idx = (idx + 1) % sequence.length;
    }, 650);

    return () => {
      window.clearInterval(timer);
      setActiveNode(null);
    };
  }, [previewOn, nodes]);

  const activeEdges = useMemo(() => {
    if (!activeNode) return new Set<string>();
    return new Set(
      edges
        .filter((edge) => edge.from === activeNode || edge.to === activeNode)
        .map((edge) => `${edge.from}:${edge.to}`)
    );
  }, [activeNode, edges]);

  if (nodes.length === 0) return null;

  return (
    <div className={cn('mt-3 rounded-2xl border border-border bg-card/80 p-3 space-y-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Live Workflow Builder</p>
          <p className="text-sm font-semibold">Automation graph is being assembled</p>
        </div>
        <button
          onClick={() => setPreviewOn((prev) => !prev)}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors',
            previewOn
              ? 'border-primary/35 bg-primary/10 text-primary'
              : 'border-border hover:border-primary/30 text-muted-foreground hover:text-foreground'
          )}
        >
          <Play className="w-3.5 h-3.5" />
          {previewOn ? 'Stop preview' : 'Preview execution'}
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div className="rounded-xl border border-border bg-background/60 overflow-auto">
          <svg viewBox={`0 0 ${bounds.w} ${bounds.h}`} width="100%" style={{ minWidth: Math.min(bounds.w, 680), minHeight: 260 }}>
            <defs>
              <pattern id="live-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="0.8" fill="hsl(var(--border))" opacity="0.5" />
              </pattern>
            </defs>
            <rect width={bounds.w} height={bounds.h} fill="url(#live-grid)" />

            {grouped.map((group) => (
              <g key={`group-${group.kind}`}>
                <rect
                  x={group.x}
                  y={group.y}
                  width={group.w}
                  height={group.h}
                  rx={14}
                  className={groupTone[group.kind]}
                />
                <text
                  x={group.x + 10}
                  y={group.y + 16}
                  fill="hsl(var(--muted-foreground))"
                  style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase' }}
                >
                  {group.kind}
                </text>
              </g>
            ))}

            {edges.map((edge) => {
              const from = nodeMap[edge.from];
              const to = nodeMap[edge.to];
              if (!from || !to) return null;

              const id = `${edge.from}:${edge.to}`;
              const active = activeEdges.has(id);
              return (
                <path
                  key={id}
                  d={edgePath(from, to)}
                  fill="none"
                  stroke={active ? 'hsl(var(--primary))' : 'hsl(var(--border))'}
                  strokeWidth={active ? 2.5 : 1.7}
                  strokeDasharray={edge.animated || previewOn ? '9 7' : undefined}
                  style={edge.animated || previewOn ? { animation: 'live-flow 1.1s linear infinite' } : undefined}
                  opacity={active ? 1 : 0.85}
                />
              );
            })}

            {nodes.map((node) => {
              const active = node.id === activeNode;
              return (
                <foreignObject key={node.id} x={node.position[0]} y={node.position[1]} width={NODE_W} height={NODE_H}>
                  <div
                    className={cn(
                      'w-full h-full rounded-xl border px-3 py-2 flex flex-col justify-center gap-1 transition-all',
                      stateTone[node.state],
                      active && 'ring-2 ring-primary/45 scale-[1.02]'
                    )}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <p className="text-[11px] font-semibold truncate">{node.label}</p>
                      <NodeStateBadge state={node.state} />
                    </div>
                    <p className="text-[10px] uppercase tracking-wide opacity-80">{node.state}</p>
                  </div>
                </foreignObject>
              );
            })}
          </svg>
        </div>

        <div className="space-y-2.5">
          <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">AI activity</p>
            <div className="mt-2 space-y-1.5">
              {status.narration.slice(-4).map((line, idx) => (
                <p key={`${line}-${idx}`} className="text-xs text-foreground/90">{line}</p>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5 space-y-1.5">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Deploy readiness</p>
            <p className="text-xs">
              Integrations: <span className="font-medium">{status.integrationsConnected}/{status.integrationsTotal}</span>
            </p>
            <p className="text-xs">Workflow validated: <span className="font-medium">{status.validated ? 'Yes' : 'In progress'}</span></p>
            <p className="text-xs">Ready for deployment: <span className="font-medium">{status.readyToDeploy ? 'Yes' : 'Not yet'}</span></p>
          </div>
        </div>
      </div>
    </div>
  );
}
