export type GraphNode = {
  id: string;
  type: string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  data?: Record<string, unknown>;
};

export type WorkflowGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type GraphDiff = {
  addedNodes: GraphNode[];
  removedNodes: GraphNode[];
  updatedNodes: Array<{ before: GraphNode; after: GraphNode }>;
  addedEdges: GraphEdge[];
  removedEdges: GraphEdge[];
  updatedEdges: Array<{ before: GraphEdge; after: GraphEdge }>;
};

function isEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffGraphs(previous: WorkflowGraph, next: WorkflowGraph): GraphDiff {
  const prevNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  const prevEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const nextEdges = new Map(next.edges.map((edge) => [edge.id, edge]));

  const addedNodes: GraphNode[] = [];
  const removedNodes: GraphNode[] = [];
  const updatedNodes: Array<{ before: GraphNode; after: GraphNode }> = [];

  for (const node of next.nodes) {
    const before = prevNodes.get(node.id);
    if (!before) {
      addedNodes.push(node);
      continue;
    }

    if (!isEqualJson(before, node)) {
      updatedNodes.push({ before, after: node });
    }
  }

  for (const node of previous.nodes) {
    if (!nextNodes.has(node.id)) {
      removedNodes.push(node);
    }
  }

  const addedEdges: GraphEdge[] = [];
  const removedEdges: GraphEdge[] = [];
  const updatedEdges: Array<{ before: GraphEdge; after: GraphEdge }> = [];

  for (const edge of next.edges) {
    const before = prevEdges.get(edge.id);
    if (!before) {
      addedEdges.push(edge);
      continue;
    }

    if (!isEqualJson(before, edge)) {
      updatedEdges.push({ before, after: edge });
    }
  }

  for (const edge of previous.edges) {
    if (!nextEdges.has(edge.id)) {
      removedEdges.push(edge);
    }
  }

  return {
    addedNodes,
    removedNodes,
    updatedNodes,
    addedEdges,
    removedEdges,
    updatedEdges,
  };
}
