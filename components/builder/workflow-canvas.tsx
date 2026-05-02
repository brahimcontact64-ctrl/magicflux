'use client';

import { useMemo } from 'react';
import { WorkflowNode, WorkflowEdge, N8nNodeCategory } from '@/lib/ai-engine/types';
import { cn } from '@/lib/utils';

const NODE_COLORS: Record<N8nNodeCategory, { bg: string; border: string; dot: string; label: string }> = {
  trigger:   { bg: 'bg-cyan-500/15',    border: 'border-cyan-500/40',    dot: 'bg-cyan-400',    label: 'Trigger' },
  transform: { bg: 'bg-amber-500/15',   border: 'border-amber-500/40',   dot: 'bg-amber-400',   label: 'Transform' },
  email:     { bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', dot: 'bg-emerald-400', label: 'Email' },
  database:  { bg: 'bg-orange-500/15',  border: 'border-orange-500/40',  dot: 'bg-orange-400',  label: 'Database' },
  crm:       { bg: 'bg-rose-500/15',    border: 'border-rose-500/40',    dot: 'bg-rose-400',    label: 'CRM' },
  ecommerce: { bg: 'bg-green-500/15',   border: 'border-green-500/40',   dot: 'bg-green-400',   label: 'E-commerce' },
  messaging: { bg: 'bg-purple-500/15',  border: 'border-purple-500/40',  dot: 'bg-purple-400',  label: 'Messaging' },
  calendar:  { bg: 'bg-blue-500/15',    border: 'border-blue-500/40',    dot: 'bg-blue-400',    label: 'Calendar' },
  condition: { bg: 'bg-pink-500/15',    border: 'border-pink-500/40',    dot: 'bg-pink-400',    label: 'Condition' },
  delay:     { bg: 'bg-slate-500/15',   border: 'border-slate-500/40',   dot: 'bg-slate-400',   label: 'Delay' },
  utility:   { bg: 'bg-zinc-500/15',    border: 'border-zinc-500/40',    dot: 'bg-zinc-400',    label: 'Utility' }
};

const NODE_W = 140;
const NODE_H = 48;
const PAD = 40;

interface WorkflowCanvasProps {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  className?: string;
}

function normalizePositions(nodes: WorkflowNode[]) {
  if (nodes.length === 0) return nodes;
  const minX = Math.min(...nodes.map(n => n.position[0]));
  const minY = Math.min(...nodes.map(n => n.position[1]));
  return nodes.map(n => ({
    ...n,
    position: [n.position[0] - minX + PAD, n.position[1] - minY + PAD] as [number, number]
  }));
}

function computeViewBox(nodes: WorkflowNode[]) {
  if (nodes.length === 0) return { w: 600, h: 200 };
  const maxX = Math.max(...nodes.map(n => n.position[0])) + NODE_W + PAD;
  const maxY = Math.max(...nodes.map(n => n.position[1])) + NODE_H + PAD;
  return { w: Math.max(600, maxX), h: Math.max(160, maxY) };
}

function EdgePath({ from, to, nodeMap }: {
  from: string;
  to: string;
  nodeMap: Record<string, WorkflowNode>;
}) {
  const src = nodeMap[from];
  const dst = nodeMap[to];
  if (!src || !dst) return null;

  const x1 = src.position[0] + NODE_W;
  const y1 = src.position[1] + NODE_H / 2;
  const x2 = dst.position[0];
  const y2 = dst.position[1] + NODE_H / 2;
  const cx = (x1 + x2) / 2;

  const path = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;

  return (
    <g>
      <path d={path} fill="none" stroke="hsl(var(--border))" strokeWidth="1.5" />
      <polygon
        points={`${x2},${y2} ${x2 - 6},${y2 - 4} ${x2 - 6},${y2 + 4}`}
        fill="hsl(var(--border))"
      />
    </g>
  );
}

export function WorkflowCanvas({ nodes, edges, className }: WorkflowCanvasProps) {
  const normalized = useMemo(() => normalizePositions(nodes), [nodes]);
  const { w, h } = useMemo(() => computeViewBox(normalized), [normalized]);
  const nodeMap = useMemo(() =>
    Object.fromEntries(normalized.map(n => [n.id, n])),
    [normalized]
  );

  const usedTypes = Array.from(new Set(nodes.map(n => n.nodeType)));

  if (nodes.length === 0) {
    return (
      <div className={cn('flex items-center justify-center h-48 text-sm text-muted-foreground border border-dashed border-border rounded-xl', className)}>
        No workflow data available
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {/* Canvas */}
      <div className="rounded-xl border border-border bg-muted/10 overflow-auto scrollbar-thin">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          width="100%"
          style={{ minWidth: Math.min(w, 500), height: 'auto', minHeight: 140 }}
        >
          {/* Grid dots */}
          <defs>
            <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.6" fill="hsl(var(--border))" opacity="0.5" />
            </pattern>
          </defs>
          <rect width={w} height={h} fill="url(#grid)" />

          {/* Edges */}
          {edges.map((edge, i) => (
            <EdgePath key={i} from={edge.from} to={edge.to} nodeMap={nodeMap} />
          ))}

          {/* Nodes (rendered as foreignObject for rich HTML) */}
          {normalized.map(node => {
            const colors = NODE_COLORS[node.nodeType] || NODE_COLORS.utility;
            return (
              <foreignObject
                key={node.id}
                x={node.position[0]}
                y={node.position[1]}
                width={NODE_W}
                height={NODE_H}
              >
                <div
                  className={cn(
                    'w-full h-full rounded-lg border flex items-center gap-2 px-2.5 text-xs font-medium cursor-default select-none',
                    colors.bg,
                    colors.border
                  )}
                  style={{ fontFamily: 'inherit' }}
                >
                  <span className={cn('w-2 h-2 rounded-full flex-shrink-0', colors.dot)} />
                  <span className="truncate leading-tight text-foreground" style={{ fontSize: '11px' }}>
                    {node.label}
                  </span>
                </div>
              </foreignObject>
            );
          })}
        </svg>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-2">
        {usedTypes.map(type => {
          const colors = NODE_COLORS[type] || NODE_COLORS.utility;
          return (
            <div key={type} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn('w-2 h-2 rounded-full', colors.dot)} />
              {colors.label}
            </div>
          );
        })}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground ml-2 pl-2 border-l border-border">
          {nodes.length} nodes &middot; {edges.length} connections
        </div>
      </div>
    </div>
  );
}
