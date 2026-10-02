import { executionScope } from '../execution-scope.js';
import { openResources, rejectIdentityConcurrency, validateIdentityWeight, canonicalRepositoryId } from '../resources.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import type { RepoConfig, WorkspaceIntegrity } from '../contracts.js';
import { createGraphDefinition, stronglyConnectedComponents } from '../broker/graph.js';
import { resolveScopePath } from '../artifact-scope.js';
import type { ProjectSelection, ProjectSnapshot, ValidationInput } from './types.js';
import { requiredArtifacts } from './query.js';
import { ownerIdentity } from './owner-identity.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const inputHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

/**
 * Own material excludes separately identified child Artifacts and installed runtime directories.
 * Family shared material records a directory only when it is empty and not one of `ancestors`, the
 * declared folders above instance material: file names already imply nonempty directories, so adding,
 * removing or emptying one instance's material folder never changes sibling instances.
 */
async function hashMaterial(root: string, relative: string, childPaths: Set<string>, signal?: AbortSignal, ancestors?: Set<string>): Promise<string> {
  let current = root;
  for (const component of relative.split('/').filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return ancestors?.has(relative) ? inputHash([]) : inputHash({ path: relative, type: 'missing' });
    if (info.isSymbolicLink()) return inputHash({ path: relative, type: 'symlink', target: await readlink(current) });
  }
  const entries: unknown[] = [];
  const walk = async (name: string): Promise<void> => {
    signal?.throwIfAborted();
    if (childPaths.has(name)) return;
    const absolute = path.join(root, name), info = await lstat(absolute);
    if (info.isSymbolicLink()) entries.push({ name, type: 'symlink', target: await readlink(absolute) });
    else if (info.isDirectory()) {
      const children = (await readdir(absolute)).sort();
      if (!ancestors || !children.length && !ancestors.has(name)) entries.push({ name, type: 'directory' });
      for (const child of children) if (!['.git', 'node_modules'].includes(child)) await walk(path.posix.join(name, child));
    } else if (info.isFile()) {
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(absolute, { signal })) hash.update(bytes);
      entries.push({ name, type: 'file', executable: info.mode & 0o111, hash: hash.digest('hex') });
    } else throw new Error(`Unsupported Artifact input: ${name}`);
  };
  await walk(relative);
  return inputHash(entries);
}

export function semanticDefinition<T extends { reviewPolicy?: unknown; stale?: { kind: string; weight?: number } }>(value: T): T {
  const result = structuredClone(value); delete result.reviewPolicy;
  if (result.stale?.kind === 'identity') delete result.stale.weight;
  return result;
}

interface FamilyPaths { excluded: Set<string>; ancestors: Set<string> }
const familyPaths = new WeakMap<RepoConfig, Map<string, FamilyPaths>>();
/**
 * The shared declaration, instance list and every instance's own material, plus the folders that
 * contain that material (the family folder included), computed once per config.
 */
function familyExclusions(config: RepoConfig, name: string, folder: string): FamilyPaths {
  let byFamily = familyPaths.get(config);
  if (!byFamily) familyPaths.set(config, byFamily = new Map());
  let result = byFamily.get(name);
  if (!result) {
    result = { excluded: new Set([path.posix.join(folder, 'ccdd.json')]), ancestors: new Set([folder]) };
    for (const member of Object.values(config.artifacts)) if (member.family?.name === name) {
      if (member.family.instances) result.excluded.add(path.posix.join(folder, member.family.instances));
      for (const material of member.family.material) {
        result.excluded.add(path.posix.join(folder, material));
        const parts = material.split('/');
        for (let index = 1; index < parts.length; index++) result.ancestors.add(path.posix.join(folder, ...parts.slice(0, index)));
      }
    }
    byFamily.set(name, result);
  }
  return result;
}

export interface SnapshotOptions { identityConcurrency?: number }
export function positiveConcurrency(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

export async function createProjectSnapshot(config: RepoConfig, root: string, snapshotHash: string, signal?: AbortSignal, workspaceIntegrity: WorkspaceIntegrity = 'content', selection: ProjectSelection = { kind: 'all' }, { identityConcurrency }: SnapshotOptions = {}): Promise<ProjectSnapshot> {
  rejectIdentityConcurrency(identityConcurrency);
  signal?.throwIfAborted();
  if (!['content', 'metadata'].includes(workspaceIntegrity)) throw new Error('Workspace integrity must be content or metadata.');
  createGraphDefinition(config, false);
  // A dependency closure contains whole SCCs; keep the full definitions and hash payloads unchanged.
  const required = new Set(requiredArtifacts({ config }, selection));
  const artifactHashes: Record<string, string> = {}, reusable: Record<string, boolean> = {}, ownHashes = new Map<string, string>();
  const artifactIdentities: NonNullable<ProjectSnapshot['artifactIdentities']> = {};
  const scope = Object.fromEntries(Object.entries(config.artifacts).map(([id, artifact]) => [id, { ...artifact, path: path.join(root, artifact.path) }]));
  const owners = Object.entries(config.artifacts).filter(([id, artifact]) => required.has(id) && artifact.stale?.kind === 'identity');
  const values = new Map<string, string>(), sharedMaterial = new Map<string, Promise<string>>();
  const controller = new AbortController();
  const identitySignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  // Validate the entire selected scope before executing any owner script.
  for (const [, artifact] of owners) if (artifact.stale?.kind === 'identity') validateIdentityWeight(artifact.stale.weight);
  const resources = owners.length ? openResources() : undefined;
  const workers = owners.map(async ([id, artifact]) => {
    try {
      if (artifact.stale?.kind !== 'identity') throw new Error('Invalid owner identity strategy.');
      const lease = await resources!.acquire({ requestId: id, runId: '', kind: 'identity', repo: canonicalRepositoryId(root), identityWeight: artifact.stale.weight ?? 25 }, { signal: identitySignal, waiting() {} });
      try {
        const { value } = await executionScope.run({ runtimeRoot: root, declaredPaths: [], trackChild: pid => lease.trackChild(pid) }, () => ownerIdentity(root, artifact.path, id, artifact.stale as Extract<NonNullable<typeof artifact.stale>, { kind: 'identity' }>, identitySignal, artifact.family));
        values.set(id, value);
      } finally { await lease.release(); }
    } catch (error) { if (!controller.signal.aborted) controller.abort(error); throw error; }
  });
  await Promise.allSettled(workers);
  resources?.close();
  identitySignal.throwIfAborted();
  for (const [id, artifact] of Object.entries(config.artifacts)) {
    signal?.throwIfAborted();
    if (!required.has(id)) continue;
    if (artifact.stale?.kind === 'identity') {
      const value = values.get(id)!;
      ownHashes.set(id, inputHash({ id, value }));
      artifactIdentities[id] = { identity: 'script', value };
      continue;
    }
    // Physical child locations: a family instance is a logical child whose material is its family folder.
    const childPaths = new Set(Object.values(artifact.children).map(child => config.artifacts[child]?.path ?? path.posix.join(artifact.path, child)));
    const paths = new Set(artifact.stale?.kind === 'file-hash' && artifact.stale.paths ? artifact.stale.paths.map(name => path.posix.join(artifact.path, name)) : [artifact.path]);
    // A family instance is covered by its resolved definition and entry, not by the shared declaration bytes,
    // so adding or editing another instance never invalidates it. Other instances' material is excluded.
    const family = artifact.family;
    const shared = family ? familyExclusions(config, family.name, artifact.path) : undefined;
    for (const name of shared?.excluded ?? []) childPaths.add(name);
    const mandatoryPaths = new Set(family ? family.material.map(name => path.posix.join(artifact.path, name)) : [path.posix.join(artifact.path, 'ccdd.json')]);
    const tools = [...Object.values(artifact.views.agentTools ?? {}), ...Object.values(artifact.views.humanTools ?? {})];
    // Local script entry files are mandatory inputs even with a narrower stale.paths declaration.
    for (const tool of tools) for (const argument of [tool.script.command, ...tool.script.args]) {
      if (!argument || argument.startsWith('-')) continue;
      const candidate = path.resolve(root, artifact.path, argument), relative = path.relative(root, candidate);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) continue;
      const info = await lstat(candidate).catch(() => null);
      if (info?.isFile()) mandatoryPaths.add(relative.split(path.sep).join('/'));
    }
    // A result check decides whether a review is accepted, so its script is an input too.
    for (const critic of config.critics) if (critic.target === id && critic.resultCheck) mandatoryPaths.add(path.posix.join(artifact.path, critic.resultCheck.script));
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
    // Instances of one family exclude the same paths, so their shared material is hashed once per snapshot.
    const material = (name: string): Promise<string> => {
      if (!family) return hashMaterial(root, name, mandatoryPaths.has(name) ? new Set() : childPaths, signal);
      const mandatory = mandatoryPaths.has(name), key = `${family.name}\0${mandatory}\0${name}`;
      // A narrowed stale path inside another instance's material never becomes shared material.
      const excluded = !mandatory && name.split('/').some((_, index, parts) => childPaths.has(parts.slice(0, index + 1).join('/')));
      if (!sharedMaterial.has(key)) sharedMaterial.set(key, excluded ? Promise.resolve(inputHash({ path: name, type: 'excluded' })) : hashMaterial(root, name, mandatory ? new Set() : childPaths, signal, mandatory ? undefined : shared!.ancestors));
      return sharedMaterial.get(key)!;
    };
    const fingerprints = await Promise.all([...paths].sort().map(async name => ({ path: name, hash: await material(name) })));
    const executionPaths = new Set(tools.flatMap(tool => tool.metadata.executionPaths ?? []));
    const executionInputs = config.configManifest.executionInputs?.filter(input => executionPaths.has(input.path));
    const requirements = Object.fromEntries(Object.entries(config.configManifest.envRequirements ?? {}).filter(([name]) => name.startsWith(`${id}/`)));
    const environmentPaths = new Set(Object.values(requirements).flatMap(requirement => [requirement.script, ...requirement.inputs ?? []]));
    const environmentInputs = config.configManifest.environmentInputs?.filter(input => environmentPaths.has(input.path));
    ownHashes.set(id, inputHash({ version: 3, definition: semanticDefinition(artifact), fingerprints, executionInputs, requirements, environmentInputs, critics: config.critics.filter(critic => critic.target === id), workspaceIntegrity }));
  }
  const components = stronglyConnectedComponents(Object.keys(config.artifacts), config.relations), componentOf = new Map(components.flatMap((members, index) => members.map(id => [id, index] as const)));
  const hashes = new Map<number, string>(), reusableComponents = new Map<number, boolean>();
  const visit = (index: number): string => {
    if (hashes.has(index)) return hashes.get(index)!;
    const members = components[index], edges = config.relations.filter(edge => componentOf.get(edge.target) === index).sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
    const dependencies = [...new Set(edges.map(edge => componentOf.get(edge.source)!).filter(value => value !== index))].sort((a, b) => components[a][0].localeCompare(components[b][0], 'en'));
    const hash = inputHash({ members: members.map(id => ({ id, hash: ownHashes.get(id) })), edges: [...new Set(edges.map(edge => `${edge.source}:${edge.target}`))].sort(),
      dependencies: dependencies.map(dependency => ({ members: components[dependency], hash: visit(dependency) })) });
    hashes.set(index, hash);
    reusableComponents.set(index, members.every(id => config.artifacts[id].stale?.kind !== 'always') && dependencies.every(dependency => reusableComponents.get(dependency)));
    return hash;
  };
  for (const [index, members] of components.entries()) {
    if (!required.has(members[0])) continue;
    const hash = visit(index);
    for (const id of members) { artifactHashes[id] = inputHash({ id, component: hash }); reusable[id] = reusableComponents.get(index)!; }
  }
  const inputs: Record<string, ValidationInput> = {};
  for (const critic of config.critics) {
    if (!required.has(critic.target)) continue;
    const criticHash = inputHash({ version: 3, criticId: critic.id });
    const target = { id: critic.target, hash: artifactHashes[critic.target] }, deps = critic.deps.slice().sort().map(id => ({ id, hash: artifactHashes[id] }));
    inputs[critic.id] = { version: 3, key: inputHash({ version: 3, criticId: critic.id, target, deps }), criticHash, target, deps, reusable: [critic.target, ...critic.deps].every(id => reusable[id]), workspaceIntegrity };
  }
  return { version: 3, config: structuredClone(config), snapshotHash, artifactHashes, inputs, workspaceIntegrity, ...(Object.keys(artifactIdentities).length ? { artifactIdentities } : {}) };
}
