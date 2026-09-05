import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function git(repoPath, args, options = {}) {
  const { stdout } = await exec('git', ['-C', repoPath, ...args], {
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30_000, ...options,
  });
  return stdout;
}

export function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
      /[\\\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Artifact path must be a safe repository-relative path: ${String(value)}`);
  }
  return value;
}

export async function readSnapshotConfig(repoPath, snapshotCommit) {
  if (typeof snapshotCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(snapshotCommit)) {
    throw new Error('snapshotCommit must be a full immutable Git commit hash.');
  }
  const resolved = (await git(repoPath, ['rev-parse', '--verify', `${snapshotCommit}^{commit}`])).trim();
  if (resolved !== snapshotCommit.toLowerCase()) throw new Error('snapshotCommit must identify a commit directly.');
  const tree = (await git(repoPath, ['ls-tree', '-rz', '--full-tree', resolved])).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const [mode, type] = line.slice(0, tab).split(' ');
    return { mode, type, path: line.slice(tab + 1) };
  });
  const configEntry = tree.find(entry => entry.path === 'ccdd.config.json');
  if (!configEntry || configEntry.type !== 'blob' || configEntry.mode === '120000') {
    throw new Error('Snapshot must contain a regular ccdd.config.json file.');
  }
  let config;
  try { config = JSON.parse(await git(repoPath, ['show', `${resolved}:ccdd.config.json`])); }
  catch (error) { throw new Error(`Cannot read snapshot configuration: ${error.message}`); }
  validateConfig(config, tree);
  return { config, snapshotCommit: resolved };
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
    if (entries.length === 0 || entries.some(entry => entry.type !== 'blob' || entry.mode === '120000')) {
      throw new Error(`Artifact must contain snapshot files without symlinks/submodules: ${id}`);
    }
    if (config.artifactTypes[artifact.type].viewer === 'text' && !entries.some(entry => entry.path === artifact.path)) {
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
