import { readWorkspaceConfig } from '../broker/config.js';
import { assertArtifactAudience } from '../artifacts/types.js';
import { createArtifactViewer, createArtifactTools } from '../artifacts/index.js';
import { createHumanArtifactTools } from '../artifacts/human.js';
import type { ReviewEnvelope } from '../contracts.js';

/** Repo-side adapter: prepare explicit envelopes from one prepared workspace definition. */
export async function prepareReviewRequests({ repoPath, repoId = 'demo', snapshotHash, criticId, allowLegacyTools = false }: { repoPath: string; repoId?: unknown; snapshotHash: unknown; criticId?: unknown; allowLegacyTools?: boolean }): Promise<ReviewEnvelope[]> {
  if (typeof repoId !== 'string' || !repoId.trim() || repoId.length > 200) throw new Error('A registered repoId is required (maximum 200 characters).');
  if (typeof snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotHash)) throw new Error('snapshotHash must be a full workspace SHA-256 content hash.');
  if (criticId !== undefined && (typeof criticId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(criticId))) {
    throw new Error('criticId must be a non-empty safe Critic identifier.');
  }
  const snapshot = await readWorkspaceConfig(repoPath);
  const critics = criticId === undefined ? snapshot.config.critics : snapshot.config.critics.filter(critic => critic.id === criticId);
  if (!critics.length) throw new Error(`Unknown Critic in the requested snapshot: ${criticId}`);
  const requests: ReviewEnvelope[] = critics.map(critic => structuredClone({
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
  for (const request of requests) {
    if (request.profile.kind === 'runtime') continue;
    assertArtifactAudience(request, { allowLegacy: allowLegacyTools });
    const tools = request.profile.kind === 'human'
      ? (await createHumanArtifactTools({ worktreePath: repoPath, artifacts: request.artifacts, artifactTypes: request.artifactTypes, allowLegacy: allowLegacyTools })).tools
      : createArtifactTools(await createArtifactViewer({ worktreePath: repoPath, artifacts: request.artifacts, artifactTypes: request.artifactTypes })).tools;
    for (const artifact of request.artifacts) {
      if (!tools.some(tool => 'artifactId' in tool ? tool.artifactId === artifact.id : tool.name === `read_${artifact.id}` || tool.name === `list_${artifact.id}`)) {
        throw new Error(`Artifact ${artifact.id} has no usable ${request.profile.kind} tools for its file or directory shape.`);
      }
    }
  }
  return requests;
}
