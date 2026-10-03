import { validateIdentityWeight } from '../resources.js';
import { validateResponseSchema } from '../response-schema.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import type { ArtifactManifest, ArtifactDefinition, ArtifactFamilyMembership, CriticDefinition, ResolvedCriticDefinition, ArtifactRelation } from '../definitions.js';
import type { ArtifactViews, ConfigManifest, ScriptDefinition } from '../tools/contracts.js';
import type { RepoConfig } from '../contracts.js';
import { metadata, environmentRequirements, object, projectInputPath } from '../tools/schema.js';
import { hashExecutionInputs } from '../tools/inputs.js';
import { scopedPath } from '../tools/paths.js';
import { instructionReferences } from '../artifacts/instruction.js';

export const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const criticIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const MAX_FAMILY_INSTANCES = 10000;
const parsedLists = new Map<string, unknown>();
const ownMap = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
export function validateRelativePath(value: unknown): string { projectInputPath(value); return value; }
function fields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
export function validateScript(value: unknown): asserts value is ScriptDefinition {
  if (!object(value)) throw new Error('A script requires command and args.');
  fields(value, ['command', 'args'], 'script');
  if (typeof value.command !== 'string' || !value.command.trim() || /[\x00-\x1f\x7f]/.test(value.command) || !Array.isArray(value.args) || value.args.some((arg: unknown) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('A script requires a fixed command and string args.');
}
function views(value: unknown): ArtifactViews {
  if (value === undefined) return {};
  if (!object(value)) throw new Error('views must be an object.');
  fields(value, ['agentTools', 'humanTools'], 'views');
  const result: ArtifactViews = {};
  for (const audience of ['agentTools', 'humanTools'] as const) {
    if (value[audience] === undefined) continue;
    if (!object(value[audience])) throw new Error(`${audience} must be a tool map.`);
    const tools = ownMap<NonNullable<ArtifactViews[typeof audience]>[string]>();
    for (const [name, tool] of Object.entries(value[audience])) {
      if (!identifier.test(name) || !object(tool)) throw new Error('View names must be safe identifiers.');
      fields(tool, ['metadata', 'script'], 'view');
      validateScript(tool.script);
      const meta = metadata(tool.metadata);
      if (meta.artifactKind === 'file') throw new Error('Artifacts are folders; file views select a file inside their folder.');
      tools[name] = { metadata: meta, script: structuredClone(tool.script) };
    }
    result[audience] = tools;
  }
  return result;
}
export function validateCriticProfile(profile: unknown): asserts profile is import('../definitions.js').CriticProfile {
  if (!object(profile) || !['agent', 'human', 'runtime'].includes(profile.kind)) throw new Error('Invalid Critic profile.');
  if (profile.kind === 'agent') {
    fields(profile, ['kind', 'provider', 'model', 'reasoning', 'timeoutMs', 'maxToolCalls', 'maxTokens'], 'Agent profile');
    if (['provider', 'model', 'reasoning'].some(key => typeof profile[key] !== 'string' || !profile[key].trim())) throw new Error('Agent profiles require provider, model and reasoning.');
    for (const key of ['maxToolCalls', 'maxTokens']) if (profile[key] !== undefined && (!Number.isSafeInteger(profile[key]) || profile[key] < 1)) throw new Error(`Agent profile ${key} must be a positive integer.`);
  } else if (profile.kind === 'human') fields(profile, ['kind'], 'Human profile');
  else {
    fields(profile, ['kind', 'command', 'args', 'timeoutMs'], 'Runtime profile');
    validateScript({ command: profile.command, args: profile.args });
  }
  if (profile.timeoutMs !== undefined && (!Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1 || profile.timeoutMs > 2_147_483_647)) throw new Error('Invalid Critic timeoutMs.');
}
function critic(value: unknown): CriticDefinition {
  if (!object(value)) throw new Error('Invalid Critic declaration.');
  fields(value, ['id', 'title', 'profile', 'profileVariants', 'payload', 'passSchema', 'failSchema', 'resultCheck'], 'Critic');
  if (typeof value.id !== 'string' || !identifier.test(value.id) || typeof value.title !== 'string' || !value.title.trim()) throw new Error('A Critic needs a local id and title.');
  if (!object(value.payload) || typeof value.payload.instruction !== 'string' || !value.payload.instruction.trim()) throw new Error('A Critic needs payload.instruction.');
  for (const key of ['passSchema', 'failSchema']) if (value[key] !== undefined) validateResponseSchema(value[key]);
  validateCriticProfile(value.profile);
  const profile = value.profile;
  if (value.profileVariants !== undefined) {
    if (!object(value.profileVariants) || Object.keys(value.profileVariants).length > 64) throw new Error('profileVariants must contain at most 64 named profiles.');
    for (const [name, variant] of Object.entries(value.profileVariants)) {
      if (!identifier.test(name)) throw new Error('Profile variant names must be safe identifiers.');
      validateCriticProfile(variant);
      if (variant.kind !== profile.kind) throw new Error('Profile variants must retain the declared reviewer kind.');
    }
  }
  if (value.resultCheck !== undefined) {
    // Only Agent reviews record tool-call arguments for a check to compare against.
    if (profile.kind !== 'agent') throw new Error('resultCheck requires an Agent Critic.');
    if (!object(value.resultCheck)) throw new Error('resultCheck must be an object.');
    fields(value.resultCheck, ['script', 'timeoutMs'], 'resultCheck');
    projectInputPath(value.resultCheck.script);
    if (!/\.(?:[cm]?js|[cm]?ts)$/.test(value.resultCheck.script)) throw new Error('resultCheck script must be a Node JavaScript or TypeScript file.');
    if (value.resultCheck.timeoutMs !== undefined && (!Number.isSafeInteger(value.resultCheck.timeoutMs) || value.resultCheck.timeoutMs < 1 || value.resultCheck.timeoutMs > 2_147_483_647)) throw new Error('resultCheck timeoutMs must be 1–2147483647.');
  }
  return structuredClone(value) as CriticDefinition;
}
function manifest(value: unknown): Omit<ArtifactManifest, 'family'> {
  if (!object(value)) throw new Error('ccdd.json must contain an Artifact object.');
  fields(value, ['name', 'critics', 'views', 'mounts', 'basis', 'stale', 'envRequirements', 'reviewPolicy'], 'Artifact');
  if (typeof value.name !== 'string' || !identifier.test(value.name)) throw new Error('Artifact name must be a safe identifier.');
  if (value.basis !== undefined && typeof value.basis !== 'boolean') throw new Error('basis must be a boolean.');
  if (value.critics !== undefined && !Array.isArray(value.critics)) throw new Error('critics must be an array.');
  const critics = (value.critics ?? []).map(critic) as CriticDefinition[];
  if (new Set(critics.map(c => c.id)).size !== critics.length) throw new Error(`Duplicate local Critic in ${value.name}.`);
  if (value.basis && critics.length) throw new Error(`Basis Artifact ${value.name} cannot own Critics.`);
  if (value.mounts !== undefined && !object(value.mounts)) throw new Error('mounts must map aliases to Artifact names.');
  const mounts = ownMap<string>();
  for (const [alias, target] of Object.entries(value.mounts ?? {})) {
    if (!identifier.test(alias) || typeof target !== 'string' || !identifier.test(target)) throw new Error('Mount aliases and targets must be safe Artifact identifiers.');
    mounts[alias] = target;
  }
  if (value.stale !== undefined) {
    if (!object(value.stale) || !['always', 'file-hash', 'identity'].includes(value.stale.kind)) throw new Error('Invalid stale strategy.');
    fields(value.stale, value.stale.kind === 'always' ? ['kind'] : value.stale.kind === 'identity' ? ['kind', 'script', 'inputs', 'timeoutMs', 'weight'] : ['kind', 'paths'], 'stale');
    if (value.stale.kind === 'identity') {
      validateIdentityWeight(value.stale.weight);
      validateScript(value.stale.script);
      // A concrete owner-relative entry is mandatory; inline programs cannot be fingerprinted.
      const entry = value.stale.script.command === 'node' ? value.stale.script.args[0] : value.stale.script.command;
      projectInputPath(entry);
      if (entry.startsWith('-')) throw new Error('Identity scripts require an owner-relative entry file, not command flags.');
      if (value.stale.inputs !== undefined) {
        if (!Array.isArray(value.stale.inputs) || value.stale.inputs.length > 64 || new Set(value.stale.inputs).size !== value.stale.inputs.length) throw new Error('stale.inputs must contain at most 64 unique owner-relative paths.');
        value.stale.inputs.forEach(projectInputPath);
      }
      if (value.stale.timeoutMs !== undefined && (!Number.isSafeInteger(value.stale.timeoutMs) || value.stale.timeoutMs < 1 || value.stale.timeoutMs > 2_147_483_647)) throw new Error('Identity timeoutMs must be 1–2147483647.');
    }
    if (value.stale.paths !== undefined) {
      if (!Array.isArray(value.stale.paths) || !value.stale.paths.length) throw new Error('stale.paths must be a nonempty array.');
      value.stale.paths.forEach(projectInputPath);
    }
  }
  if (value.reviewPolicy !== undefined) {
    if (!object(value.reviewPolicy)) throw new Error('reviewPolicy must be an object.');
    fields(value.reviewPolicy, ['dependencyGates', 'maxConcurrentExecutors'], 'reviewPolicy');
    if (value.reviewPolicy.dependencyGates !== undefined && !['green', 'ignore'].includes(value.reviewPolicy.dependencyGates)) throw new Error('reviewPolicy.dependencyGates must be green or ignore.');
    if (value.reviewPolicy.maxConcurrentExecutors !== undefined && (!Number.isSafeInteger(value.reviewPolicy.maxConcurrentExecutors) || value.reviewPolicy.maxConcurrentExecutors < 1)) throw new Error('reviewPolicy.maxConcurrentExecutors must be a positive integer.');
  }
  return { ...(value.reviewPolicy === undefined ? {} : { reviewPolicy: structuredClone(value.reviewPolicy) }), name: value.name, critics, views: views(value.views), mounts,
    ...(value.basis === undefined ? {} : { basis: value.basis }), ...(value.stale === undefined ? {} : { stale: structuredClone(value.stale) }),
    ...(value.envRequirements === undefined ? {} : { envRequirements: environmentRequirements(value.envRequirements) }) };
}

/** Resolve an RFC 6901 pointer inside one instance's params. */
function parameter(params: Record<string, unknown>, pointer: string, instance: string): unknown {
  if (pointer === '') return params;
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) throw new Error(`$param must be a JSON Pointer such as "/schema", not ${JSON.stringify(pointer)}.`);
  let current: unknown = params;
  for (const token of pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (Array.isArray(current) && /^(?:0|[1-9][0-9]*)$/.test(token) && Number(token) < current.length) current = current[Number(token)];
    else if (object(current) && Object.hasOwn(current, token)) current = current[token];
    else throw new Error(`Instance ${instance} has no parameter at ${pointer}.`);
  }
  return current;
}
/**
 * Replace every {"$param": pointer} value with that parameter. Nothing is evaluated. The result may
 * share parameter values; manifest validation copies every declaration it keeps.
 */
function substitute(value: unknown, params: Record<string, unknown>, instance: string): unknown {
  if (Array.isArray(value)) return value.map(item => substitute(item, params, instance));
  if (!object(value)) return value;
  if (Object.hasOwn(value, '$param')) {
    if (Object.keys(value).length !== 1 || typeof value.$param !== 'string') throw new Error('A parameter reference must be exactly {"$param": "/json/pointer"}.');
    return parameter(params, value.$param, instance);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, params, instance)]));
}
const parameterized = (value: unknown): boolean => Array.isArray(value) ? value.some(parameterized)
  : object(value) && (Object.hasOwn(value, '$param') || Object.values(value).some(parameterized));

/** A declared Artifact. A family instance outside a reconnected scope keeps only its name. */
interface FamilyMember { name: string; manifest?: Omit<ArtifactManifest, 'family'>; family?: ArtifactFamilyMembership }
/**
 * Expand a family declaration into its statically listed instance Artifacts. `expand` limits
 * substitution and validation to recorded instances when a scope is reconnected.
 */
async function familyInstances(root: string, relative: string, value: Record<string, any>, expand: (name: string) => boolean = () => true): Promise<{ members: FamilyMember[]; list?: { path: string; hash: string } }> {
  const { family, ...template } = value;
  if (!relative) throw new Error('An Artifact family cannot be the workspace root; place it in a subfolder.');
  if (typeof template.name !== 'string' || !identifier.test(template.name)) throw new Error('Artifact family name must be a safe identifier.');
  if (template.reviewPolicy !== undefined) throw new Error('reviewPolicy belongs only to the repository root ccdd.json.');
  if (!object(family)) throw new Error('family must be an object.');
  fields(family, ['instances', 'params', 'variants'], 'family');
  if (family.params !== undefined && !object(family.params)) throw new Error('family.params must be an object of default parameters.');
  if (family.variants !== undefined && (!object(family.variants) || Object.entries(family.variants).some(([name, params]) => !identifier.test(name) || !object(params)))) throw new Error('family.variants must map safe names to parameter objects.');
  const defaults = (family.params ?? {}) as Record<string, unknown>, variants = (family.variants ?? {}) as Record<string, Record<string, unknown>>;
  let instances: unknown = family.instances, file: string | undefined, list: { path: string; hash: string } | undefined;
  if (typeof instances === 'string') {
    file = instances;
    try { projectInputPath(file); } catch { throw new Error('family.instances must be an owner-relative JSON file or an inline object.'); }
    if (file === 'ccdd.json') throw new Error('family.instances must name a file other than ccdd.json.');
    const location = await scopedPath(root, path.posix.join(relative, file));
    if (!(await lstat(location).catch(() => null))?.isFile()) throw new Error(`Instance list ${file} must be a regular file.`);
    const text = await readFile(location, 'utf8');
    list = { path: path.posix.join(relative, file), hash: hash(text) };
    instances = parsedLists.get(list.hash);
    if (instances === undefined) {
      try { instances = JSON.parse(text); } catch { throw new Error(`Instance list ${file} must contain JSON.`); }
      // Repeated reconnections in one process reuse the parsed list; entries are never mutated.
      parsedLists.set(list.hash, instances);
      if (parsedLists.size > 8) parsedLists.delete(parsedLists.keys().next().value!);
    }
  }
  if (!object(instances) || !Object.keys(instances).length || Object.keys(instances).length > MAX_FAMILY_INSTANCES) throw new Error(`family.instances must list 1–${MAX_FAMILY_INSTANCES} instances by Artifact name.`);
  const entries = instances, names = Object.keys(entries).sort();
  // A parent addresses instances as <family folder>/<name>; a physical entry there would be shadowed.
  const physical = new Set(await readdir(path.join(root, relative)));
  const members = await Promise.all(names.map(async (name): Promise<FamilyMember> => {
    const entry: unknown = entries[name];
    if (!identifier.test(name)) throw new Error(`Instance name ${JSON.stringify(name)} must be a safe Artifact identifier.`);
    if (name === template.name) throw new Error(`Instance ${name} cannot reuse its family name.`);
    if (physical.has(name)) throw new Error(`Instance ${name} conflicts with a physical entry in its family folder.`);
    if (!expand(name)) return { name };
    if (!object(entry)) throw new Error(`Instance ${name} must be an object with optional variant, params and material.`);
    fields(entry, ['variant', 'params', 'material'], 'instance');
    if (entry.params !== undefined && !object(entry.params)) throw new Error(`Instance ${name} params must be an object.`);
    if (entry.variant !== undefined && (typeof entry.variant !== 'string' || !Object.hasOwn(variants, entry.variant))) throw new Error(`Instance ${name} names an unknown variant.`);
    const material: unknown = entry.material ?? [];
    if (!Array.isArray(material) || material.length > 64 || new Set(material).size !== material.length) throw new Error(`Instance ${name} material must contain at most 64 unique owner-relative paths.`);
    for (const item of material) {
      try { projectInputPath(item); } catch { throw new Error(`Instance ${name} material must contain owner-relative paths.`); }
      if (item === 'ccdd.json' || item === file) throw new Error(`Instance ${name} material cannot claim the family declaration.`);
      // Like identity inputs, listed material must exist inside the folder without symlinks.
      await scopedPath(root, path.posix.join(relative, item)).catch(() => { throw new Error(`Instance ${name} material ${item} must exist inside its family folder without symlinks.`); });
    }
    // A shallow merge: an instance or variant replaces whole top-level parameters.
    const params = { ...defaults, ...(entry.variant === undefined ? {} : variants[entry.variant]), ...(entry.params ?? {}) as Record<string, unknown> }, own = [...material as string[]].sort();
    let declared: Omit<ArtifactManifest, 'family'>;
    try {
      declared = manifest({ ...template, name, ...(template.views === undefined ? {} : { views: substitute(template.views, params, name) }),
        ...(template.critics === undefined ? {} : { critics: substitute(template.critics, params, name) }) });
    } catch (error) { throw new Error(`instance ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    return { name, manifest: declared, family: { name: template.name, ...(file === undefined ? {} : { instances: file }), material: own, entry: hash(JSON.stringify(sorted({ params, material: own }))) } };
  }));
  return { members, ...(list ? { list } : {}) };
}

/** Discover static per-folder declarations. No imports, generators, tools, or Providers run here. */
export async function readWorkspaceConfig(repoPath: string, signal?: AbortSignal): Promise<{ config: RepoConfig }> {
  return readConfig(repoPath, signal);
}

/** Reconnect only recorded scope folders; discovery still detects new nearest children. */
export async function readArtifactConfig(repoPath: string, artifacts: ConfigManifest['artifacts'], criticId?: string, signal?: AbortSignal): Promise<{ config: RepoConfig }> {
  return readConfig(repoPath, signal, { paths: Object.values(artifacts).map(artifact => artifact.path), names: new Set(Object.keys(artifacts)), criticId });
}

async function readConfig(repoPath: string, signal?: AbortSignal, scope?: { paths: string[]; names: Set<string>; criticId?: string }): Promise<{ config: RepoConfig }> {
  const root = await realpath(repoPath), artifacts = ownMap<ArtifactDefinition>(), declarations: ConfigManifest['declarations'] = [];
  const localCritics = ownMap<CriticDefinition[]>(), families = ownMap<string>();
  const walk = async (relative: string, parent?: string, family?: string): Promise<void> => {
    signal?.throwIfAborted();
    const absolute = path.join(root, relative), entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const marker = entries.find(entry => entry.name === 'ccdd.json');
    let owner = parent;
    if (marker) {
      if (!marker.isFile()) throw new Error(`ccdd.json must be a regular file: ${relative || '.'}`);
      const file = path.posix.join(relative, 'ccdd.json');
      if (family !== undefined) throw new Error(`${file}: Artifact family ${family} cannot contain nested ccdd.json markers.`);
      const text = await readFile(path.join(root, file), 'utf8');
      let members: FamilyMember[], list: { path: string; hash: string } | undefined;
      try {
        const value: unknown = JSON.parse(text);
        // Reconnecting a recorded scope expands only its recorded instances; a new instance still changes its parent.
        if (object(value) && value.family !== undefined) {
          ({ members, list } = await familyInstances(root, relative, value, scope ? name => scope.names.has(name) : undefined));
          family = value.name as string;
        } else {
          if (object(value) && (parameterized(value.views) || parameterized(value.critics))) throw new Error('$param references are allowed only in an Artifact family declaration.');
          const declared = manifest(value);
          members = [{ name: declared.name, manifest: declared }];
        }
      } catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
      if (family !== undefined) {
        if (Object.hasOwn(artifacts, family) || Object.hasOwn(families, family)) throw new Error(`Duplicate Artifact name: ${family}`);
        families[family] = relative;
      }
      declarations.push({ path: file, hash: hash(text) });
      if (list) declarations.push(list);
      for (const { name, manifest: declared, family: membership } of members) {
        if (Object.hasOwn(artifacts, name) || Object.hasOwn(families, name)) throw new Error(`Duplicate Artifact name: ${name}`);
        if (relative && declared?.reviewPolicy !== undefined) throw new Error('reviewPolicy belongs only to the repository root ccdd.json.');
        // One family folder holds every instance; a parent sees each instance as a logical child below that folder.
        if (parent !== undefined) {
          const childPath = path.posix.relative(artifacts[parent].path || '.', relative);
          artifacts[parent].children[family === undefined ? childPath : path.posix.join(childPath, name)] = name;
        }
        if (!declared) continue;
        const { critics = [], ...definition } = declared;
        artifacts[declared.name] = { ...definition, path: relative, views: definition.views ?? {}, mounts: definition.mounts ?? {}, children: ownMap<string>(), ...(membership ? { family: membership } : {}) };
        localCritics[declared.name] = critics;
      }
      owner = family === undefined ? members[0].name : parent;
    }
    for (const entry of entries) if (entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name)) await walk(path.posix.join(relative, entry.name), owner, family);
  };
  if (scope) {
    const roots = [...new Set(scope.paths)].sort();
    for (const relative of roots) {
      if (roots.some(parent => parent !== relative && (parent === '' || relative.startsWith(`${parent}/`)))) continue;
      await scopedPath(root, relative);
      await walk(relative);
    }
  } else await walk('');
  if (!Object.keys(artifacts).length) throw new Error('Workspace must contain at least one ccdd.json Artifact.');
  const relations: ArtifactRelation[] = [], critics: ResolvedCriticDefinition[] = [];
  const envRequirements: NonNullable<ConfigManifest['envRequirements']> = ownMap();
  const runtimePaths = new Set<string>(), environmentPaths = new Set<string>();
  for (const [id, artifact] of Object.entries(artifacts)) {
    for (const [name, source] of Object.entries(artifact.children)) relations.push({ source, target: id, kind: 'child', name });
    for (const [alias, source] of Object.entries(artifact.mounts)) {
      if (Object.hasOwn(families, source)) throw new Error(`Mount target ${source} in ${id} is an Artifact family; mount one of its instances.`);
      if (!Object.hasOwn(artifacts, source)) throw new Error(`Unknown mount target ${source} in ${id}.`);
      if (alias === id && source !== id || (Object.hasOwn(artifacts, alias) || Object.hasOwn(families, alias)) && alias !== source) throw new Error(`Ambiguous mount alias ${alias} in ${id}.`);
      if (await lstat(path.join(root, artifact.path, alias)).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error(`Mount ${id}/${alias} conflicts with a physical entry.`);
      relations.push({ source, target: id, kind: 'mount', name: alias });
    }
    for (const declared of localCritics[id]) {
      if (scope && `${id}/${declared.id}` !== scope.criticId) continue;
      const qualifiedId = `${id}/${declared.id}`, references = ownMap<string>();
      for (const name of instructionReferences(declared.payload.instruction)) {
        const resolved = Object.hasOwn(artifact.mounts, name) ? artifact.mounts[name] : name;
        if (Object.hasOwn(families, resolved)) throw new Error(`Reference {${name}} in ${qualifiedId} names an Artifact family; reference one of its instances.`);
        if (!Object.hasOwn(artifacts, resolved)) throw new Error(`Unknown Artifact reference {${name}} in ${qualifiedId}. Escape literal braces with a backslash.`);
        references[name] = resolved;
      }
      const deps = [...new Set(Object.values(references))].filter(dep => dep !== id).sort();
      critics.push({ ...declared, localId: declared.id, id: qualifiedId, target: id, deps, references });
      for (const source of deps) relations.push({ source, target: id, kind: 'instruction', criticId: qualifiedId });
    }
    for (const tool of [...Object.values(artifact.views.agentTools ?? {}), ...Object.values(artifact.views.humanTools ?? {})]) for (const input of tool.metadata.executionPaths ?? []) runtimePaths.add(input);
    for (const [name, requirement] of Object.entries(artifact.envRequirements ?? {})) {
      const script = path.posix.join(artifact.path, requirement.script), inputs = requirement.inputs?.map(input => path.posix.join(artifact.path, input));
      envRequirements[`${id}/${name}`] = { ...requirement, script, ...(inputs ? { inputs } : {}) };
      environmentPaths.add(script); for (const input of inputs ?? []) environmentPaths.add(input);
    }
  }
  const executionInputs = runtimePaths.size ? await hashExecutionInputs(root, [...runtimePaths], signal) : undefined;
  const environmentInputs = environmentPaths.size ? await hashExecutionInputs(root, [...environmentPaths], signal) : undefined;
  const configManifest: ConfigManifest = { version: 2, configHash: hash(JSON.stringify({ artifacts, critics, relations, declarations, executionInputs, environmentInputs })), artifacts: structuredClone(artifacts), declarations,
    ...(executionInputs ? { executionInputs } : {}), ...(environmentInputs ? { environmentInputs, envRequirements } : {}) };
  const config: RepoConfig = { artifacts, critics, relations, configManifest, ...Object.values(artifacts).find(artifact => artifact.path === '')?.reviewPolicy ? { reviewPolicy: Object.values(artifacts).find(artifact => artifact.path === '')!.reviewPolicy } : {} };
  return { config: JSON.parse(JSON.stringify(config)) as RepoConfig };
}
