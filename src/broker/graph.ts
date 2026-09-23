import type { ArtifactDefinition, ArtifactRelation, CriticProfile, RepoConfig, ReviewStatus } from '../contracts.js';
import type { ValidationStatus } from '../project/types.js';

export interface GraphCriticDefinition { id: string; title: string; target: string; deps: string[]; kind: CriticProfile['kind'] }
export interface GraphDefinition { version: 2; artifacts: Record<string, ArtifactDefinition>; critics: GraphCriticDefinition[]; relations: ArtifactRelation[] }
export type ArtifactStatus = 'BASIS' | 'UNREVIEWED' | ReviewStatus;
export interface GraphRequest { id: string; criticId: string; status: ReviewStatus; claimedBy?: string | null; blockedReason?: string | null }
export interface GraphArtifactState {
  id: string; path: string; basis: boolean; status: ArtifactStatus;
  mounts: Record<string, string>; children: Record<string, string>;
  criticIds: string[]; passed: number; total: number; included: number; validationStatus?: ValidationStatus;
}
export interface GraphCriticState extends GraphCriticDefinition { requestId: string | null; status: ReviewStatus | null; claimedBy: string | null; blockedReason: string | null; validationStatus?: ValidationStatus; validationReason?: string; reusedFrom?: { requestId: string; runId: string; completedAt: string } }
export interface GraphProjection { artifacts: GraphArtifactState[]; critics: GraphCriticState[]; edges: { source: string; target: string; criticIds: string[]; relations: ArtifactRelation[]; cyclic: boolean }[] }

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const qualified = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Static graph metadata only. Cycles express shared validation obligations, never scheduling gates. */
export function validateGraphDefinition(value: unknown): asserts value is GraphDefinition {
  if (!object(value) || value.version !== 2 || !object(value.artifacts) || !Array.isArray(value.critics) || !Array.isArray(value.relations)) throw new Error('Invalid Artifact graph definition.');
  for (const [id, artifact] of Object.entries(value.artifacts)) {
    if (!identifier.test(id) || !object(artifact) || artifact.name !== id || typeof artifact.path !== 'string' || !object(artifact.views) || !object(artifact.children) || !object(artifact.mounts)) throw new Error('Invalid folder Artifact.');
  }
  const seen = new Set<string>();
  for (const critic of value.critics) {
    if (!object(critic) || !qualified.test(critic.id) || seen.has(critic.id) || typeof critic.title !== 'string' || !Object.hasOwn(value.artifacts, critic.target) || !Array.isArray(critic.deps) || critic.deps.some((id: string) => !Object.hasOwn(value.artifacts, id)) || !['agent', 'human', 'runtime'].includes(critic.kind)) throw new Error('Invalid owned Critic.');
    seen.add(critic.id);
    if (value.artifacts[critic.target].basis) throw new Error('Basis Artifacts cannot own Critics.');
  }
  for (const relation of value.relations) if (!object(relation) || !Object.hasOwn(value.artifacts, relation.source) || !Object.hasOwn(value.artifacts, relation.target) || !['child', 'mount', 'instruction'].includes(relation.kind)) throw new Error('Invalid Artifact relation.');
}

export function createGraphDefinition(config: RepoConfig): GraphDefinition {
  const graph: GraphDefinition = { version: 2, artifacts: structuredClone(config.artifacts), relations: structuredClone(config.relations),
    critics: config.critics.map(critic => ({ id: critic.id, title: critic.title, target: critic.target, deps: [...critic.deps], kind: critic.profile.kind })) };
  validateGraphDefinition(graph);
  return graph;
}

/** Tarjan components turn a cyclic Artifact graph into a finite condensation graph. */
export function stronglyConnectedComponents(ids: readonly string[], relations: readonly ArtifactRelation[]): string[][] {
  const next = new Map(ids.map(id => [id, new Set<string>()]));
  for (const edge of relations) next.get(edge.target)!.add(edge.source);
  let index = 0;
  const indices = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], active = new Set<string>(), components: string[][] = [];
  const visit = (id: string): void => {
    indices.set(id, index); low.set(id, index++); stack.push(id); active.add(id);
    for (const dependency of [...next.get(id)!].sort()) {
      if (!indices.has(dependency)) { visit(dependency); low.set(id, Math.min(low.get(id)!, low.get(dependency)!)); }
      else if (active.has(dependency)) low.set(id, Math.min(low.get(id)!, indices.get(dependency)!));
    }
    if (low.get(id) === indices.get(id)) {
      const component: string[] = [];
      let member: string;
      do { member = stack.pop()!; active.delete(member); component.push(member); } while (member !== id);
      components.push(component.sort());
    }
  };
  for (const id of [...ids].sort()) if (!indices.has(id)) visit(id);
  return components;
}

/** Stored results remain inspectable without consulting or executing a workspace. */
export function projectGraph(graph: GraphDefinition, requests: readonly GraphRequest[]): GraphProjection {
  validateGraphDefinition(graph);
  const byCritic = new Map(requests.map(request => [request.criticId, request]));
  const critics = graph.critics.map((critic): GraphCriticState => {
    const request = byCritic.get(critic.id);
    return { ...critic, requestId: request?.id ?? null, status: request?.status ?? null, claimedBy: request?.claimedBy ?? null, blockedReason: request?.blockedReason ?? null };
  });
  const artifacts = Object.entries(graph.artifacts).map(([id, artifact]): GraphArtifactState => {
    const own = critics.filter(critic => critic.target === id), passed = own.filter(critic => critic.status === 'GREEN').length;
    const status: ArtifactStatus = artifact.basis ? 'BASIS' : own.length && passed === own.length ? 'GREEN' :
      (['ERROR', 'RED', 'RUNNING', 'WAITING_HUMAN', 'QUEUED'] as const).find(candidate => own.some(critic => critic.status === candidate)) ?? 'UNREVIEWED';
    return { id, path: artifact.path, children: artifact.children, mounts: artifact.mounts, basis: artifact.basis === true, status,
      criticIds: own.map(critic => critic.id), passed, total: own.length, included: own.filter(critic => critic.requestId !== null).length };
  });
  const components = stronglyConnectedComponents(Object.keys(graph.artifacts), graph.relations), componentOf = new Map(components.flatMap((members, index) => members.map(id => [id, index] as const)));
  const edges = new Map<string, GraphProjection['edges'][number]>();
  for (const relation of graph.relations) {
    const key = `${relation.source}/${relation.target}`, edge = edges.get(key) ?? { source: relation.source, target: relation.target, criticIds: [], relations: [], cyclic: componentOf.get(relation.source) === componentOf.get(relation.target) };
    edge.relations.push(relation);
    if (relation.criticId && !edge.criticIds.includes(relation.criticId)) edge.criticIds.push(relation.criticId);
    edges.set(key, edge);
  }
  return { artifacts, critics, edges: [...edges.values()] };
}
