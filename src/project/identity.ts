import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { RepoConfig } from '../contracts.js';
import { isArtifactGroup, resolveArtifactScope } from '../artifacts/groups.js';
import { createGraphDefinition } from '../broker/graph.js';
import { validateRelativePath } from '../broker/config.js';
import { packageVersion } from '../runtime-paths.js';
import type { ProjectSnapshot, ValidationInput } from './types.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const inputHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

/** Hash declared content, including additions, removals, names and empty directories. */
async function hashPath(root: string, relative: string, signal?: AbortSignal): Promise<string> {
  validateRelativePath(relative);
  // Check every ancestor before following a path: a file under a symlink is not scoped input.
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return inputHash({ path: relative, type: 'missing' });
    if (info.isSymbolicLink()) throw new Error(`Stale input must not contain symlinks: ${relative}`);
  }
  const entries: unknown[] = [];
  const walk = async (absolute: string, name: string): Promise<void> => {
    signal?.throwIfAborted();
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Stale input must not contain symlinks: ${name}`);
    if (info.isDirectory()) {
      entries.push({ name, type: 'directory' });
      for (const child of (await readdir(absolute)).sort()) await walk(path.join(absolute, child), `${name}/${child}`);
    } else if (info.isFile()) {
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(absolute, { signal })) hash.update(bytes);
      entries.push({ name, type: 'file', executable: info.mode & 0o111, hash: hash.digest('hex') });
    } else throw new Error(`Unsupported stale input: ${name}`);
  };
  await walk(path.join(root, relative), relative);
  return inputHash(entries);
}

export async function createProjectSnapshot(config: RepoConfig, root: string, snapshotHash: string, signal?: AbortSignal): Promise<ProjectSnapshot> {
  createGraphDefinition(config);
  const artifactHashes: Record<string, string> = {}, reusable: Record<string, boolean> = {};
  const paths = new Map<string, Promise<string>>();
  const fingerprintPath = (value: string) => { if (!paths.has(value)) paths.set(value, hashPath(root, value, signal)); return paths.get(value)!; };
  const visit = async (id: string): Promise<string> => {
    if (artifactHashes[id]) return artifactHashes[id];
    const artifact = config.artifacts[id];
    const extraPaths = artifact.stale?.kind === 'file-hash' ? artifact.stale.paths : undefined;
    const fingerprints = await Promise.all((extraPaths ?? (isArtifactGroup(artifact) ? [] : [artifact.path])).slice().sort().map(async name => ({ path: name, hash: await fingerprintPath(name) })));
    const members = isArtifactGroup(artifact) ? await Promise.all(artifact.members.map(async member => ({ id: member, hash: await visit(member) }))) : [];
    reusable[id] = artifact.stale?.kind !== 'always' && members.every(member => reusable[member.id]);
    return artifactHashes[id] = inputHash({ definition: artifact, fingerprints, members });
  };
  for (const id of Object.keys(config.artifacts)) await visit(id);
  const inputs: Record<string, ValidationInput> = {};
  for (const critic of config.critics) {
    const scope = resolveArtifactScope(config.artifacts, [critic.target, ...critic.deps]);
    const types = Object.fromEntries([...new Set(scope.artifacts.map(a => a.type))].sort().map(type => [type, config.artifactTypes[type]]));
    // A TS tool can close over arbitrary imported values. Keep its module snapshot in
    // the identity rather than falsely treating identical function text as identical behavior.
    const modules = config.configManifest?.modules;
    const tools = config.configManifest ? Object.fromEntries(Object.keys(types).map(type => [type, config.configManifest!.types[type]])) : types;
    const criticHash = inputHash({ version: 1, executorVersion: packageVersion, critic, tools, modules, runtime: critic.profile.kind === 'runtime' ? { node: process.versions.node, platform: process.platform, arch: process.arch } : undefined });
    const target = { id: critic.target, hash: artifactHashes[critic.target] };
    const deps = critic.deps.slice().sort().map(id => ({ id, hash: artifactHashes[id] }));
    inputs[critic.id] = { version: 1, key: inputHash({ criticHash, target, deps }), criticHash, target, deps, reusable: [critic.target, ...critic.deps].every(id => reusable[id]) };
  }
  return { version: 1, config: structuredClone(config), snapshotHash, artifactHashes, inputs };
}
