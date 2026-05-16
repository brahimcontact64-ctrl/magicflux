import type { GraphEdge, GraphNode } from './graph-diff';

export type PositionedGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

function topologicalLayers(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of nodes) {
    incoming.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of edges) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, 0);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);

    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }

  const queue: string[] = [];
  for (const [nodeId, count] of incoming.entries()) {
    if (count === 0) queue.push(nodeId);
  }

  const layer = new Map<string, number>();
  for (const nodeId of queue) {
    layer.set(nodeId, 0);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    const currentLayer = layer.get(current) ?? 0;
    const targets = outgoing.get(current) ?? [];

    for (const target of targets) {
      const nextLayer = Math.max(layer.get(target) ?? 0, currentLayer + 1);
      layer.set(target, nextLayer);
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if ((incoming.get(target) ?? 0) <= 0) {
        queue.push(target);
      }
    }
  }

  for (const node of nodes) {
    if (!layer.has(node.id)) {
      layer.set(node.id, 0);
    }
  }

  return layer;
}

export function recalculateLayout(graph: PositionedGraph): PositionedGraph {
  const layerMap = topologicalLayers(graph.nodes, graph.edges);
  const perLayer = new Map<number, GraphNode[]>();

  for (const node of graph.nodes) {
    const layer = layerMap.get(node.id) ?? 0;
    const bucket = perLayer.get(layer) ?? [];
    bucket.push(node);
    perLayer.set(layer, bucket);
  }

  const horizontalSpacing = 320;
  const verticalSpacing = 140;
  const nextNodes: GraphNode[] = [];

  for (const [layer, nodes] of Array.from(perLayer.entries()).sort((a, b) => a[0] - b[0])) {
    nodes.forEach((node, index) => {
      nextNodes.push({
        ...node,
        position: {
          x: layer * horizontalSpacing,
          y: index * verticalSpacing,
        },
      });
    });
  }

  return {
    nodes: nextNodes,
    edges: graph.edges,
  };
}
