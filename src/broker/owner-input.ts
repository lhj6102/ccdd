import { computeOwnerIdentity } from '../project/identity.js';
import type { ReviewRequest, WorkspaceHandle } from '../contracts.js';
import type { openResources } from '../resources.js';

const failure = (message: string, code: string) => Object.assign(new Error(message), { code });

/**
 * A cache-owned execution is bound to its explicit owner identity, the whole 7.x reuse key,
 * not to live observation of the workspace. Opening walks nothing and starts no watcher.
 * The boundary re-runs the owner identity function against the same supplied workspace:
 * a different value means the result would describe another identity, so it fails as
 * WORKSPACE_CHANGED and is never published. CCDD does not lock the workspace, so this
 * detects covered changes completed before the check, not an edit racing the check.
 */
export function ownerInput(request: Pick<ReviewRequest, 'workspace' | 'artifacts' | 'validationInput'>, resources: Pick<ReturnType<typeof openResources>, 'acquire'>, signal?: AbortSignal): WorkspaceHandle {
  const input = request.validationInput, artifact = request.artifacts.find(candidate => candidate.id === input?.target.id);
  if (input?.version !== 4 || !input.cacheIdentity || artifact?.stale?.kind !== 'identity') throw failure('A cache-owned execution requires its explicit owner identity.', 'WORKSPACE_UNSAFE');
  const identity = input.cacheIdentity, controller = new AbortController();
  const handleSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  return {
    descriptor: Object.freeze(structuredClone(request.workspace)),
    signal: handleSignal,
    async assertUnchanged() {
      handleSignal.throwIfAborted();
      const value = await computeOwnerIdentity(resources, request.workspace.path, artifact.id, artifact, handleSignal);
      // Latched like an observed change: no later boundary can accept this execution.
      if (value !== identity) controller.abort(failure('The owner identity changed during execution; the result is not published.', 'WORKSPACE_CHANGED'));
      handleSignal.throwIfAborted();
      return value;
    },
    async close() {},
  };
}
