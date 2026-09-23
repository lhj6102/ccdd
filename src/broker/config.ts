import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import type { ArtifactManifest, ArtifactDefinition, CriticDefinition, ResolvedCriticDefinition, ArtifactRelation } from '../definitions.js';
import type { ArtifactViews, ConfigManifest, ScriptDefinition } from '../tools/contracts.js';
import type { RepoConfig } from '../contracts.js';
import { metadata, environmentRequirements, object, projectInputPath } from '../tools/schema.js';
import { hashExecutionInputs } from '../tools/inputs.js';
import { instructionReferences } from '../artifacts/instruction.js';

export const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const criticIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
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
function critic(value: unknown): CriticDefinition {
  if (!object(value)) throw new Error('Invalid Critic declaration.');
  fields(value, ['id', 'title', 'profile', 'payload'], 'Critic');
  if (typeof value.id !== 'string' || !identifier.test(value.id) || typeof value.title !== 'string' || !value.title.trim()) throw new Error('A Critic needs a local id and title.');
  if (!object(value.payload) || typeof value.payload.instruction !== 'string' || !value.payload.instruction.trim()) throw new Error('A Critic needs payload.instruction.');
  const profile = value.profile;
  if (!object(profile) || !['agent', 'human', 'runtime'].includes(profile.kind)) throw new Error('Invalid Critic profile.');
  if (profile.kind === 'agent') {
    fields(profile, ['kind', 'provider', 'model', 'reasoning', 'timeoutMs'], 'Agent profile');
    if (['provider', 'model', 'reasoning'].some(key => typeof profile[key] !== 'string' || !profile[key].trim())) throw new Error('Agent profiles require provider, model and reasoning.');
  } else if (profile.kind === 'human') fields(profile, ['kind'], 'Human profile');
  else {
    fields(profile, ['kind', 'command', 'args', 'timeoutMs'], 'Runtime profile');
    validateScript({ command: profile.command, args: profile.args });
  }
  if (profile.timeoutMs !== undefined && (!Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1 || profile.timeoutMs > 86400000)) throw new Error('Invalid Critic timeoutMs.');
  return structuredClone(value) as CriticDefinition;
}
function manifest(value: unknown): ArtifactManifest {
  if (!object(value)) throw new Error('ccdd.json must contain an Artifact object.');
  fields(value, ['name', 'critics', 'views', 'mounts', 'basis', 'stale', 'envRequirements'], 'Artifact');
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
    if (!object(value.stale) || !['always', 'file-hash'].includes(value.stale.kind)) throw new Error('Invalid stale strategy.');
    fields(value.stale, value.stale.kind === 'always' ? ['kind'] : ['kind', 'paths'], 'stale');
    if (value.stale.paths !== undefined) {
      if (!Array.isArray(value.stale.paths) || !value.stale.paths.length) throw new Error('stale.paths must be a nonempty array.');
      value.stale.paths.forEach(projectInputPath);
    }
  }
  return { name: value.name, critics, views: views(value.views), mounts,
    ...(value.basis === undefined ? {} : { basis: value.basis }), ...(value.stale === undefined ? {} : { stale: structuredClone(value.stale) }),
    ...(value.envRequirements === undefined ? {} : { envRequirements: environmentRequirements(value.envRequirements) }) };
}

/** Discover static per-folder declarations. No imports, generators, tools, or Providers run here. */
export async function readWorkspaceConfig(repoPath: string, signal?: AbortSignal): Promise<{ config: RepoConfig }> {
  const root = await realpath(repoPath), artifacts = ownMap<ArtifactDefinition>(), declarations: ConfigManifest['declarations'] = [];
  const localCritics = ownMap<CriticDefinition[]>();
  const walk = async (relative: string, parent?: string): Promise<void> => {
    signal?.throwIfAborted();
    const absolute = path.join(root, relative), entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const marker = entries.find(entry => entry.name === 'ccdd.json');
    let owner = parent;
    if (marker) {
      if (!marker.isFile()) throw new Error(`ccdd.json must be a regular file: ${relative || '.'}`);
      const file = path.posix.join(relative, 'ccdd.json'), text = await readFile(path.join(root, file), 'utf8');
      let declared: ArtifactManifest;
      try { declared = manifest(JSON.parse(text)); } catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
      if (Object.hasOwn(artifacts, declared.name)) throw new Error(`Duplicate Artifact name: ${declared.name}`);
      const { critics = [], ...definition } = declared;
      artifacts[declared.name] = { ...definition, path: relative, views: definition.views ?? {}, mounts: definition.mounts ?? {}, children: ownMap<string>() };
      localCritics[declared.name] = critics;
      declarations.push({ path: file, hash: hash(text) });
      if (parent !== undefined) {
        const childPath = path.posix.relative(artifacts[parent].path || '.', relative);
        artifacts[parent].children[childPath] = declared.name;
      }
      owner = declared.name;
    }
    for (const entry of entries) if (entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name)) await walk(path.posix.join(relative, entry.name), owner);
  };
  await walk('');
  if (!Object.keys(artifacts).length) throw new Error('Workspace must contain at least one ccdd.json Artifact.');
  const relations: ArtifactRelation[] = [], critics: ResolvedCriticDefinition[] = [];
  const envRequirements: NonNullable<ConfigManifest['envRequirements']> = ownMap();
  const runtimePaths = new Set<string>(), environmentPaths = new Set<string>();
  for (const [id, artifact] of Object.entries(artifacts)) {
    for (const [name, source] of Object.entries(artifact.children)) relations.push({ source, target: id, kind: 'child', name });
    for (const [alias, source] of Object.entries(artifact.mounts)) {
      if (!Object.hasOwn(artifacts, source)) throw new Error(`Unknown mount target ${source} in ${id}.`);
      if (alias === id && source !== id || Object.hasOwn(artifacts, alias) && alias !== source) throw new Error(`Ambiguous mount alias ${alias} in ${id}.`);
      if (await lstat(path.join(root, artifact.path, alias)).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error(`Mount ${id}/${alias} conflicts with a physical entry.`);
      relations.push({ source, target: id, kind: 'mount', name: alias });
    }
    for (const declared of localCritics[id]) {
      const qualifiedId = `${id}/${declared.id}`, references = ownMap<string>();
      for (const name of instructionReferences(declared.payload.instruction)) {
        const resolved = Object.hasOwn(artifact.mounts, name) ? artifact.mounts[name] : name;
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
  const config: RepoConfig = { artifacts, critics, relations, configManifest };
  return { config: JSON.parse(JSON.stringify(config)) as RepoConfig };
}
