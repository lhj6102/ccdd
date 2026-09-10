import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ReviewEnvelope, WorkspaceDescriptor } from '../contracts.js';
import { reopenWorkspace } from '../workspaces/index.js';
import { createReviewTools } from '../tools/runner.js';
import { checkEnvironmentRequirements } from '../tools/environment.js';
import { readStoredArtifactScope } from '../requester/index.js';

export interface HumanPreparation {
  snapshotHash: string;
  configHash?: string;
  environment: { id: string; ok: boolean; message: string }[];
  tools: { toolName: string; artifactId: string; ok: boolean; message: string }[];
}

/** A claimant prepares the fixed input on the machine that will run its tools. */
export async function prepareHumanReview(request: ReviewEnvelope, workspace: WorkspaceDescriptor, outputDir: string, signal?: AbortSignal): Promise<HumanPreparation> {
  if (request.profile.kind !== 'human' || workspace.hash !== request.snapshotHash) throw new Error('Human preparation requires the recorded review input.');
  const handle = await reopenWorkspace(workspace, { signal });
  try {
    await handle.assertUnchanged();
    if (!request.configManifest) {
      const expected = await readStoredArtifactScope({ repoPath: workspace.path, criticId: request.criticId });
      if (!expected || !isDeepStrictEqual(expected.artifacts, request.artifacts) || !isDeepStrictEqual(expected.artifactTypes, request.artifactTypes) || !isDeepStrictEqual(expected.artifactGroups ?? [], request.artifactGroups ?? [])) {
        throw new Error('Stored Human tools do not match this snapshot.');
      }
    }
    // Opening the registry verifies the recorded manifest before any check script runs.
    const registry = await createReviewTools({ worktreePath: workspace.path, artifacts: request.artifacts,
      artifactGroups: request.artifactGroups, artifactTypes: request.artifactTypes, configManifest: request.configManifest,
      criticId: request.criticId, audience: 'human', runDir: join(outputDir, 'tools'), signal: handle.signal });
    try {
      const environment = await checkEnvironmentRequirements({ workspacePath: workspace.path, configManifest: request.configManifest, outputDir: join(outputDir, 'environment'), signal: handle.signal });
      if (!environment.ok) throw Object.assign(new Error(environment.checks.filter(check => !check.ok).map(check => `${check.id}: ${check.message}`).join('\n').slice(0, 8000)), { code: 'HUMAN_PREPARATION_FAILED' });
      const tools = await registry.preflight();
      if (tools.some(check => !check.ok)) throw Object.assign(new Error(tools.filter(check => !check.ok).map(check => `${check.toolName}: ${check.message}`).join('\n').slice(0, 8000)), { code: 'HUMAN_PREPARATION_FAILED' });
      await handle.assertUnchanged(); handle.signal.throwIfAborted();
      return { snapshotHash: request.snapshotHash, ...(request.configManifest ? { configHash: request.configManifest.configHash } : {}), environment: environment.checks, tools };
    } finally { await registry.close(); }
  } catch (error) {
    handle.signal.throwIfAborted();
    throw error;
  } finally { await handle.close(); }
}
