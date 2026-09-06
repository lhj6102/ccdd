import type { ELK, ELKConstructorArguments, ElkNode } from 'elkjs/lib/elk-api.js';

export interface LayoutGraphInput {
  artifacts: readonly { id: string; criticIds?: readonly string[] }[];
  edges: readonly { source: string; target: string; criticIds: readonly string[] }[];
}
export interface GraphPoint { x: number; y: number }
export interface GraphNodePosition {
  id: string; x: number; y: number; width: number; height: number;
  sourcePort: GraphPoint; targetPort: GraphPoint;
}
export interface GraphEdgePosition {
  source: string; target: string; criticIds: string[];
  /** ELK's obstacle-avoiding route, including the fixed source and target ports. */
  points: GraphPoint[];
  path: string; labelX: number; labelY: number;
}
export interface GraphLayout { nodes: GraphNodePosition[]; edges: GraphEdgePosition[]; width: number; height: number }

const padding = 28, nodeWidth = 208;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const distinct = (values: readonly string[]): string[] => [...new Set(values)].sort(compare);

/** Only topology and registered Critic counts affect geometry, never live review state. */
export async function layoutGraph(graph: LayoutGraphInput, vertical = false, signal?: AbortSignal): Promise<GraphLayout> {
  signal?.throwIfAborted();
  const artifacts = [...graph.artifacts].sort((a, b) => compare(a.id, b.id));
  const ids = new Set(artifacts.map(artifact => artifact.id));
  if (ids.size !== artifacts.length) throw new Error('Duplicate Artifact in graph.');
  const relations = new Map<string, { source: string; target: string; criticIds: string[] }>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error('Graph edge references an unknown Artifact.');
    const key = JSON.stringify([edge.source, edge.target]), previous = relations.get(key);
    relations.set(key, { source: edge.source, target: edge.target, criticIds: distinct([...(previous?.criticIds ?? []), ...edge.criticIds]) });
  }
  const edges = [...relations.values()].sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target));
  validateDag(artifacts, edges);
  if (!artifacts.length) return { nodes: [], edges: [], width: padding * 2, height: padding * 2 };

  // Internal identifiers prevent Artifact names from colliding with port or root IDs.
  const internalIds = new Map(artifacts.map((artifact, index) => [artifact.id, `artifact-${index}`]));
  const shapes = artifacts.map(artifact => {
    const width = nodeWidth, height = Math.max(112, 80 + Math.ceil((artifact.criticIds?.length ?? 0) / 5) * 34);
    const sourcePort = vertical ? { x: width / 2, y: height } : { x: width, y: height / 2 };
    const targetPort = vertical ? { x: width / 2, y: 0 } : { x: 0, y: height / 2 };
    return { id: artifact.id, width, height, sourcePort, targetPort };
  });
  const result = await runElk({
    id: 'artifact-graph',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': vertical ? 'DOWN' : 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL', 'elk.randomSeed': '1',
      'elk.padding': `[top=${padding},left=${padding},bottom=${padding},right=${padding}]`,
      'elk.spacing.nodeNode': '44', 'elk.spacing.edgeNode': '24',
      'elk.spacing.edgeEdge': '18', 'elk.spacing.componentComponent': '56',
      'elk.layered.spacing.nodeNodeBetweenLayers': '104',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '18',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: shapes.map(shape => {
      const id = internalIds.get(shape.id)!;
      return {
        id, width: shape.width, height: shape.height,
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
        ports: [
          { id: `${id}:in`, ...shape.targetPort, width: 0, height: 0, layoutOptions: { 'elk.port.side': vertical ? 'NORTH' : 'WEST' } },
          { id: `${id}:out`, ...shape.sourcePort, width: 0, height: 0, layoutOptions: { 'elk.port.side': vertical ? 'SOUTH' : 'EAST' } },
        ],
      };
    }),
    edges: edges.map((edge, index) => ({ id: `relation-${index}`, sources: [`${internalIds.get(edge.source)}:out`], targets: [`${internalIds.get(edge.target)}:in`] })),
  }, signal);
  const laidOut = new Map(result.children?.map(node => [node.id, node]));
  const nodes = shapes.map(shape => {
    const node = laidOut.get(internalIds.get(shape.id)!);
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) throw new Error('Artifact layout did not return a node position.');
    return { ...shape, x: node.x!, y: node.y! };
  });
  const positions = new Map(nodes.map(node => [node.id, node]));
  const routes = new Map(result.edges?.map(edge => [edge.id, edge]));
  const paths = edges.map((edge, index) => {
    const sections = routes.get(`relation-${index}`)?.sections;
    if (sections?.length !== 1) throw new Error('Artifact layout did not return a connected edge route.');
    const section = sections[0], points = simplify([section.startPoint, ...section.bendPoints ?? [], section.endPoint]);
    const source = positions.get(edge.source)!, target = positions.get(edge.target)!;
    const start = points[0], end = points[points.length - 1];
    const forward = vertical ? end.y > start.y : end.x > start.x;
    // A cubic lies within its control-point bounds. Use it only when that entire
    // corridor is clear, otherwise preserve ELK's route around intervening nodes.
    const clear = forward && !nodes.some(node => node !== source && node !== target && intersectsBounds(start, end, node, 12));
    if (clear) {
      const c1 = vertical ? { x: start.x, y: (start.y + end.y) / 2 } : { x: (start.x + end.x) / 2, y: start.y };
      const c2 = vertical ? { x: end.x, y: c1.y } : { x: c1.x, y: end.y };
      return { ...edge, points, path: `M ${point(start)} C ${point(c1)} ${point(c2)} ${point(end)}`, labelX: (start.x + end.x) / 2, labelY: (start.y + end.y) / 2 };
    }
    const label = middleOfRoute(points);
    return { ...edge, points, path: roundedPath(points, nodes), labelX: label.x, labelY: label.y };
  });
  const allPoints = paths.flatMap(edge => edge.points);
  return {
    nodes, edges: paths,
    width: Math.max(result.width ?? 0, ...nodes.map(node => node.x + node.width + padding), ...allPoints.map(p => p.x + padding)),
    height: Math.max(result.height ?? 0, ...nodes.map(node => node.y + node.height + padding), ...allPoints.map(p => p.y + padding)),
  };
}

function validateDag(artifacts: readonly { id: string }[], edges: readonly { source: string; target: string }[]): void {
  const incoming = new Map(artifacts.map(artifact => [artifact.id, 0]));
  const outgoing = new Map(artifacts.map(artifact => [artifact.id, [] as string[]]));
  for (const edge of edges) {
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const ready = artifacts.filter(artifact => !incoming.get(artifact.id)).map(artifact => artifact.id);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor++) {
    visited++;
    for (const target of outgoing.get(ready[cursor])!) {
      const count = incoming.get(target)! - 1;
      incoming.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  if (visited !== artifacts.length) throw new Error('Artifact graph contains a cycle.');
}

async function runElk(graph: ElkNode, signal?: AbortSignal): Promise<ElkNode> {
  if (typeof Worker === 'undefined') {
    // elkjs publishes a CommonJS constructor with ESM-shaped declarations.
    const Elk = (await import('elkjs/lib/elk.bundled.js')).default as unknown as new (options?: ELKConstructorArguments) => ELK;
    signal?.throwIfAborted();
    const result = await new Elk({ algorithms: ['layered'] }).layout(graph);
    signal?.throwIfAborted();
    return result;
  }
  const Elk = (await import('elkjs/lib/elk-api.js')).default as unknown as new (options?: ELKConstructorArguments) => ELK;
  signal?.throwIfAborted();
  // Use ELK's split API/worker protocol. The bundled fake-worker constructor is
  // intended for non-worker contexts and cannot be constructed inside a Worker.
  const worker = new Worker(new URL('./graph-layout-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<ElkNode>((resolve, reject) => {
    const finish = (): void => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); worker.terminate(); };
    const abort = (): void => { finish(); reject(signal!.reason); };
    const timeout = setTimeout(() => { finish(); reject(new Error('Artifact layout timed out.')); }, 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = (): void => { finish(); reject(new Error('Artifact layout worker failed.')); };
    worker.onmessageerror = (): void => { finish(); reject(new Error('Artifact layout could not be read.')); };
    try {
      const elk = new Elk({ algorithms: ['layered'], workerFactory: () => worker });
      void elk.layout(graph).then(result => { finish(); resolve(result); }, error => { finish(); reject(error); });
    } catch (error) { finish(); reject(error); }
  });
}

function point(p: GraphPoint): string { return `${p.x} ${p.y}`; }
function distance(a: GraphPoint, b: GraphPoint): number { return Math.hypot(b.x - a.x, b.y - a.y); }
function towards(a: GraphPoint, b: GraphPoint, amount: number): GraphPoint {
  const ratio = amount / distance(a, b);
  return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
}
function intersectsBounds(a: GraphPoint, b: GraphPoint, node: GraphNodePosition, margin = 0): boolean {
  return Math.max(a.x, b.x) > node.x - margin && Math.min(a.x, b.x) < node.x + node.width + margin
    && Math.max(a.y, b.y) > node.y - margin && Math.min(a.y, b.y) < node.y + node.height + margin;
}
function simplify(route: GraphPoint[]): GraphPoint[] {
  const points: GraphPoint[] = [];
  for (const p of route) {
    const previous = points[points.length - 1];
    if (previous?.x === p.x && previous.y === p.y) continue;
    const before = points[points.length - 2];
    if (before && ((before.x === previous.x && previous.x === p.x) || (before.y === previous.y && previous.y === p.y))) points.pop();
    points.push({ x: p.x, y: p.y });
  }
  return points;
}
function roundedPath(points: GraphPoint[], nodes: GraphNodePosition[]): string {
  let path = `M ${point(points[0])}`;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1], corner = points[index], next = points[index + 1];
    let radius = Math.min(18, distance(previous, corner) / 2, distance(corner, next) / 2);
    let entry = towards(corner, previous, radius), exit = towards(corner, next, radius);
    while (radius > 0.5 && nodes.some(node => intersectsBounds(entry, exit, node, 4))) {
      radius /= 2; entry = towards(corner, previous, radius); exit = towards(corner, next, radius);
    }
    path += radius > 0.5 ? ` L ${point(entry)} Q ${point(corner)} ${point(exit)}` : ` L ${point(corner)}`;
  }
  return `${path} L ${point(points[points.length - 1])}`;
}
function middleOfRoute(points: GraphPoint[]): GraphPoint {
  const lengths = points.slice(1).map((p, index) => distance(points[index], p));
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let index = 0; index < lengths.length; index++) {
    if (remaining <= lengths[index]) return towards(points[index], points[index + 1], remaining);
    remaining -= lengths[index];
  }
  return points[points.length - 1];
}
