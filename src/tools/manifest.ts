import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RepoConfig } from '../contracts.js';
import type { ConfigManifest } from './contracts.js';

/** Reconnect historical locale-ordered manifests only after proving the same input. */
export function matchesToolManifest(config: RepoConfig, recorded: ConfigManifest): boolean {
  const current = config.configManifest;
  if (!current || !recorded || current.version !== 1 || recorded.version !== 1) return false;
  if (isDeepStrictEqual(current, recorded)) return true;
  if (!Array.isArray(recorded.modules) || recorded.modules.some(entry => !entry || typeof entry.path !== 'string' || typeof entry.hash !== 'string')) return false;
  const ordered = (modules: ConfigManifest['modules']) => [...modules].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!isDeepStrictEqual(ordered(current.modules), ordered(recorded.modules))) return false;
  // Older v1 writers sorted modules with the publisher's locale. Preserve that
  // recorded order in the hash recipe, without trusting any recorded content hash
  // or discarding changes to configuration values, types, or declared inputs.
  const extensions = {
    ...(current.envRequirements === undefined ? {} : { envRequirements: current.envRequirements, environmentInputs: current.environmentInputs }),
    ...(current.executionInputs === undefined ? {} : { executionInputs: current.executionInputs }),
  };
  const configHash = createHash('sha256').update(JSON.stringify({
    values: { artifacts: config.artifacts, critics: config.critics },
    types: current.types, modules: recorded.modules, ...extensions,
  })).digest('hex');
  return isDeepStrictEqual({ ...current, modules: recorded.modules, configHash }, recorded);
}
