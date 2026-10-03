import { setImmediate as yieldTurn } from 'node:timers/promises';
import { prepareWorkspace, type WorkspaceDescriptor, type WorkspaceIntegrity } from '../workspaces/index.js';
import { readWorkspaceConfig } from '../broker/config.js';
import { createProjectSnapshot } from './identity.js';
import { includedCritics } from './query.js';
import { selectProfiles, type ProfileSelection } from './profiles.js';
import { prepareReviewRequests } from '../requester/index.js';
import { currentProjectPlan } from './store.js';
import { requesterPlan, type RequesterPlan } from '../result-view.js';
import type { RepoConfig, ReviewEnvelope } from '../contracts.js';
import type { ProjectSelection, ProjectSnapshot } from './types.js';

export interface PrepareProjectOptions {
  repoPath: string; stateDir: string; repoId?: string; selection: ProjectSelection;
  recursive?: boolean; force?: boolean; ignoreGates?: boolean; profile?: ProfileSelection;
  signal?: AbortSignal; workspaceIntegrity?: WorkspaceIntegrity;
}
/** Session-only handle. Mutating the returned plan cannot change admitted execution. */
export interface PreparedProject { readonly plan: RequesterPlan }
interface PreparedData {
  descriptor: WorkspaceDescriptor; config: RepoConfig; snapshot: ProjectSnapshot; templates: ReviewEnvelope[];
  selection: ProjectSelection; recursive: boolean; force: boolean; ignoreGates: boolean;
}
const prepared = new WeakMap<PreparedProject, PreparedData>();
/** Internal read: no public properties are trusted, and callers get detached data. */
export function preparedProjectData(handle: PreparedProject): PreparedData {
  const data = prepared.get(handle);
  if (!data) throw new Error('Unknown or disposed prepared Project; prepare it in this session.');
  return structuredClone(data);
}
export function disposePreparedProject(handle: PreparedProject): void { prepared.delete(handle); }

export async function prepareProject(options: PrepareProjectOptions): Promise<PreparedProject> {
  const { signal, ...input } = options;
  const { repoPath, stateDir, repoId = 'local', selection, recursive = false, force = false, profile, workspaceIntegrity = 'content' } = structuredClone(input);
  const workspace = await prepareWorkspace({ repoPath, stateDir, signal, integrity: workspaceIntegrity });
  try {
    const descriptor = structuredClone(workspace.descriptor);
    const config = selectProfiles((await readWorkspaceConfig(descriptor.path, workspace.signal)).config, profile, selection, recursive);
    const ignoreGates = input.ignoreGates ?? config.reviewPolicy?.dependencyGates === 'ignore';
    const snapshot = await createProjectSnapshot(config, descriptor.path, descriptor.hash, workspace.signal, descriptor.integrity, selection);
    const templates: ReviewEnvelope[] = [], critics = new Map(config.critics.map(critic => [critic.id, critic]));
    for (const id of includedCritics(snapshot, selection, recursive)) {
      templates.push(...await prepareReviewRequests({ repoPath: descriptor.path, repoId, snapshotHash: descriptor.hash, criticId: id, preparedConfig: { ...config, critics: [critics.get(id)!] }, copy: false }));
      if (templates.length % 16 === 0) { workspace.signal.throwIfAborted(); await yieldTurn(); }
    }
    const plan = currentProjectPlan(stateDir, snapshot, { selection, recursive, force, ignoreGates });
    await workspace.assertUnchanged(); workspace.signal.throwIfAborted();
    const handle = Object.freeze({ plan: structuredClone(requesterPlan(plan, stateDir)) });
    prepared.set(handle, { descriptor, config, snapshot, templates, selection, recursive, force, ignoreGates });
    return handle;
  } finally { await workspace.close(); }
}
