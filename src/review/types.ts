import type { ReviewEnvelope, ReviewRequest } from '../contracts.js';
import { packageVersion } from '../runtime-paths.js';

/** Portable review data contains no publisher paths, credentials or worker state. */
export interface PortableReview extends ReviewEnvelope {
  id: string;
  runId: string;
  packageVersion: string;
  claimedBy: string | null;
  claimAttemptId?: string;
}

export function portableReview(request: ReviewRequest): PortableReview {
  if (request.profile.kind !== 'human' || request.workspace.mode !== 'copy' || !request.configManifest) {
    throw new Error('Remote review requires a copy-mode Human request with a TypeScript tool manifest.');
  }
  return {
    id: request.id, runId: request.runId, repoId: request.repoId,
    snapshotHash: request.snapshotHash, criticId: request.criticId, title: request.title,
    target: request.target, deps: request.deps, artifacts: request.artifacts,
    ...(request.artifactGroups ? { artifactGroups: request.artifactGroups } : {}),
    artifactTypes: request.artifactTypes, configManifest: request.configManifest,
    payload: { instruction: request.payload.instruction }, profile: { kind: 'human' },
    packageVersion, claimedBy: request.claimedBy ?? null,
    ...(request.claimAttemptId ? { claimAttemptId: request.claimAttemptId } : {}),
  };
}
