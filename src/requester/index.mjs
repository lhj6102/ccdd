import { readSnapshotConfig } from '../broker/config.mjs';

/** Repo-side adapter: prepare explicit review envelopes from one committed definition. */
export async function prepareReviewRequests({ repoPath, repoId = 'demo', snapshotCommit }) {
  if (typeof repoId !== 'string' || !repoId.trim() || repoId.length > 200) throw new Error('A registered repoId is required (maximum 200 characters).');
  const snapshot = await readSnapshotConfig(repoPath, snapshotCommit);
  return snapshot.config.critics.map(critic => structuredClone({
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
