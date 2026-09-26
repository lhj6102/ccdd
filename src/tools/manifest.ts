import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RepoConfig } from '../contracts.js';
import type { ConfigManifest } from './contracts.js';

// Index once per parsed config, not once per Critic. The envelope boundary
// copies selected values; the workspace config and its identity stay unchanged.
const indexes = new WeakMap<ConfigManifest, { declarations: Map<string, ConfigManifest['declarations'][number]>; execution: Map<string, { path: string; hash: string }>; environment: Map<string, { path: string; hash: string }> }>();
export function scopeToolManifest(manifest: ConfigManifest, ids: readonly string[]): ConfigManifest {
  let index = indexes.get(manifest);
  if (!index) {
    index = { declarations: new Map(manifest.declarations.map(value => [value.path, value])), execution: new Map(manifest.executionInputs?.map(value => [value.path, value])), environment: new Map(manifest.environmentInputs?.map(value => [value.path, value])) };
    indexes.set(manifest, index);
  }
  const artifacts = Object.fromEntries(ids.map(id => [id, manifest.artifacts[id]]));
  const declarations = ids.map(id => index.declarations.get(posix.join(artifacts[id].path, 'ccdd.json'))!).filter(Boolean);
  const executionPaths = new Set<string>(), environmentPaths = new Set<string>();
  const envRequirements: NonNullable<ConfigManifest['envRequirements']> = {};
  for (const [id, artifact] of Object.entries(artifacts)) {
    for (const tool of [...Object.values(artifact.views.agentTools ?? {}), ...Object.values(artifact.views.humanTools ?? {})]) for (const input of tool.metadata.executionPaths ?? []) executionPaths.add(input);
    for (const name of Object.keys(artifact.envRequirements ?? {})) {
      const key = `${id}/${name}`, requirement = manifest.envRequirements?.[key];
      if (!requirement) continue;
      envRequirements[key] = requirement; environmentPaths.add(requirement.script);
      for (const input of requirement.inputs ?? []) environmentPaths.add(input);
    }
  }
  return { version: 2, configHash: manifest.configHash, artifacts, declarations,
    ...(executionPaths.size ? { executionInputs: [...executionPaths].sort().map(input => index.execution.get(input)!) } : {}),
    ...(environmentPaths.size ? { envRequirements, environmentInputs: [...environmentPaths].sort().map(input => index.environment.get(input)!) } : {}) };
}

/** Whole-config identity lives on the Run snapshot; reconnect only this scope. */
export function matchesToolManifest(config: RepoConfig, recorded: ConfigManifest): boolean {
  const ids = Object.keys(config.artifacts);
  if (recorded?.version !== 2 || !/^[a-f0-9]{64}$/.test(recorded.configHash) || ids.some(id => !Object.hasOwn(recorded.artifacts, id))) return false;
  const expected = scopeToolManifest(recorded, ids), actual = scopeToolManifest(config.configManifest, ids);
  return isDeepStrictEqual({ ...actual, configHash: recorded.configHash }, expected);
}
