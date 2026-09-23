import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { RepoConfig, WorkspaceIntegrity } from '../contracts.js';
import { createGraphDefinition, stronglyConnectedComponents } from '../broker/graph.js';
import { packageVersion } from '../runtime-paths.js';
import { resolveScopePath } from '../artifact-scope.js';
import type { ProjectSnapshot, ValidationInput } from './types.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const inputHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

/** Own material excludes separately identified child Artifacts and installed runtime directories. */
async function hashMaterial(root: string, relative: string, childPaths: Set<string>, signal?: AbortSignal): Promise<string> {
  let current = root;
  for (const component of relative.split('/').filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return inputHash({ path: relative, type: 'missing' });
    if (info.isSymbolicLink()) return inputHash({ path: relative, type: 'symlink', target: await readlink(current) });
  }
  const entries: unknown[] = [];
  const walk = async (name: string): Promise<void> => {
    signal?.throwIfAborted();
    if (childPaths.has(name)) return;
    const absolute = path.join(root, name), info = await lstat(absolute);
    if (info.isSymbolicLink()) entries.push({ name, type: 'symlink', target: await readlink(absolute) });
    else if (info.isDirectory()) {
      entries.push({ name, type: 'directory' });
      for (const child of (await readdir(absolute)).sort()) if (!['.git', 'node_modules'].includes(child)) await walk(path.posix.join(name, child));
    } else if (info.isFile()) {
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(absolute, { signal })) hash.update(bytes);
      entries.push({ name, type: 'file', executable: info.mode & 0o111, hash: hash.digest('hex') });
    } else throw new Error(`Unsupported Artifact input: ${name}`);
  };
  await walk(relative);
  return inputHash(entries);
}

export async function createProjectSnapshot(config: RepoConfig, root: string, snapshotHash: string, signal?: AbortSignal, workspaceIntegrity: WorkspaceIntegrity = 'content'): Promise<ProjectSnapshot> {
  if (!['content', 'metadata'].includes(workspaceIntegrity)) throw new Error('Workspace integrity must be content or metadata.');
  createGraphDefinition(config);
  const artifactHashes: Record<string, string> = {}, reusable: Record<string, boolean> = {}, ownHashes = new Map<string, string>();
  const scope = Object.fromEntries(Object.entries(config.artifacts).map(([id, artifact]) => [id, { ...artifact, path: path.join(root, artifact.path) }]));
  for (const [id, artifact] of Object.entries(config.artifacts)) {
    const childPaths = new Set(Object.keys(artifact.children).map(child => path.posix.join(artifact.path, child)));
    const paths = new Set(artifact.stale?.kind === 'file-hash' && artifact.stale.paths ? artifact.stale.paths.map(name => path.posix.join(artifact.path, name)) : [artifact.path]);
    const mandatoryPaths = new Set([path.posix.join(artifact.path, 'ccdd.json')]);
    const tools = [...Object.values(artifact.views.agentTools ?? {}), ...Object.values(artifact.views.humanTools ?? {})];
    // Local script entry files are mandatory inputs even with a narrower stale.paths declaration.
    for (const tool of tools) for (const argument of [tool.script.command, ...tool.script.args]) {
      if (!argument || argument.startsWith('-')) continue;
      const candidate = path.resolve(root, artifact.path, argument), relative = path.relative(root, candidate);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) continue;
      const info = await lstat(candidate).catch(() => null);
      if (info?.isFile()) mandatoryPaths.add(relative.split(path.sep).join('/'));
    }
    // Runtime test entry points also remain inputs when material selection is narrowed.
    // Resolve logical mount paths exactly as the Runtime executor does.
    for (const critic of config.critics.filter(critic => critic.target === id && critic.profile.kind === 'runtime')) {
      if (critic.profile.kind !== 'runtime') continue;
      for (const argument of critic.profile.args.filter(argument => !argument.startsWith('-'))) {
        const resolved = resolveScopePath(scope, id, argument);
        const relative = path.posix.join(config.artifacts[resolved.artifactId].path, resolved.path);
        const info = await lstat(path.join(root, relative)).catch(() => null);
        if (info?.isFile() || info?.isDirectory()) mandatoryPaths.add(relative);
      }
    }
    for (const name of mandatoryPaths) paths.add(name);
    const fingerprints = await Promise.all([...paths].sort().map(async name => ({ path: name, hash: await hashMaterial(root, name, mandatoryPaths.has(name) ? new Set() : childPaths, signal) })));
    const executionPaths = new Set(tools.flatMap(tool => tool.metadata.executionPaths ?? []));
    const executionInputs = config.configManifest.executionInputs?.filter(input => executionPaths.has(input.path));
    const requirements = Object.fromEntries(Object.entries(config.configManifest.envRequirements ?? {}).filter(([name]) => name.startsWith(`${id}/`)));
    const environmentPaths = new Set(Object.values(requirements).flatMap(requirement => [requirement.script, ...requirement.inputs ?? []]));
    const environmentInputs = config.configManifest.environmentInputs?.filter(input => environmentPaths.has(input.path));
    ownHashes.set(id, inputHash({ version: 2, definition: artifact, fingerprints, executionInputs, requirements, environmentInputs }));
  }
  const components = stronglyConnectedComponents(Object.keys(config.artifacts), config.relations), componentOf = new Map(components.flatMap((members, index) => members.map(id => [id, index] as const)));
  const hashes = new Map<number, string>(), reusableComponents = new Map<number, boolean>();
  const visit = (index: number): string => {
    if (hashes.has(index)) return hashes.get(index)!;
    const members = components[index], edges = config.relations.filter(edge => componentOf.get(edge.target) === index).sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
    const dependencies = [...new Set(edges.map(edge => componentOf.get(edge.source)!).filter(value => value !== index))].sort((a, b) => components[a][0].localeCompare(components[b][0], 'en'));
    const hash = inputHash({ members: members.map(id => ({ id, hash: ownHashes.get(id) })), edges,
      dependencies: dependencies.map(dependency => ({ members: components[dependency], hash: visit(dependency) })) });
    hashes.set(index, hash);
    reusableComponents.set(index, members.every(id => config.artifacts[id].stale?.kind !== 'always') && dependencies.every(dependency => reusableComponents.get(dependency)));
    return hash;
  };
  for (const [index, members] of components.entries()) {
    const hash = visit(index);
    for (const id of members) { artifactHashes[id] = inputHash({ id, component: hash }); reusable[id] = reusableComponents.get(index)!; }
  }
  const inputs: Record<string, ValidationInput> = {};
  for (const critic of config.critics) {
    const criticHash = inputHash({ version: 2, executorVersion: packageVersion, critic, workspaceIntegrity,
      runtime: { node: process.versions.node, platform: process.platform, arch: process.arch } });
    const target = { id: critic.target, hash: artifactHashes[critic.target] }, deps = critic.deps.slice().sort().map(id => ({ id, hash: artifactHashes[id] }));
    inputs[critic.id] = { version: 2, key: inputHash({ criticHash, target, deps }), criticHash, target, deps, reusable: [critic.target, ...critic.deps].every(id => reusable[id]), workspaceIntegrity };
  }
  return { version: 2, config: structuredClone(config), snapshotHash, artifactHashes, inputs, workspaceIntegrity };
}
