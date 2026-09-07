import { readWorkspaceConfig } from '../broker/config.js';
import { prepareWorkspace } from '../workspaces/index.js';
import { createProjectSnapshot } from './identity.js';
import { planProject } from './query.js';
import { projectHistory } from './store.js';
import type { ProjectSelection } from './types.js';

export type * from './types.js';
export { createProjectSnapshot } from './identity.js';
export { queryProject, planProject } from './query.js';
export { projectHistory, projectRun, projectRuns, projectRequests } from './store.js';
export { createBroker } from '../broker/index.js';
export { createExecutorRegistry } from '../executors/index.js';

/** Explicit CLI query: briefly observe the current workspace without creating a store. */
export async function inspectProject({ repoPath, stateDir, selection, recursive = false, force = false, signal }: { repoPath: string; stateDir: string; selection?: ProjectSelection; recursive?: boolean; force?: boolean; signal?: AbortSignal }) {
  const workspace = await prepareWorkspace({ repoPath, stateDir, mode: 'lock', signal });
  try {
    const { config } = await readWorkspaceConfig(workspace.descriptor.path, workspace.signal);
    const snapshot = await createProjectSnapshot(config, workspace.descriptor.path, workspace.descriptor.hash, workspace.signal);
    const history = projectHistory(stateDir);
    const plan = planProject(snapshot, history, { selection, recursive, force });
    await workspace.assertUnchanged();
    return { snapshot, plan };
  } finally { await workspace.close(); }
}
