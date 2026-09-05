import path from 'node:path';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { validateArtifactType } from '../artifacts/types.js';
import { createGraphDefinition } from './graph.js';
import type { RepoConfig } from '../contracts.js';

export interface WorkspaceTreeEntry { path: string; type: string; mode: string }
const errorCode = (error: unknown) => error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
      /[\\\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Artifact path must be a safe repository-relative path: ${String(value)}`);
  }
  return value;
}

export async function readWorkspaceConfig(repoPath: string): Promise<{ config: RepoConfig }> {
  const root = await realpath(repoPath);
  const configPath = path.join(root, 'ccdd.config.json');
  const info = await lstat(configPath).catch(() => null);
  if (!info?.isFile()) throw new Error('Workspace must contain a regular ccdd.config.json file.');
  let config: unknown;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { throw new Error(`Cannot read workspace configuration: ${error instanceof Error ? error.message : String(error)}`); }
  // Inspect only declared Artifact roots here. The workspace engine validates the entire input tree.
  const tree: WorkspaceTreeEntry[] = [];
  const visited = new Set<string>();
  const walk = async (relative: string): Promise<void> => {
    if (visited.has(relative)) return;
    visited.add(relative);
    const absolute = path.join(root, relative);
    const entry = await lstat(absolute).catch(error => { if (errorCode(error) === 'ENOENT') return null; throw error; });
    if (!entry) return;
    const resolved = await realpath(absolute);
    const sub = path.relative(root, resolved);
    if (path.isAbsolute(sub) || sub === '..' || sub.startsWith(`..${path.sep}`)) throw new Error(`Artifact escapes the workspace: ${relative}`);
    if (entry.isDirectory()) {
      tree.push({ path: relative, type: 'tree', mode: '040000' });
      for (const name of await readdir(absolute)) await walk(`${relative}/${name}`);
    } else {
      tree.push({ path: relative, type: entry.isFile() ? 'blob' : 'unsupported', mode: entry.isSymbolicLink() ? '120000' : '100644' });
    }
  };
  if (object(config) && object(config.artifacts)) {
    for (const artifact of Object.values(config.artifacts)) {
      if (object(artifact)) { await walk(validateRelativePath(artifact.path)); }
    }
  }
  validateConfig(config, tree);
  return { config };
}

export function validateConfig(config: unknown, tree: WorkspaceTreeEntry[]): asserts config is RepoConfig {
  if (!object(config) || !object(config.artifacts) || !object(config.artifactTypes) ||
      !Array.isArray(config.critics) || config.critics.length === 0 || config.critics.length > 32) {
    throw new Error('Config requires artifacts, artifactTypes, and 1–32 critics.');
  }
  for (const [type, definition] of Object.entries(config.artifactTypes)) {
    validateArtifactType(type, definition);
  }
  for (const [id, artifact] of Object.entries(config.artifacts)) {
    if (!identifier.test(id) || !object(artifact) || typeof artifact.type !== 'string' || !Object.hasOwn(config.artifactTypes, artifact.type) || (artifact.basis !== undefined && typeof artifact.basis !== 'boolean')) {
      throw new Error(`Invalid artifact definition or unknown type: ${id}`);
    }
    const artifactPath = validateRelativePath(artifact.path);
    const entries = tree.filter(entry => entry.path === artifactPath || entry.path.startsWith(`${artifactPath}/`));
    if (entries.length === 0 || entries.some(entry => !['blob', 'tree'].includes(entry.type) || entry.mode === '120000')) {
      throw new Error(`Artifact must contain workspace files or directories without symlinks: ${id}`);
    }
    if ((config.artifactTypes[artifact.type] as { viewer: string }).viewer === 'text' && !entries.some(entry => entry.path === artifactPath && entry.type === 'blob')) {
      throw new Error(`Text viewer requires a file artifact: ${id}`);
    }
  }
  const artifacts = config.artifacts;
  const seen = new Set<string>();
  for (const critic of config.critics) {
    if (!object(critic) || typeof critic.id !== 'string' || !identifier.test(critic.id) || seen.has(critic.id)) throw new Error('Critic IDs must be unique safe identifiers.');
    seen.add(critic.id);
    if (Object.hasOwn(critic, 'dependsOn') || Object.hasOwn(critic, 'artifacts')) {
      throw new Error(`Critic ${critic.id}: dependsOn/artifacts have been replaced by target (one Artifact ID) and deps (Artifact ID array). Migrate the configuration explicitly; see docs/artifact-graph.md.`);
    }
    if (typeof critic.title !== 'string' || !critic.title.trim() ||
        typeof critic.target !== 'string' || !Object.hasOwn(artifacts, critic.target) ||
        !Array.isArray(critic.deps) || new Set(critic.deps).size !== critic.deps.length ||
        critic.deps.some(id => typeof id !== 'string' || !Object.hasOwn(artifacts, id))) {
      throw new Error(`Critic ${critic.id} requires a title, a known target Artifact and unique known deps.`);
    }
    if (!object(critic.payload) || typeof critic.payload.instruction !== 'string' || !critic.payload.instruction.trim()) {
      throw new Error(`Critic ${critic.id} requires a review request payload instruction.`);
    }
    const profile = critic.profile;
    if (!object(profile) || typeof profile.kind !== 'string' || !['agent', 'runtime', 'human'].includes(profile.kind)) throw new Error(`Invalid executor profile: ${critic.id}`);
    if (profile.kind === 'agent' && ['provider', 'model', 'reasoning'].some(key => typeof profile[key] !== 'string' || !(profile[key] as string).trim())) {
      throw new Error(`Agent profile requires provider, model and reasoning: ${critic.id}`);
    }
    if (profile.kind === 'runtime' && (typeof profile.command !== 'string' || !profile.command.trim() ||
        !Array.isArray(profile.args) || profile.args.some(arg => typeof arg !== 'string'))) {
      throw new Error(`Runtime profile requires command and string args: ${critic.id}`);
    }
  }
  createGraphDefinition(config as unknown as RepoConfig);
}
