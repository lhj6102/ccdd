import type { ArtifactDefinition, CriticProfile, RepoConfig, ReviewEnvelope, ReviewStatus } from '../contracts.js';

export interface GraphCriticDefinition { id: string; title: string; target: string; deps: string[]; kind: CriticProfile['kind'] }
export interface GraphDefinition { version: 1; artifacts: Record<string, ArtifactDefinition>; critics: GraphCriticDefinition[] }
export type ArtifactStatus = 'BASIS' | 'UNREVIEWED' | ReviewStatus;
export interface GraphRequest { id: string; criticId: string; status: ReviewStatus; claimedBy?: string | null; blockedReason?: string | null }
export interface GraphArtifactState {
  id: string; type: string; path: string; basis: boolean; status: ArtifactStatus;
  criticIds: string[]; passed: number; total: number; included: number;
}
export interface GraphCriticState extends GraphCriticDefinition { requestId: string | null; status: ReviewStatus | null; claimedBy: string | null; blockedReason: string | null }
export interface GraphProjection { artifacts: GraphArtifactState[]; critics: GraphCriticState[]; edges: { source: string; target: string; criticIds: string[] }[] }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const statuses = new Set(['BLOCKED', 'QUEUED', 'RUNNING', 'WAITING_HUMAN', 'GREEN', 'RED', 'ERROR']);

/** Validate only the immutable graph metadata; no payloads, providers or workspace reads. */
export function validateGraphDefinition(value: unknown): asserts value is GraphDefinition {
  if (!object(value) || value.version !== 1 || !object(value.artifacts) || !Array.isArray(value.critics) || !value.critics.length || value.critics.length > 32) throw new Error('Invalid Artifact graph definition.');
  const artifacts = value.artifacts;
  for (const [id, artifact] of Object.entries(artifacts)) {
    if (!identifier.test(id) || !object(artifact) || typeof artifact.type !== 'string' || !artifact.type || typeof artifact.path !== 'string' || !artifact.path || (artifact.basis !== undefined && typeof artifact.basis !== 'boolean')) throw new Error(`Invalid graph Artifact: ${id}`);
  }
  const seen = new Set<string>();
  const targets = new Set<string>();
  const adjacency = new Map(Object.keys(artifacts).map(id => [id, new Set<string>()]));
  for (const critic of value.critics) {
    if (!object(critic) || typeof critic.id !== 'string' || !identifier.test(critic.id) || seen.has(critic.id) || typeof critic.title !== 'string' || !critic.title.trim() || typeof critic.target !== 'string' || !Object.hasOwn(artifacts, critic.target) || !Array.isArray(critic.deps) || new Set(critic.deps).size !== critic.deps.length || critic.deps.some(dep => typeof dep !== 'string' || !Object.hasOwn(artifacts, dep)) || !['agent', 'human', 'runtime'].includes(String(critic.kind))) throw new Error('Critics require unique IDs, one known target, and unique known deps.');
    if (critic.deps.includes(critic.target)) throw new Error(`Critic ${critic.id} cannot include its target in deps; target access is already provided.`);
    seen.add(critic.id); targets.add(critic.target);
    for (const dep of critic.deps as string[]) adjacency.get(dep)!.add(critic.target);
  }
  for (const id of targets) if ((artifacts[id] as ArtifactDefinition).basis) throw new Error(`Basis Artifact ${id} cannot also be a Critic target.`);
  for (const critic of value.critics as unknown as GraphCriticDefinition[]) {
    for (const dep of critic.deps) if (!targets.has(dep) && !(artifacts[dep] as ArtifactDefinition).basis) throw new Error(`Dependency Artifact ${dep} has no Critic. Declare basis: true if it is an accepted review basis.`);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Artifact dependencies must form a DAG; cycle includes ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id)!) visit(next);
    visiting.delete(id); visited.add(id);
  };
  for (const id of adjacency.keys()) visit(id);
}

export function createGraphDefinition(config: RepoConfig): GraphDefinition {
  const graph: GraphDefinition = {
    version: 1,
    artifacts: Object.fromEntries(Object.entries(config.artifacts).map(([id, artifact]) => [id, { type: artifact.type, path: artifact.path, ...(artifact.basis === undefined ? {} : { basis: artifact.basis }) }])),
    critics: config.critics.map(critic => ({ id: critic.id, title: critic.title, target: critic.target, deps: [...critic.deps], kind: critic.profile.kind })),
  };
  validateGraphDefinition(graph);
  return graph;
}

export function prerequisiteCriticIds(request: Pick<ReviewEnvelope, 'deps'>, graph: GraphDefinition): string[] {
  return graph.critics.filter(critic => request.deps.includes(critic.target)).map(critic => critic.id);
}

/** Call with requests from exactly one Run. Missing evaluations never count as passing. */
export function projectGraph(graph: GraphDefinition, requests: readonly GraphRequest[]): GraphProjection {
  validateGraphDefinition(graph);
  const byCritic = new Map<string, GraphRequest>();
  for (const request of requests) {
    if (!graph.critics.some(critic => critic.id === request.criticId) || byCritic.has(request.criticId) || !statuses.has(request.status)) throw new Error('Graph requests must be unique evaluations from one Run.');
    byCritic.set(request.criticId, request);
  }
  const critics: GraphCriticState[] = graph.critics.map(critic => {
    const request = byCritic.get(critic.id);
    return { id: critic.id, title: critic.title, target: critic.target, deps: [...critic.deps], kind: critic.kind, requestId: request?.id ?? null, status: request?.status ?? null, claimedBy: request?.claimedBy ?? null, blockedReason: request?.blockedReason ?? null };
  });
  const artifacts = Object.entries(graph.artifacts).map(([id, artifact]): GraphArtifactState => {
    const own = critics.filter(critic => critic.target === id), included = own.filter(critic => critic.requestId !== null).length;
    const passed = own.filter(critic => critic.status === 'GREEN').length;
    let status: ArtifactStatus = artifact.basis ? 'BASIS' : 'UNREVIEWED';
    if (own.length) {
      if (passed === own.length) status = 'GREEN';
      else status = (['ERROR', 'RED', 'RUNNING', 'WAITING_HUMAN', 'QUEUED', 'BLOCKED'] as const).find(candidate => own.some(critic => critic.status === candidate)) ?? 'UNREVIEWED';
    }
    return { id, type: artifact.type, path: artifact.path, basis: artifact.basis === true, status, criticIds: own.map(critic => critic.id), passed, total: own.length, included };
  });
  const edges = new Map<string, GraphProjection['edges'][number]>();
  for (const critic of critics) for (const source of critic.deps) {
    const key = `${source}/${critic.target}`, edge = edges.get(key) ?? { source, target: critic.target, criticIds: [] };
    edge.criticIds.push(critic.id); edges.set(key, edge);
  }
  return { artifacts, critics, edges: [...edges.values()] };
}
