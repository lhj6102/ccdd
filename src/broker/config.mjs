import path from 'node:path';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
      /[\\\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Artifact path must be a safe repository-relative path: ${String(value)}`);
  }
  return value;
}

export async function readWorkspaceConfig(repoPath) {
  const root = await realpath(repoPath);
  const configPath = path.join(root, 'ccdd.config.json');
  const info = await lstat(configPath).catch(() => null);
  if (!info?.isFile()) throw new Error('Workspace must contain a regular ccdd.config.json file.');
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { throw new Error(`Cannot read workspace configuration: ${error.message}`); }
  // Inspect only declared Artifact roots here. The workspace engine validates the entire input tree.
  const tree = [];
  const visited = new Set();
  const walk = async relative => {
    if (visited.has(relative)) return;
    visited.add(relative);
    const absolute = path.join(root, relative);
    const entry = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
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
  if (object(config?.artifacts)) {
    for (const artifact of Object.values(config.artifacts)) {
      if (object(artifact)) { validateRelativePath(artifact.path); await walk(artifact.path); }
    }
  }
  validateConfig(config, tree);
  return { config };
}

export function validateConfig(config, tree) {
  if (!object(config) || !object(config.artifacts) || !object(config.artifactTypes) ||
      !Array.isArray(config.critics) || config.critics.length === 0 || config.critics.length > 32) {
    throw new Error('Config requires artifacts, artifactTypes, and 1–32 ordered critics.');
  }
  for (const [type, definition] of Object.entries(config.artifactTypes)) {
    if (!identifier.test(type) || !object(definition) || !['text', 'files'].includes(definition.viewer)) {
      throw new Error(`Invalid artifact type/viewer: ${type}`);
    }
  }
  for (const [id, artifact] of Object.entries(config.artifacts)) {
    if (!identifier.test(id) || !object(artifact) || !Object.hasOwn(config.artifactTypes, artifact.type)) {
      throw new Error(`Invalid artifact definition or unknown type: ${id}`);
    }
    validateRelativePath(artifact.path);
    const entries = tree.filter(entry => entry.path === artifact.path || entry.path.startsWith(`${artifact.path}/`));
    if (entries.length === 0 || entries.some(entry => !['blob', 'tree'].includes(entry.type) || entry.mode === '120000')) {
      throw new Error(`Artifact must contain workspace files or directories without symlinks: ${id}`);
    }
    if (config.artifactTypes[artifact.type].viewer === 'text' && !entries.some(entry => entry.path === artifact.path && entry.type === 'blob')) {
      throw new Error(`Text viewer requires a file artifact: ${id}`);
    }
  }
  const seen = new Set();
  for (const [index, critic] of config.critics.entries()) {
    if (!object(critic) || !identifier.test(critic.id) || seen.has(critic.id)) throw new Error('Critic IDs must be unique safe identifiers.');
    seen.add(critic.id);
    if (critic.dependsOn !== (index === 0 ? null : config.critics[index - 1].id)) {
      throw new Error('Critics must form one ordered, strictly linear dependency chain.');
    }
    if (typeof critic.title !== 'string' || !critic.title.trim() ||
        !Array.isArray(critic.artifacts) || critic.artifacts.length === 0 ||
        new Set(critic.artifacts).size !== critic.artifacts.length ||
        critic.artifacts.some(id => typeof id !== 'string' || !Object.hasOwn(config.artifacts, id))) {
      throw new Error(`Critic ${critic.id} requires a title and known artifact references.`);
    }
    if (!object(critic.payload) || typeof critic.payload.instruction !== 'string' || !critic.payload.instruction.trim()) {
      throw new Error(`Critic ${critic.id} requires a review request payload instruction.`);
    }
    const profile = critic.profile;
    if (!object(profile) || !['agent', 'runtime', 'human'].includes(profile.kind)) throw new Error(`Invalid executor profile: ${critic.id}`);
    if (profile.kind === 'agent' && ['provider', 'model', 'reasoning'].some(key => typeof profile[key] !== 'string' || !profile[key].trim())) {
      throw new Error(`Agent profile requires provider, model and reasoning: ${critic.id}`);
    }
    if (profile.kind === 'runtime' && (typeof profile.command !== 'string' || !profile.command.trim() ||
        !Array.isArray(profile.args) || profile.args.some(arg => typeof arg !== 'string'))) {
      throw new Error(`Runtime profile requires command and string args: ${critic.id}`);
    }
  }
}
