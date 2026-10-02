import type { ArtifactStatus, GraphArtifactState, GraphProjection } from '../../broker/graph.js';

export interface FamilyGroup { name: string; path: string; members: GraphArtifactState[] }
export interface GroupedGraph {
  artifacts: GraphArtifactState[];
  edges: GraphProjection['edges'];
  /** Collapsed families by name; their node shares the family name, which no Artifact may reuse. */
  groups: Map<string, FamilyGroup>;
  /** The displayed node that holds an Artifact: its collapsed family, or the Artifact itself. */
  nodeOf(id: string): string;
}

// The most urgent member state represents the whole family, as an Artifact's own Critics do.
const urgent: ArtifactStatus[] = ['ERROR', 'RED', 'BLOCKED', 'RUNNING', 'WAITING_HUMAN', 'QUEUED', 'WAIT_DEPENDENCY'];
export function familyStatus(members: readonly GraphArtifactState[]): ArtifactStatus {
  const found = urgent.find(status => members.some(member => member.status === status));
  if (found) return found;
  if (members.every(member => member.status === 'BASIS')) return 'BASIS';
  return members.every(member => member.status === 'GREEN' || member.status === 'BASIS') ? 'GREEN' : 'UNREVIEWED';
}

/** Collapse each family that is not expanded into one node. Relations to members become relations to that node. */
export function groupFamilies(graph: GraphProjection, expanded: ReadonlySet<string> = new Set()): GroupedGraph {
  const groups = new Map<string, FamilyGroup>(), family = new Map<string, string>();
  for (const artifact of graph.artifacts) {
    if (!artifact.family || expanded.has(artifact.family)) continue;
    const group = groups.get(artifact.family) ?? { name: artifact.family, path: artifact.path, members: [] };
    group.members.push(artifact); groups.set(artifact.family, group); family.set(artifact.id, artifact.family);
  }
  const nodeOf = (id: string): string => family.get(id) ?? id;
  const artifacts = graph.artifacts.filter(artifact => !family.has(artifact.id));
  for (const group of groups.values()) {
    const { members } = group, sum = (key: 'passed' | 'total' | 'included') => members.reduce((total, member) => total + member[key], 0);
    const validation = (['INCOMPLETE', 'STALE'] as const).find(status => members.some(member => member.validationStatus === status));
    artifacts.push({ id: group.name, path: group.path, basis: members.every(member => member.basis), status: familyStatus(members), family: group.name,
      mounts: {}, children: {}, criticIds: [], passed: sum('passed'), total: sum('total'), included: sum('included'), ...(validation ? { validationStatus: validation } : {}) });
  }
  const edges = new Map<string, GraphProjection['edges'][number]>();
  for (const edge of graph.edges) {
    const source = nodeOf(edge.source), target = nodeOf(edge.target);
    // Relations among members of one collapsed family stay visible when it is expanded.
    if (source === target && source !== edge.source) continue;
    const key = JSON.stringify([source, target]), merged = edges.get(key) ?? { source, target, criticIds: [], relations: [], cyclic: false };
    merged.relations.push(...edge.relations); merged.cyclic ||= edge.cyclic;
    for (const id of edge.criticIds) if (!merged.criticIds.includes(id)) merged.criticIds.push(id);
    edges.set(key, merged);
  }
  return { artifacts, edges: [...edges.values()], groups, nodeOf };
}
