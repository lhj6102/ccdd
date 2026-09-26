import { readWorkspaceConfig, criticIdentifier } from '../broker/config.js';
import { assertArtifactAudience } from '../artifacts/types.js';
import type { ReviewEnvelope, RepoConfig } from '../contracts.js';
import { scopeToolManifest } from '../tools/manifest.js';
import { resolveArtifactScope } from '../artifacts/scope.js';

/** Bind requests to exact scope. copy=false is only for Broker-owned submission data; public/default envelopes remain detached. */
export async function prepareReviewRequests({ repoPath, repoId = 'local', snapshotHash, criticId, preparedConfig, copy = true }: { repoPath: string; repoId?: unknown; snapshotHash: unknown; criticId?: unknown; preparedConfig?: RepoConfig; copy?: boolean }): Promise<ReviewEnvelope[]> {
  if (typeof repoId !== 'string' || !repoId.trim() || repoId.length > 200) throw new Error('A registered repoId is required (maximum 200 characters).');
  if (typeof snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotHash)) throw new Error('snapshotHash must be a full workspace SHA-256 content hash.');
  if (criticId !== undefined && (typeof criticId !== 'string' || !criticIdentifier.test(criticId))) throw new Error('Use an Artifact/local-Critic identifier.');
  const config = preparedConfig ?? (await readWorkspaceConfig(repoPath)).config;
  const critics = criticId === undefined ? config.critics : config.critics.filter(c => c.id === criticId);
  if (criticId !== undefined && !critics.length) throw new Error(`Unknown Critic: ${criticId}`);
  return critics.map(critic => {
    const scope = resolveArtifactScope(config.artifacts, [critic.target, ...critic.deps], copy);
    const source: ReviewEnvelope = { repoId, snapshotHash, criticId: critic.id, title: critic.title,
      ...scope, configManifest: scopeToolManifest(config.configManifest, scope.artifacts.map(artifact => artifact.id)),
      references: critic.references, requiredObservations: [critic.target, ...critic.deps],
      payload: critic.payload, ...(critic.passSchema ? { passSchema: critic.passSchema } : {}), ...(critic.failSchema ? { failSchema: critic.failSchema } : {}), profile: critic.profile, target: critic.target, deps: critic.deps };
    const request = copy ? structuredClone(source) : source;
    assertArtifactAudience(request);
    return request;
  });
}
