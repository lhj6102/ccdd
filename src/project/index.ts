import { readWorkspaceConfig } from '../broker/config.js';
import { prepareWorkspace, type WorkspaceIntegrity } from '../workspaces/index.js';
import { createProjectSnapshot, DEFAULT_IDENTITY_CONCURRENCY, positiveConcurrency } from './identity.js';
import { planProject as fullPlan, queryProject as fullQuery } from './query.js';
import { requesterPlan, requesterQuery, resultView, type ResultDetail, type ResultOptions } from '../result-view.js';
import type { ProjectSnapshot, ValidationEvidence, QueryOptions } from './types.js';
import { currentProjectPlan } from './store.js';
import type { ProjectSelection } from './types.js';

export type * from './types.js';
export { createProjectSnapshot, type SnapshotOptions } from './identity.js';
export type * from '../result-view.js';

/** Pure requester queries need the evidence store location to produce resolvable references. */
export function queryProject<D extends ResultDetail = 'compact'>(snapshot: ProjectSnapshot, history: readonly ValidationEvidence[], options: QueryOptions & ResultOptions<D> & { stateDir: string }) {
  const query = fullQuery(snapshot, history, options);
  return resultView(options, query, () => requesterQuery(query, options.stateDir));
}
export function planProject<D extends ResultDetail = 'compact'>(snapshot: ProjectSnapshot, history: readonly ValidationEvidence[], options: QueryOptions & ResultOptions<D> & { stateDir: string; recursive?: boolean; force?: boolean }) {
  const plan = fullPlan(snapshot, history, options);
  return resultView(options, plan, () => requesterPlan(plan, options.stateDir));
}
export { projectHistory, projectRun, projectRuns, projectRequests } from './store.js';
export { pruneProject, type PruneResult } from './prune.js';
export { createBroker } from '../broker/index.js';
export { createExecutorRegistry } from '../executors/index.js';

/** Explicit CLI query: briefly observe the current workspace without creating a store. */
export async function inspectProject<D extends ResultDetail = 'compact'>({ detail, repoPath, stateDir, selection, recursive = false, force = false, signal, identityConcurrency = DEFAULT_IDENTITY_CONCURRENCY, workspaceIntegrity = 'content' }: { repoPath: string; stateDir: string; selection?: ProjectSelection; recursive?: boolean; force?: boolean; signal?: AbortSignal; identityConcurrency?: number; workspaceIntegrity?: WorkspaceIntegrity } & ResultOptions<D>) {
  positiveConcurrency(identityConcurrency, 'identityConcurrency');
  const workspace = await prepareWorkspace({ repoPath, stateDir, signal, integrity: workspaceIntegrity });
  try {
    const { config } = await readWorkspaceConfig(workspace.descriptor.path, workspace.signal);
    const snapshot = await createProjectSnapshot(config, workspace.descriptor.path, workspace.descriptor.hash, workspace.signal, workspace.descriptor.integrity, selection, { identityConcurrency });
    const plan = currentProjectPlan(stateDir, snapshot, { selection, recursive, force });
    await workspace.assertUnchanged();
    return resultView({ detail }, { snapshot, plan }, () => ({ plan: requesterPlan(plan, stateDir) }));
  } finally { await workspace.close(); }
}
