import { createHash, randomUUID } from 'node:crypto';
import { constants, watch, type BigIntStats, type FSWatcher } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

export type WorkspaceMode = 'copy' | 'lock';
export type WorkspaceIntegrity = 'content' | 'metadata';
export interface WorkspaceDescriptor {
  version: 1; mode: WorkspaceMode; sourcePath: string; path: string;
  hash: string; stateDir: string; baselineMetadataHash: string;
  integrity?: WorkspaceIntegrity; structureHash?: string;
}
export interface WorkspaceHandle {
  descriptor: Readonly<WorkspaceDescriptor>; signal: AbortSignal;
  assertUnchanged: () => Promise<unknown>; close: () => Promise<void>;
}
export interface WorkspaceScanProgress { kind: 'metadata' | 'content'; files: number; bytes: number; completed: boolean }
type WorkspaceEntry = { path: string; type: 'directory'; executable: number }
  | { path: string; type: 'file'; executable: number; content?: string }
  | { path: string; type: 'symlink'; target: string };
interface Inspection { hash: string; metadataHash: string; structureHash: string; entries: WorkspaceEntry[]; publicationMetadataHash?: string }
interface ScanNode {
  relative: string; parent?: ScanNode; entry?: WorkspaceEntry;
  metadata?: string[]; children?: ScanNode[]; remaining?: number;
}
// Bound open files, filesystem requests and 128 KiB hash buffers independently of tree width.
const SCAN_CONCURRENCY = 8;
const errorCode = (error: unknown): unknown => error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const HASH = /^[a-f0-9]{64}$/;
const validHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const contained = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const failure = (message: string, code = 'WORKSPACE_UNSAFE') => Object.assign(new Error(message), { code });
const changed = (mode: WorkspaceMode, detail = '') => failure(`Review workspace changed${detail ? `: ${detail}` : '.'}`, mode === 'copy' ? 'WORKSPACE_CACHE_TAMPERED' : 'WORKSPACE_CHANGED');

async function canonicalFuturePath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try { return await realpath(resolved); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(await canonicalFuturePath(parent), path.basename(resolved));
  }
}

/** State, events, caches and review outputs must never be part of the observed input. */
export async function validateStateLocation(repoPath: unknown, stateDir: unknown) {
  if (typeof repoPath !== 'string' || !repoPath || typeof stateDir !== 'string' || !stateDir) {
    throw failure('repoPath and an external stateDir are required.');
  }
  const source = await realpath(repoPath);
  if (!(await lstat(source)).isDirectory()) throw failure('Workspace must be a directory.');
  const state = await canonicalFuturePath(stateDir);
  if (contained(source, state)) throw failure('CCDD stateDir must be outside the source workspace.');
  return { repoPath: source, stateDir: state };
}

function metadata(info: BigIntStats) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].map(String);
}

/** Permit the root ctime change from publication; retain every child tuple and root identity. */
function publicationMetadataHash(entries: string[][]): string {
  const [rootPath, dev, ino, mode, size, mtime, , birthtime] = entries[0];
  return digest(JSON.stringify([[rootPath, dev, ino, mode, size, mtime, birthtime], ...entries.slice(1)]));
}

/** Every entry participates: no Git, ignore rules, extension filters or implicit exclusions. */
async function inspect(root: string, { signal, requireReadonly = false, contents = true, publicationProof = false, onProgress }: { signal?: AbortSignal; requireReadonly?: boolean; contents?: boolean; publicationProof?: boolean; onProgress?: (progress: WorkspaceScanProgress) => void } = {}): Promise<Inspection> {
  const mode = requireReadonly ? 'copy' : 'lock';
  const entries: WorkspaceEntry[] = [];
  const metadataEntries: string[][] = [];
  const rootNode: ScanNode = { relative: '' };
  let files = 0, bytes = 0, lastProgress = 0;
  const progress = (force = false, completed = false) => {
    if (!onProgress || (!force && Date.now() - lastProgress < 1000)) return;
    lastProgress = Date.now();
    onProgress({ kind: contents ? 'content' : 'metadata', files, bytes, completed });
  };
  progress(true);
  await new Promise<void>((resolve, reject) => {
    const pending: Array<(() => Promise<void>) | undefined> = [];
    let next = 0, active = 0, stopped = false;
    let firstError: unknown;
    const check = () => { if (stopped) throw firstError; signal?.throwIfAborted(); };
    const enqueue = (task: () => Promise<void>) => { if (!stopped) pending.push(task); };
    const complete = (node: ScanNode) => {
      const parent = node.parent;
      if (parent) {
        parent.remaining = parent.remaining! - 1;
        if (!parent.remaining) enqueue(() => finishDirectory(parent));
      }
    };
    const finishDirectory = async (node: ScanNode) => {
      check();
      const after = await lstat(node.relative ? path.join(root, node.relative) : root, { bigint: true });
      if (JSON.stringify(node.metadata) !== JSON.stringify(metadata(after))) throw changed(mode, node.relative || '.');
      complete(node);
    };
    const walk = async (node: ScanNode): Promise<void> => {
      check();
      const relative = node.relative;
      const absolute = relative ? path.join(root, relative) : root;
      const before = await lstat(absolute, { bigint: true });
      node.metadata = metadata(before);
      if (requireReadonly && !before.isSymbolicLink() && (before.mode & 0o222n)) throw changed('copy', `writable cache entry ${relative || '.'}`);
      if (before.isDirectory()) {
        if (relative) node.entry = { path: relative, type: 'directory', executable: Number(before.mode & 0o111n) };
        const names = (await readdir(absolute)).sort();
        node.children = names.map(name => ({ relative: relative ? `${relative}/${name}` : name, parent: node }));
        node.remaining = names.length;
        for (const child of node.children) enqueue(() => walk(child));
        if (!node.remaining) enqueue(() => finishDirectory(node));
        return;
      } else if (before.isFile() && contents) {
        const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        let content;
        try {
          const opened = await file.stat({ bigint: true });
          if (JSON.stringify(metadata(before)) !== JSON.stringify(metadata(opened))) throw changed(mode, relative);
          const hash = createHash('sha256');
          const buffer = Buffer.allocUnsafe(128 * 1024);
          let position = 0;
          while (true) {
            check();
            const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
            bytes += bytesRead;
            progress();
          }
          content = hash.digest('hex');
        } finally { await file.close(); }
        node.entry = { path: relative, type: 'file', executable: Number(before.mode & 0o111n), content };
        files++; progress();
      } else if (before.isFile()) {
        node.entry = { path: relative, type: 'file', executable: Number(before.mode & 0o111n) };
        files++; progress();
      } else if (before.isSymbolicLink()) {
        const target = await readlink(absolute);
        if (path.isAbsolute(target) || !contained(root, path.resolve(path.dirname(absolute), target))) {
          throw failure(`Workspace symlink must be relative and stay inside the workspace: ${relative}`);
        }
        let resolved;
        try { resolved = await realpath(absolute); }
        catch { throw failure(`Workspace symlink must resolve to an existing internal entry: ${relative}`); }
        if (!contained(root, resolved)) throw failure(`Workspace symlink escapes the workspace: ${relative}`);
        node.entry = { path: relative, type: 'symlink', target };
      } else {
        throw failure(`Unsupported workspace entry (only directories, regular files and internal symlinks are supported): ${relative}`);
      }
      const after = await lstat(absolute, { bigint: true });
      if (JSON.stringify(metadata(before)) !== JSON.stringify(metadata(after))) throw changed(mode, relative || '.');
      complete(node);
    };
    const pump = () => {
      while (!stopped && active < SCAN_CONCURRENCY && next < pending.length) {
        const task = pending[next]!;
        pending[next++] = undefined;
        active++;
        void task().then(() => { active--; pump(); }, error => {
          if (!stopped) { stopped = true; firstError = error; pending.length = 0; next = 0; }
          active--;
          pump();
        });
      }
      // Reject only after active readers have closed their handles in finally blocks.
      if (!active && (stopped || next === pending.length)) stopped ? reject(firstError) : resolve();
    };
    enqueue(() => walk(rootNode));
    pump();
  });
  signal?.throwIfAborted();
  // Preserve the existing sorted depth-first wire identity, regardless of IO completion order.
  const stack = [rootNode];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.entry) entries.push(node.entry);
    metadataEntries.push([node.relative, ...node.metadata!]);
    if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  progress(true, true);
  const hash = digest(JSON.stringify(entries));
  const structureHash = contents ? digest(JSON.stringify(entries.map(entry => entry.type === 'file'
    ? { path: entry.path, type: entry.type, executable: entry.executable } : entry))) : hash;
  return { hash, metadataHash: digest(JSON.stringify(metadataEntries)), structureHash, entries,
    ...(publicationProof ? { publicationMetadataHash: publicationMetadataHash(metadataEntries) } : {}) };
}

export async function fingerprintWorkspace(workspacePath: string) {
  return (await inspect(await realpath(workspacePath))).hash;
}

function observe(root: string, mode: WorkspaceMode, externalSignal?: AbortSignal, onProgress?: (progress: WorkspaceScanProgress) => void, integrity: WorkspaceIntegrity = 'content') {
  const controller = new AbortController();
  let closed = false;
  let watcher: FSWatcher;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scanning: { contents: boolean; generation: number; promise: Promise<Inspection> } | undefined;
  let requestedGeneration = 0;
  let baseline: Inspection | undefined;
  let initialized = false;
  let eventPending = false;
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
    clearTimeout(timer); timer = undefined;
  };
  const externalAbort = () => abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', externalAbort, { once: true });
  if (externalSignal?.aborted) externalAbort();
  try {
    watcher = watch(root, { recursive: true }, () => {
      eventPending = true;
      if (initialized) void check(false).catch(() => {});
    });
    watcher.on('error', error => abort(failure(`Cannot monitor review workspace: ${errorMessage(error)}`)));
  } catch (error) {
    externalSignal?.removeEventListener('abort', externalAbort);
    throw failure(`Cannot monitor review workspace: ${errorMessage(error)}`);
  }
  const check = async (contents = integrity === 'content', fresh = false) => {
    const requested = fresh ? ++requestedGeneration : 0;
    const assertOpen = () => {
      controller.signal.throwIfAborted();
      if (closed) throw failure('Workspace handle is closed.');
    };
    while (true) {
      assertOpen();
      const active = scanning;
      if (active) {
        const current = await active.promise;
        assertOpen();
        // Explicit boundaries may only share a traversal that started after
        // their request. Background polls may reuse any adequate active scan.
        if ((!contents || active.contents) && (!fresh || active.generation >= requested)) return current;
        continue;
      }
      // Defer progress callbacks until this operation owns the slot, including
      // callers that reenter from a synchronous progress callback.
      const operation: NonNullable<typeof scanning> = { contents, generation: 0, promise: Promise.resolve().then(async () => {
        assertOpen();
        operation.generation = requestedGeneration;
        let current;
        do {
          eventPending = false;
          current = await inspect(root, { signal: controller.signal, requireReadonly: mode === 'copy', contents, ...(contents ? { onProgress } : {}) });
          if (baseline && ((contents && current.hash !== baseline.hash) || current.metadataHash !== baseline.metadataHash ||
              (integrity === 'metadata' && current.structureHash !== baseline.structureHash))) throw changed(mode);
          controller.signal.throwIfAborted();
        } while (eventPending);
        return current;
      }) };
      scanning = operation;
      operation.promise = operation.promise.catch((error: unknown) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        // An entry can disappear or stop being a directory between lstat and readdir.
        // Once a baseline exists, these races are input mutations, not unrelated IO failures.
        if (baseline && (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')) error = changed(mode, errorMessage(error));
        if (mode === 'copy' && errorCode(error) === 'WORKSPACE_CHANGED') error = changed(mode, errorMessage(error));
        abort(error);
        throw error;
      }).finally(() => { if (scanning === operation) scanning = undefined; });
      const current = await operation.promise;
      assertOpen();
      return current;
    }
  };
  const scheduleMetadataPoll = (waitMs = 1000) => {
    if (closed || controller.signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      const started = performance.now();
      // Schedule only after this fallback finishes. Filesystem events still check
      // immediately; slow trees must not accumulate interval callbacks behind IO.
      void check(false).catch(() => {}).finally(() => {
        scheduleMetadataPoll(Math.min(30_000, Math.max(1000, (performance.now() - started) * 10)));
      });
    }, waitMs);
    timer.unref();
  };
  return {
    signal: controller.signal,
    async initialize(expected?: Pick<Inspection, 'hash' | 'metadataHash'> & Partial<Pick<Inspection, 'structureHash'>>, publishedFrom?: Inspection) {
      const before = await inspect(root, { signal: controller.signal, requireReadonly: mode === 'copy', contents: false,
        publicationProof: integrity === 'metadata' && publishedFrom !== undefined, onProgress });
      // A staged full-content inspection may cross our own atomic rename under metadata
      // policy only when directory identity, structure and all other metadata still match.
      // Any unexpected difference falls back to actual bytes, as does content policy.
      const publicationMatches = publishedFrom?.publicationMetadataHash !== undefined &&
        publishedFrom.publicationMetadataHash === before.publicationMetadataHash && publishedFrom.structureHash === before.structureHash;
      const current = integrity === 'metadata' && (expected || publicationMatches) ? { ...before, hash: expected?.hash ?? publishedFrom!.hash }
        : await inspect(root, { signal: controller.signal, requireReadonly: mode === 'copy', onProgress });
      if (before.metadataHash !== current.metadataHash) throw changed(mode, 'input changed while acquiring the workspace');
      baseline = current;
      if (expected && (expected.hash !== baseline.hash || expected.metadataHash !== baseline.metadataHash ||
          (expected.structureHash !== undefined && expected.structureHash !== baseline.structureHash))) {
        abort(changed(mode, 'input changed since the request was prepared'));
        controller.signal.throwIfAborted();
      }
      initialized = true;
      if (eventPending) await check(false);
      controller.signal.throwIfAborted();
      // FSEvents can deliver notifications from before watch registration. Compare ctime/inode
      // metadata rather than treating a delayed notification alone as a new mutation.
      scheduleMetadataPoll();
      return baseline;
    },
    assertUnchanged: () => check(integrity === 'content', true),
    async close() {
      if (!closed) {
        closed = true;
        clearTimeout(timer);
        watcher.close();
        externalSignal?.removeEventListener('abort', externalAbort);
      }
      // Repeated close calls drain the same owned operation. Queued callers see
      // closed after their await and cannot restart scanning without a watcher.
      await scanning?.promise.catch(() => {});
    },
  };
}

async function copyEntries(source: string, destination: string, entries: WorkspaceEntry[], signal?: AbortSignal) {
  // Parents must exist before copying children. Keep staging writable until every
  // in-flight operation has settled, including when another operation fails.
  for (const entry of entries) {
    if (entry.type !== 'directory') continue;
    signal?.throwIfAborted();
    await mkdir(path.join(destination, entry.path), { mode: 0o700 });
  }
  const leaves = entries.filter(entry => entry.type !== 'directory');
  let next = 0, failed = false;
  let failure: unknown;
  const copyNext = async () => {
    while (!failed && next < leaves.length) {
      const entry = leaves[next++];
      try {
        signal?.throwIfAborted();
        const target = path.join(destination, entry.path);
        if (entry.type === 'symlink') await symlink(entry.target, target);
        else {
          await copyFile(path.join(source, entry.path), target, constants.COPYFILE_EXCL);
          await chmod(target, 0o444 | entry.executable);
        }
      } catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
  };
  // Bound filesystem pressure independently of the number of input files.
  await Promise.all(Array.from({ length: Math.min(8, leaves.length) }, copyNext));
  if (failed) throw failure;
  signal?.throwIfAborted();
  for (const entry of [...entries].reverse()) {
    signal?.throwIfAborted();
    if (entry.type === 'directory') await chmod(path.join(destination, entry.path), 0o444 | entry.executable);
  }
  await chmod(destination, 0o555);
}

async function acquirePublication(cacheRoot: string, hash: string, signal?: AbortSignal) {
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
      if (errorCode(error) !== 'EEXIST') throw error;
      const identity = await lstat(lockPath).catch(() => null);
      if (identity?.isSymbolicLink()) throw failure('Cache publication lock must not be a symlink.');
      const owner = await readFile(lockPath, 'utf8').then(value => JSON.parse(value) as { pid?: unknown }).catch(() => null);
      if (typeof owner?.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0) {
        let dead = false;
        try { process.kill(owner.pid, 0); } catch (probeError) { dead = errorCode(probeError) === 'ESRCH'; }
        const current = await lstat(lockPath).catch(() => null);
        if (dead && current?.ino === identity?.ino && current?.dev === identity?.dev) {
          await unlink(lockPath).catch(error => { if (errorCode(error) !== 'ENOENT') throw error; });
          continue;
        }
      }
      if (Date.now() >= deadline) throw failure('Workspace cache publication is busy; retry this request.');
      await delay(20, undefined, { signal });
    }
  }
}

/** Delete only caller-owned private scratch, never a shared cache or a source workspace. */
export async function removeOwnedWorkspaceTree(directory: string) {
  // Only unpublished private staging is made writable; shared cache inputs are never mutated.
  const makeWritable = async (current: string): Promise<void> => {
    const info = await lstat(current);
    if (!info.isDirectory()) return;
    await chmod(current, 0o700);
    for (const name of await readdir(current)) await makeWritable(path.join(current, name));
  };
  try { await makeWritable(directory); await rm(directory, { recursive: true, force: true }); }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
}

export async function prepareWorkspace({ repoPath, stateDir, mode = 'copy', integrity = 'content', signal }: { repoPath?: string; stateDir?: string; mode?: WorkspaceMode; integrity?: WorkspaceIntegrity; signal?: AbortSignal } = {}): Promise<WorkspaceHandle> {
  if (!['copy', 'lock'].includes(mode)) throw failure('Workspace mode must be copy or lock.');
  if (!['content', 'metadata'].includes(integrity)) throw failure('Workspace integrity must be content or metadata.');
  const canonical = await validateStateLocation(repoPath, stateDir);
  const source = canonical.repoPath;
  const observer = observe(source, 'lock', signal, undefined, integrity);
  let stage: string | undefined;
  let releasePublication: (() => Promise<void>) | undefined;
  try {
    const initial = await observer.initialize();
    if (mode === 'lock') {
      const descriptor = Object.freeze({ version: 1 as const, mode, sourcePath: source, path: source, hash: initial.hash, stateDir: canonical.stateDir, baselineMetadataHash: initial.metadataHash,
        ...(integrity === 'metadata' ? { integrity, structureHash: initial.structureHash } : {}) });
      return { descriptor, signal: observer.signal, assertUnchanged: observer.assertUnchanged, close: observer.close };
    }
    const cacheRoot = path.join(canonical.stateDir, 'workspaces');
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    if (await realpath(cacheRoot) !== cacheRoot) throw failure('Workspace cache directory must not be a symlink.');
    const destination = path.join(cacheRoot, initial.hash);
    releasePublication = await acquirePublication(cacheRoot, initial.hash, observer.signal);
    let cached = false;
    let publishedFrom: Inspection | undefined;
    try {
      if (!(await lstat(destination)).isDirectory()) throw changed('copy', 'cache root must be a regular directory');
      cached = true;
    }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    if (!cached) {
      stage = path.join(cacheRoot, `.capture-${randomUUID()}`);
      await mkdir(stage, { mode: 0o700 });
      await copyEntries(source, stage, initial.entries, observer.signal);
      const copied = await inspect(stage, { signal: observer.signal, requireReadonly: true, publicationProof: integrity === 'metadata' });
      if (copied.hash !== initial.hash) throw changed('lock', 'source changed during copy');
      publishedFrom = copied;
      await observer.assertUnchanged();
      await rename(stage, destination);
      stage = undefined;
    } else {
      // Cache reuse still validates the source whose identity selected this copy.
      await observer.assertUnchanged();
    }
    // A new copy was already checked against stable source immediately before
    // publication. No source bytes are consumed after that capture boundary.
    observer.signal.throwIfAborted();
    await observer.close();
    observer.signal.throwIfAborted();
    if (stage) { await removeOwnedWorkspaceTree(stage); stage = undefined; }
    await releasePublication();
    releasePublication = undefined;
    // Cache hits have no staged proof and receive a full byte validation here under
    // either policy. This same live observer owns every subsequent boundary.
    if (await realpath(destination) !== destination || !(await lstat(destination)).isDirectory()) {
      throw failure('Persisted workspace descriptor has an invalid input path.');
    }
    const copyObserver = observe(destination, 'copy', signal, undefined, integrity);
    try {
      const verified = await copyObserver.initialize(undefined, publishedFrom);
      if (verified.hash !== initial.hash) throw changed('copy', 'cached content does not match its hash');
      copyObserver.signal.throwIfAborted();
      const descriptor = Object.freeze({ version: 1 as const, mode, sourcePath: source, path: destination, hash: initial.hash, stateDir: canonical.stateDir, baselineMetadataHash: verified.metadataHash,
        ...(integrity === 'metadata' ? { integrity, structureHash: verified.structureHash } : {}) });
      return { descriptor, signal: copyObserver.signal, assertUnchanged: copyObserver.assertUnchanged, close: copyObserver.close };
    } catch (error) { await copyObserver.close(); throw error; }
  } catch (error) {
    await observer.close();
    if (stage) await removeOwnedWorkspaceTree(stage);
    await releasePublication?.();
    throw error;
  }
}

export async function reopenWorkspace(descriptor: WorkspaceDescriptor, { signal, onProgress, integrity }: { signal?: AbortSignal; onProgress?: (progress: WorkspaceScanProgress) => void; integrity?: WorkspaceIntegrity } = {}): Promise<WorkspaceHandle> {
  if (!descriptor || descriptor.version !== 1 || !['copy', 'lock'].includes(descriptor.mode) ||
      !validHash(descriptor.hash) || !validHash(descriptor.baselineMetadataHash) ||
      (descriptor.integrity !== undefined && !['content', 'metadata'].includes(descriptor.integrity)) ||
      (descriptor.structureHash !== undefined && !validHash(descriptor.structureHash)) ||
      (descriptor.integrity === 'metadata' && !validHash(descriptor.structureHash)) ||
      (['sourcePath', 'path', 'stateDir'] as const).some(key => typeof descriptor[key] !== 'string' || !path.isAbsolute(descriptor[key]))) {
    throw failure('Invalid persisted workspace descriptor.');
  }
  if (integrity !== undefined && !['content', 'metadata'].includes(integrity)) throw failure('Workspace integrity must be content or metadata.');
  if (integrity === 'metadata' && descriptor.integrity !== 'metadata') throw failure('Metadata integrity requires an explicitly captured metadata-policy descriptor.');
  const effectiveIntegrity = integrity ?? descriptor.integrity ?? 'content';
  const { mode, sourcePath, stateDir } = descriptor;
  if (contained(sourcePath, stateDir)) throw failure('Persisted stateDir must be outside the source workspace.');
  const expectedPath = mode === 'lock' ? sourcePath : path.join(stateDir, 'workspaces', descriptor.hash);
  if (descriptor.path !== expectedPath || await realpath(descriptor.path) !== expectedPath || !(await lstat(expectedPath)).isDirectory()) {
    throw failure('Persisted workspace descriptor has an invalid input path.');
  }
  const observer = observe(expectedPath, mode, signal, onProgress, effectiveIntegrity);
  try {
    await observer.initialize({ hash: descriptor.hash, metadataHash: descriptor.baselineMetadataHash, structureHash: descriptor.structureHash });
    return { descriptor: Object.freeze({ ...descriptor, ...(integrity !== undefined ? { integrity } : {}) }), signal: observer.signal, assertUnchanged: observer.assertUnchanged, close: observer.close };
  } catch (error) { await observer.close(); throw error; }
}

// Transfer reuses the snapshot identity and publication boundary used by local copies.
export { inspect as inspectWorkspace, acquirePublication as acquireWorkspacePublication };
