import { readWorkspaceConfig } from '../broker/config.mjs';

/** Repo-side adapter: prepare explicit envelopes from one prepared workspace definition. */
export async function prepareReviewRequests({ repoPath, repoId = 'demo', snapshotHash, criticId }) {
  if (typeof repoId !== 'string' || !repoId.trim() || repoId.length > 200) throw new Error('A registered repoId is required (maximum 200 characters).');
  if (typeof snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotHash)) throw new Error('snapshotHash must be a full workspace SHA-256 content hash.');
  if (criticId !== undefined && (typeof criticId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(criticId))) {
    throw new Error('criticId must be a non-empty safe Critic identifier.');
  }
  const snapshot = await readWorkspaceConfig(repoPath);
  const critics = criticId === undefined ? snapshot.config.critics : snapshot.config.critics.filter(critic => critic.id === criticId);
  if (!critics.length) throw new Error(`Unknown Critic in the requested snapshot: ${criticId}`);
  return critics.map(critic => structuredClone({
    repoId,
    snapshotHash,
    criticId: critic.id,
    title: critic.title,
    artifacts: critic.artifacts.map(id => ({ id, type: snapshot.config.artifacts[id].type, path: snapshot.config.artifacts[id].path })),
    artifactTypes: snapshot.config.artifactTypes,
    payload: critic.payload,
    profile: critic.profile,
    dependsOn: critic.dependsOn,
  }));
}
