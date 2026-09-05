export interface LayoutGraphInput {
  artifacts: readonly { id: string }[];
  edges: readonly { source: string; target: string; criticIds: readonly string[] }[];
}
export interface GraphNodePosition { id: string; x: number; y: number; width: number; height: number }
export interface GraphEdgePosition { source: string; target: string; criticIds: string[]; path: string; labelX: number; labelY: number }
export interface GraphLayout { nodes: GraphNodePosition[]; edges: GraphEdgePosition[]; width: number; height: number }

/** Stable snapshot topology determines positions; changing request statuses never moves nodes. */
export function layoutGraph(graph: LayoutGraphInput, vertical = false): GraphLayout {
  const padding = 28, width = 184, height = 112, rankGap = 78, peerGap = 28;
  const order = new Map(graph.artifacts.map((artifact, index) => [artifact.id, index]));
  if (order.size !== graph.artifacts.length) throw new Error('Duplicate Artifact in graph.');
  const edges = new Map<string, { source: string; target: string; criticIds: string[] }>();
  for (const edge of graph.edges) {
    if (!order.has(edge.source) || !order.has(edge.target)) throw new Error('Graph edge references an unknown Artifact.');
    const key = JSON.stringify([edge.source, edge.target]);
    const existing = edges.get(key);
    if (existing) existing.criticIds = [...new Set([...existing.criticIds, ...edge.criticIds])];
    else edges.set(key, { source: edge.source, target: edge.target, criticIds: [...new Set(edge.criticIds)] });
  }
  const incoming = new Map(graph.artifacts.map(artifact => [artifact.id, 0]));
  const outgoing = new Map(graph.artifacts.map(artifact => [artifact.id, [] as string[]]));
  const rank = new Map(graph.artifacts.map(artifact => [artifact.id, 0]));
  for (const edge of edges.values()) {
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const ready = graph.artifacts.filter(artifact => incoming.get(artifact.id) === 0).map(artifact => artifact.id);
  let visited = 0;
  while (ready.length) {
    ready.sort((a, b) => order.get(a)! - order.get(b)!);
    const current = ready.shift()!; visited++;
    for (const target of outgoing.get(current)!) {
      rank.set(target, Math.max(rank.get(target)!, rank.get(current)! + 1));
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) ready.push(target);
    }
  }
  if (visited !== graph.artifacts.length) throw new Error('Artifact graph contains a cycle.');
  if (!graph.artifacts.length) return { nodes: [], edges: [], width: 2 * padding, height: 2 * padding };
  const ranks: string[][] = Array.from({ length: Math.max(...rank.values()) + 1 }, () => []);
  for (const artifact of graph.artifacts) ranks[rank.get(artifact.id)!].push(artifact.id);
  const depthSize = vertical ? height : width, peerSize = vertical ? width : height;
  const maxPeers = Math.max(...ranks.map(layer => layer.length));
  const peerExtent = maxPeers * peerSize + (maxPeers - 1) * peerGap;
  const depthExtent = ranks.length * depthSize + (ranks.length - 1) * rankGap;
  const nodes: GraphNodePosition[] = [];
  for (const [level, artifacts] of ranks.entries()) {
    const extent = artifacts.length * peerSize + (artifacts.length - 1) * peerGap;
    for (const [index, id] of artifacts.entries()) {
      const depth = padding + level * (depthSize + rankGap);
      const peer = padding + (peerExtent - extent) / 2 + index * (peerSize + peerGap);
      nodes.push({ id, x: vertical ? peer : depth, y: vertical ? depth : peer, width, height });
    }
  }
  const positions = new Map(nodes.map(node => [node.id, node]));
  const sortedEdges = [...edges.values()].sort((a, b) => order.get(a.source)! - order.get(b.source)! || order.get(a.target)! - order.get(b.target)!);
  let detours = 0;
  const paths = sortedEdges.map(edge => {
    const source = positions.get(edge.source)!, target = positions.get(edge.target)!;
    const skip = rank.get(edge.target)! - rank.get(edge.source)! > 1;
    if (skip) {
      const lane = padding + peerExtent + 34 + detours++ * 24;
      if (vertical) {
        const sx = source.x + width / 2, sy = source.y + height, tx = target.x + width / 2, ty = target.y - 3;
        const lead = sy + rankGap / 3, end = target.y - rankGap / 3;
        return { ...edge, path: `M ${sx} ${sy} V ${lead} H ${lane} V ${end} H ${tx} V ${ty}`, labelX: lane, labelY: (lead + end) / 2 };
      }
      const sx = source.x + width, sy = source.y + height / 2, tx = target.x - 3, ty = target.y + height / 2;
      const lead = sx + rankGap / 3, end = target.x - rankGap / 3;
      return { ...edge, path: `M ${sx} ${sy} H ${lead} V ${lane} H ${end} V ${ty} H ${tx}`, labelX: (lead + end) / 2, labelY: lane };
    }
    if (vertical) {
      const sx = source.x + width / 2, sy = source.y + height, tx = target.x + width / 2, ty = target.y - 3, middle = (sy + ty) / 2;
      return { ...edge, path: `M ${sx} ${sy} C ${sx} ${middle}, ${tx} ${middle}, ${tx} ${ty}`, labelX: (sx + tx) / 2, labelY: middle };
    }
    const sx = source.x + width, sy = source.y + height / 2, tx = target.x - 3, ty = target.y + height / 2, middle = (sx + tx) / 2;
    return { ...edge, path: `M ${sx} ${sy} C ${middle} ${sy}, ${middle} ${ty}, ${tx} ${ty}`, labelX: middle, labelY: (sy + ty) / 2 };
  });
  const peerCanvas = peerExtent + padding * 2 + (detours ? 34 + (detours - 1) * 24 : 0);
  return { nodes, edges: paths, width: vertical ? peerCanvas : depthExtent + padding * 2, height: vertical ? depthExtent + padding * 2 : peerCanvas };
}
