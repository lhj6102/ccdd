import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readWorkspaceConfig, validateRelativePath } from '../broker/config.js';
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
    artifacts: [critic.target, ...critic.deps].map(id => ({ id, type: snapshot.config.artifacts[id].type, path: snapshot.config.artifacts[id].path })),
    artifactTypes: snapshot.config.artifactTypes,
    payload: critic.payload,
    profile: critic.profile,
    target: critic.target,
    deps: critic.deps,
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

/** Reopen the declared observation scope of a stored review, including historical snapshots.
 * This is never used for admission, scheduling or inferring a legacy target. */
export async function readStoredArtifactScope({ repoPath, criticId }: { repoPath: string; criticId: string }): Promise<Pick<ReviewEnvelope, 'artifacts' | 'artifactTypes' | 'profile'>> {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const raw: unknown = JSON.parse(await readFile(join(repoPath, 'ccdd.config.json'), 'utf8'));
  if (!object(raw) || !object(raw.artifacts) || !object(raw.artifactTypes) || !Array.isArray(raw.critics)) throw new Error('Invalid stored Artifact configuration.');
  const matches = raw.critics.filter(critic => object(critic) && critic.id === criticId);
  if (matches.length !== 1 || !object(matches[0])) throw new Error('Unknown stored Critic.');
  const critic = matches[0];
  if (!object(critic.profile) || !['agent', 'runtime', 'human'].includes(String(critic.profile.kind))) throw new Error('Invalid stored Critic profile.');
  const legacy = !Object.hasOwn(critic, 'target') && Object.hasOwn(critic, 'dependsOn');
  let ids: unknown;
  if (legacy) ids = critic.artifacts;
  else {
    const { config } = await readWorkspaceConfig(repoPath);
    const definition = config.critics.find(item => item.id === criticId)!;
    ids = [definition.target, ...definition.deps];
  }
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !Object.hasOwn(raw.artifacts as object, id))) throw new Error('Invalid stored Artifact references.');
  const definitions = raw.artifacts;
  const artifacts = (ids as string[]).map(id => {
    const artifact = definitions[id];
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !object(artifact) || typeof artifact.type !== 'string' || !Object.hasOwn(raw.artifactTypes as object, artifact.type)) throw new Error('Invalid stored Artifact definition.');
    return { id, type: artifact.type, path: validateRelativePath(artifact.path) };
  });
  const scope = { artifacts, artifactTypes: raw.artifactTypes as ReviewEnvelope['artifactTypes'], profile: critic.profile as unknown as ReviewEnvelope['profile'] };
  await createArtifactViewer({ worktreePath: repoPath, artifacts: scope.artifacts, artifactTypes: scope.artifactTypes });
  return scope;
}
