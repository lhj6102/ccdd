import { readSnapshotConfig } from '../broker/config.mjs';

/** Repo-side adapter: prepare explicit review envelopes from one committed definition. */
export async function prepareReviewRequests({ repoPath, repoId = 'demo', snapshotCommit, criticId }) {
  if (typeof repoId !== 'string' || !repoId.trim() || repoId.length > 200) throw new Error('A registered repoId is required (maximum 200 characters).');
  if (criticId !== undefined && (typeof criticId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(criticId))) {
    throw new Error('criticId must be a non-empty safe Critic identifier.');
  }
  const snapshot = await readSnapshotConfig(repoPath, snapshotCommit);
  const critics = criticId === undefined ? snapshot.config.critics : snapshot.config.critics.filter(critic => critic.id === criticId);
  if (!critics.length) throw new Error(`Unknown Critic in the requested snapshot: ${criticId}`);
  return critics.map(critic => structuredClone({
    repoId,
    snapshotCommit: snapshot.snapshotCommit,
    criticId: critic.id,
    title: critic.title,
    artifacts: critic.artifacts.map(id => ({ id, type: snapshot.config.artifacts[id].type, path: snapshot.config.artifacts[id].path })),
    artifactTypes: snapshot.config.artifactTypes,
    payload: critic.payload,
    profile: critic.profile,
    dependsOn: critic.dependsOn,
  }));
}
