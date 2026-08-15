'use client';

import { ArrowDown, ArrowRight, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NodeTypeIcon } from '@/components/execution/NodeTypeIcon';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FlowNode {
  name: string;
  type: string;
}

export interface FlowConnections {
  [sourceName: string]: { main: Array<Array<{ node: string }>> };
}

export interface WorkflowNodeFlowProps {
  nodes:       FlowNode[];
  connections: FlowConnections;
  /** Show horizontal layout instead of vertical */
  horizontal?: boolean;
  className?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isFanout(name: string, connections: FlowConnections): boolean {
  const port = connections[name]?.main?.[0] ?? [];
  return port.length > 1;
}

function isBranch(name: string, connections: FlowConnections): boolean {
  return (connections[name]?.main?.length ?? 0) >= 2;
}

function getTargets(name: string, connections: FlowConnections): string[] {
  const main = connections[name]?.main ?? [];
  const all: string[] = [];
  for (const port of main) {
    for (const entry of port) {
      if (!all.includes(entry.node)) all.push(entry.node);
    }
  }
  return all;
}

// ─── Single node card ─────────────────────────────────────────────────────────

function NodeCard({ node, fanout, branch }: { node: FlowNode; fanout?: boolean; branch?: boolean }) {
  return (
    <div className={cn(
      'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs bg-card',
      branch ? 'border-violet-400/50 bg-violet-500/5' : 'border-border',
    )}>
      <NodeTypeIcon nodeType={node.type} size="sm" className="flex-shrink-0" />
      <span className="font-medium text-foreground truncate max-w-[140px]">{node.name}</span>
      {fanout  && <span className="text-[10px] text-muted-foreground ml-0.5">[parallel]</span>}
      {branch  && <GitBranch className="h-3 w-3 text-violet-400 ml-0.5 flex-shrink-0" />}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders a workflow as a visual node chain.
 * Handles linear, fan-out, and conditional (IF) topologies.
 */
export function WorkflowNodeFlow({ nodes, connections, horizontal = false, className }: WorkflowNodeFlowProps) {
  if (nodes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">No nodes</p>
    );
  }

  // Build a simple ordered render list:
  // Start from the first node with no incoming edges (or first node if ambiguous).
  const incoming = new Map<string, number>();
  for (const n of nodes) incoming.set(n.name, 0);
  for (const name of Object.keys(connections)) {
    for (const t of getTargets(name, connections)) {
      incoming.set(t, (incoming.get(t) ?? 0) + 1);
    }
  }

  const startNames = nodes
    .filter(n => (incoming.get(n.name) ?? 0) === 0)
    .map(n => n.name);

  const startName = startNames[0] ?? nodes[0].name;

  // DFS-ordered rendering
  const rendered = new Set<string>();
  const ordered: FlowNode[] = [];

  function dfs(name: string): void {
    if (rendered.has(name)) return;
    const node = nodes.find(n => n.name === name);
    if (!node) return;
    rendered.add(name);
    ordered.push(node);
    for (const t of getTargets(name, connections)) dfs(t);
  }

  dfs(startName);

  // Any remaining nodes not reachable from start
  for (const n of nodes) {
    if (!rendered.has(n.name)) {
      rendered.add(n.name);
      ordered.push(n);
    }
  }

  const ArrowIcon = horizontal ? ArrowRight : ArrowDown;

  return (
    <div
      className={cn(
        'flex gap-2 flex-wrap items-center',
        horizontal ? 'flex-row' : 'flex-col items-start',
        className,
      )}
    >
      {ordered.map((node, i) => {
        const isLast   = i === ordered.length - 1;
        const fanout   = isFanout(node.name, connections);
        const branch   = isBranch(node.name, connections);

        return (
          <div key={node.name} className={cn(
            'flex items-center gap-2',
            !horizontal && 'flex-col items-start',
          )}>
            <NodeCard node={node} fanout={fanout} branch={branch} />

            {!isLast && (
              <ArrowIcon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            )}
          </div>
        );
      })}
    </div>
  );
}
