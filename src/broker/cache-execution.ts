import type { ReviewRequest, ReviewEnvelope, WorkspaceDescriptor, RepoConfig } from '../contracts.js';
import type { RunRecord } from './index.js';
import { inputHash } from '../project/identity.js';
import { createGraphDefinition } from './graph.js';

/** One execution owns only its admitted envelope, never the entire caller catalog. */
export function executionRecord(request: ReviewRequest, workspace: WorkspaceDescriptor, id: string, budgetRunId: string, repoExecutorCap?: number): RunRecord {
  const envelope: ReviewEnvelope = { repoId: request.repoId, snapshotHash: request.snapshotHash, criticId: request.criticId, title: request.title,
    artifacts: request.artifacts, references: request.references, requiredObservations: request.requiredObservations,
    configManifest: request.configManifest, payload: request.payload, profile: request.profile, target: request.target, deps: request.deps,
    passSchema: request.passSchema, failSchema: request.failSchema, resultCheck: request.resultCheck };
  const artifacts = Object.fromEntries(request.artifacts.map(({ id, ...artifact }) => [id, artifact]));
  const critic = { id: request.criticId, localId: request.criticId.split('/').at(-1)!, title: request.title,
    target: request.target, deps: request.deps, references: request.references, payload: request.payload, profile: request.profile,
    ...(request.passSchema ? { passSchema: request.passSchema } : {}), ...(request.failSchema ? { failSchema: request.failSchema } : {}),
    ...(request.resultCheck ? { resultCheck: request.resultCheck } : {}) };
  const relations: RepoConfig['relations'] = Object.entries(artifacts).flatMap(([target, artifact]) => [
    ...Object.entries(artifact.children).map(([name, source]) => ({ target, source, kind: 'child' as const, name })),
    ...Object.entries(artifact.mounts).map(([name, source]) => ({ target, source, kind: 'mount' as const, name })),
  ]);
  for (const source of request.deps) relations.push({ target: request.target, source, kind: 'instruction', criticId: request.criticId });
  const input = request.validationInput!;
  const config: RepoConfig = { artifacts, critics: [critic], relations, configManifest: request.configManifest };
  const snapshot = { version: 3 as const, config, snapshotHash: workspace.hash, workspaceIntegrity: workspace.integrity,
    inputs: { [request.criticId]: input }, artifactHashes: Object.fromEntries(request.artifacts.map(artifact => [artifact.id,
      artifact.id === input.target.id ? input.target.hash : input.deps.find(dep => dep.id === artifact.id)?.hash ?? inputHash(artifact)])) };
  return { id, repoId: 'cache-execution', workerProtocol: 'resources-1', executionOwned: true, budgetRunId,
    ...(repoExecutorCap === undefined ? {} : { repoExecutorCap }),
    snapshotHash: workspace.hash, workspace, requesterId: 'identity-cache', scope: { kind: 'project' },
    graph: createGraphDefinition(config, false), project: { version: 3, snapshot, selection: { kind: 'critic', criticId: request.criticId },
      force: true, recursive: false, ignoreGates: true, templates: [envelope] }, status: 'QUEUED', createdAt: new Date().toISOString() };
}
