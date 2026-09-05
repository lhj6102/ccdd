import { createHash, randomUUID } from 'node:crypto';
import { constants, watch } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const HASH = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const contained = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const failure = (message, code = 'WORKSPACE_UNSAFE') => Object.assign(new Error(message), { code });
const changed = (mode, detail = '') => failure(`Review workspace changed${detail ? `: ${detail}` : '.'}`, mode === 'copy' ? 'WORKSPACE_CACHE_TAMPERED' : 'WORKSPACE_CHANGED');

async function canonicalFuturePath(value) {
  const resolved = path.resolve(value);
  try { return await realpath(resolved); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(await canonicalFuturePath(parent), path.basename(resolved));
  }
}

/** State, events, caches and review outputs must never be part of the observed input. */
export async function validateStateLocation(repoPath, stateDir) {
  if (typeof repoPath !== 'string' || !repoPath || typeof stateDir !== 'string' || !stateDir) {
    throw failure('repoPath and an external stateDir are required.');
  }
  const source = await realpath(repoPath);
  if (!(await lstat(source)).isDirectory()) throw failure('Workspace must be a directory.');
  const state = await canonicalFuturePath(stateDir);
  if (contained(source, state)) throw failure('CCDD stateDir must be outside the source workspace.');
  return { repoPath: source, stateDir: state };
}

function metadata(info) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].map(String);
}

/** Every entry participates: no Git, ignore rules, extension filters or implicit exclusions. */
async function inspect(root, { signal, requireReadonly = false, contents = true } = {}) {
  const entries = [];
  const metadataEntries = [];
  const walk = async relative => {
    signal?.throwIfAborted();
    const absolute = relative ? path.join(root, relative) : root;
    const before = await lstat(absolute, { bigint: true });
    metadataEntries.push([relative, ...metadata(before)]);
    if (requireReadonly && !before.isSymbolicLink() && (before.mode & 0o222n)) throw changed('copy', `writable cache entry ${relative || '.'}`);
    if (before.isDirectory()) {
      if (relative) entries.push({ path: relative, type: 'directory', executable: Number(before.mode & 0o111n) });
      const names = (await readdir(absolute)).sort();
      for (const name of names) await walk(relative ? `${relative}/${name}` : name);
    } else if (before.isFile() && contents) {
      const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content;
      try {
        const opened = await file.stat({ bigint: true });
        if (JSON.stringify(metadata(before)) !== JSON.stringify(metadata(opened))) throw changed('lock', relative);
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(128 * 1024);
        let position = 0;
        while (true) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          hash.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        content = hash.digest('hex');
      } finally { await file.close(); }
      entries.push({ path: relative, type: 'file', executable: Number(before.mode & 0o111n), content });
    } else if (before.isFile()) {
      entries.push({ path: relative, type: 'file', executable: Number(before.mode & 0o111n) });
    } else if (before.isSymbolicLink()) {
      const target = await readlink(absolute);
      if (path.isAbsolute(target) || !contained(root, path.resolve(path.dirname(absolute), target))) {
        throw failure(`Workspace symlink must be relative and stay inside the workspace: ${relative}`);
      }
      let resolved;
      try { resolved = await realpath(absolute); }
      catch { throw failure(`Workspace symlink must resolve to an existing internal entry: ${relative}`); }
      if (!contained(root, resolved)) throw failure(`Workspace symlink escapes the workspace: ${relative}`);
      entries.push({ path: relative, type: 'symlink', target });
    } else {
      throw failure(`Unsupported workspace entry (only directories, regular files and internal symlinks are supported): ${relative}`);
    }
    const after = await lstat(absolute, { bigint: true });
    if (JSON.stringify(metadata(before)) !== JSON.stringify(metadata(after))) throw changed('lock', relative || '.');
  };
  await walk('');
  return { hash: digest(JSON.stringify(entries)), metadataHash: digest(JSON.stringify(metadataEntries)), entries };
}

export async function fingerprintWorkspace(workspacePath) {
  return (await inspect(await realpath(workspacePath))).hash;
}

function observe(root, mode, externalSignal) {
  const controller = new AbortController();
  let closed = false;
  let watcher;
  let timer;
  let scanning;
  let baseline;
  let initialized = false;
  let eventPending = false;
  const abort = reason => { if (!controller.signal.aborted) controller.abort(reason); };
  const externalAbort = () => abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', externalAbort, { once: true });
  if (externalSignal?.aborted) externalAbort();
  try {
    watcher = watch(root, { recursive: true }, () => {
      eventPending = true;
      if (initialized) void check(false).catch(() => {});
    });
    watcher.on('error', error => abort(failure(`Cannot monitor review workspace: ${error.message}`)));
  } catch (error) {
    externalSignal?.removeEventListener('abort', externalAbort);
    throw failure(`Cannot monitor review workspace: ${error.message}`);
  }
  const check = async (contents = true) => {
    controller.signal.throwIfAborted();
    if (closed) throw failure('Workspace handle is closed.');
    if (scanning) {
      await scanning;
      // A caller asking for a full validation must not inherit a metadata-only poll.
      if (!contents) return;
    }
    scanning = (async () => {
      let current;
      do {
        eventPending = false;
        current = await inspect(root, { signal: controller.signal, requireReadonly: mode === 'copy', contents });
        if (baseline && ((contents && current.hash !== baseline.hash) || current.metadataHash !== baseline.metadataHash)) throw changed(mode);
        controller.signal.throwIfAborted();
      } while (eventPending);
      return current;
    })().catch(error => {
      if (mode === 'copy' && error.code === 'WORKSPACE_CHANGED') error = changed(mode, error.message);
      abort(error);
      throw error;
    }).finally(() => { scanning = undefined; });
    return scanning;
  };
  return {
    signal: controller.signal,
    async initialize(expected) {
      const before = await inspect(root, { signal: controller.signal, requireReadonly: mode === 'copy', contents: false });
      const current = await inspect(root, { signal: controller.signal, requireReadonly: mode === 'copy' });
      if (before.metadataHash !== current.metadataHash) throw changed(mode, 'input changed while acquiring the workspace');
      baseline = current;
      if (expected && (expected.hash !== baseline.hash || expected.metadataHash !== baseline.metadataHash)) {
        abort(changed(mode, 'input changed since the request was prepared'));
        controller.signal.throwIfAborted();
      }
      initialized = true;
      if (eventPending) await check(false);
      // FSEvents can deliver notifications from before watch registration. Compare ctime/inode
      // metadata rather than treating a delayed notification alone as a new mutation.
      timer = setInterval(() => { if (!closed && !controller.signal.aborted) void check(false).catch(() => {}); }, 1000);
      timer.unref();
      return baseline;
    },
    assertUnchanged: check,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      watcher.close();
      externalSignal?.removeEventListener('abort', externalAbort);
      await scanning?.catch(() => {});
    },
  };
}

async function copyEntries(source, destination, entries, signal) {
  for (const entry of entries) {
    signal?.throwIfAborted();
    const target = path.join(destination, entry.path);
    if (entry.type === 'directory') await mkdir(target, { mode: 0o700 });
    else if (entry.type === 'symlink') await symlink(entry.target, target);
    else {
      await copyFile(path.join(source, entry.path), target, constants.COPYFILE_EXCL);
      await chmod(target, 0o444 | entry.executable);
    }
  }
  for (const entry of [...entries].reverse()) {
    if (entry.type === 'directory') await chmod(path.join(destination, entry.path), 0o444 | entry.executable);
  }
  await chmod(destination, 0o555);
}

async function acquirePublication(cacheRoot, hash, signal) {
  const lockPath = path.join(cacheRoot, `.publish-${hash}`);
  const deadline = Date.now() + 30_000;
  while (true) {
    signal?.throwIfAborted();
    try {
      const lock = await open(lockPath, 'wx', 0o600);
      const identity = await lock.stat();
      try { await lock.writeFile(JSON.stringify({ pid: process.pid })); }
      catch (error) { await lock.close(); await unlink(lockPath).catch(() => {}); throw error; }
      return async () => {
        await lock.close();
        const current = await lstat(lockPath).catch(() => null);
        if (current?.ino === identity.ino && current?.dev === identity.dev) await unlink(lockPath);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const identity = await lstat(lockPath).catch(() => null);
      if (identity?.isSymbolicLink()) throw failure('Cache publication lock must not be a symlink.');
      const owner = await readFile(lockPath, 'utf8').then(JSON.parse).catch(() => null);
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        let dead = false;
        try { process.kill(owner.pid, 0); } catch (probeError) { dead = probeError.code === 'ESRCH'; }
        const current = await lstat(lockPath).catch(() => null);
        if (dead && current?.ino === identity?.ino && current?.dev === identity?.dev) {
          await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
          continue;
        }
      }
      if (Date.now() >= deadline) throw failure('Workspace cache publication is busy; retry this request.');
      await delay(20, undefined, { signal });
    }
  }
}

/** Delete only caller-owned private scratch, never a shared cache or a source workspace. */
export async function removeOwnedWorkspaceTree(directory) {
  // Only unpublished private staging is made writable; shared cache inputs are never mutated.
  const makeWritable = async current => {
    const info = await lstat(current);
    if (!info.isDirectory()) return;
    await chmod(current, 0o700);
    for (const name of await readdir(current)) await makeWritable(path.join(current, name));
  };
  try { await makeWritable(directory); await rm(directory, { recursive: true, force: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function prepareWorkspace({ repoPath, stateDir, mode = 'copy', signal } = {}) {
  if (!['copy', 'lock'].includes(mode)) throw failure('Workspace mode must be copy or lock.');
  const canonical = await validateStateLocation(repoPath, stateDir);
  const source = canonical.repoPath;
  const observer = observe(source, 'lock', signal);
  let stage;
  let releasePublication;
  try {
    const initial = await observer.initialize();
    if (mode === 'lock') {
      const descriptor = Object.freeze({ version: 1, mode, sourcePath: source, path: source, hash: initial.hash, stateDir: canonical.stateDir, baselineMetadataHash: initial.metadataHash });
      return { descriptor, signal: observer.signal, assertUnchanged: observer.assertUnchanged, close: observer.close };
    }
    const cacheRoot = path.join(canonical.stateDir, 'workspaces');
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    if (await realpath(cacheRoot) !== cacheRoot) throw failure('Workspace cache directory must not be a symlink.');
    const destination = path.join(cacheRoot, initial.hash);
    releasePublication = await acquirePublication(cacheRoot, initial.hash, observer.signal);
    let cached;
    try {
      if (!(await lstat(destination)).isDirectory()) throw changed('copy', 'cache root must be a regular directory');
      cached = await inspect(destination, { signal, requireReadonly: true });
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cached && cached.hash !== initial.hash) throw changed('copy', 'cached content does not match its hash');
    if (!cached) {
      stage = path.join(cacheRoot, `.capture-${randomUUID()}`);
      await mkdir(stage, { mode: 0o700 });
      await copyEntries(source, stage, initial.entries, observer.signal);
      const copied = await inspect(stage, { signal: observer.signal, requireReadonly: true });
      if (copied.hash !== initial.hash) throw changed('lock', 'source changed during copy');
      await observer.assertUnchanged();
      await rename(stage, destination);
      stage = undefined;
    }
    await observer.assertUnchanged();
    await observer.close();
    if (stage) { await removeOwnedWorkspaceTree(stage); stage = undefined; }
    await releasePublication();
    releasePublication = undefined;
    const verified = await inspect(destination, { signal, requireReadonly: true });
    if (verified.hash !== initial.hash) throw changed('copy', 'cached content does not match its hash');
    const descriptor = Object.freeze({ version: 1, mode, sourcePath: source, path: destination, hash: initial.hash, stateDir: canonical.stateDir, baselineMetadataHash: verified.metadataHash });
    return await reopenWorkspace(descriptor, { signal });
  } catch (error) {
    await observer.close();
    if (stage) await removeOwnedWorkspaceTree(stage);
    await releasePublication?.();
    throw error;
  }
}

export async function reopenWorkspace(descriptor, { signal } = {}) {
  if (!descriptor || descriptor.version !== 1 || !['copy', 'lock'].includes(descriptor.mode) ||
      !HASH.test(descriptor.hash ?? '') || !HASH.test(descriptor.baselineMetadataHash ?? '') ||
      ['sourcePath', 'path', 'stateDir'].some(key => typeof descriptor[key] !== 'string' || !path.isAbsolute(descriptor[key]))) {
    throw failure('Invalid persisted workspace descriptor.');
  }
  const { mode, sourcePath, stateDir } = descriptor;
  if (contained(sourcePath, stateDir)) throw failure('Persisted stateDir must be outside the source workspace.');
  const expectedPath = mode === 'lock' ? sourcePath : path.join(stateDir, 'workspaces', descriptor.hash);
  if (descriptor.path !== expectedPath || await realpath(descriptor.path) !== expectedPath || !(await lstat(expectedPath)).isDirectory()) {
    throw failure('Persisted workspace descriptor has an invalid input path.');
  }
  const observer = observe(expectedPath, mode, signal);
  try {
    await observer.initialize({ hash: descriptor.hash, metadataHash: descriptor.baselineMetadataHash });
    return { descriptor: Object.freeze({ ...descriptor }), signal: observer.signal, assertUnchanged: observer.assertUnchanged, close: observer.close };
  } catch (error) { await observer.close(); throw error; }
}
