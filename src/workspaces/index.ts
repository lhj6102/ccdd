import { createHash } from 'node:crypto';
import { constants, watch, type BigIntStats, type FSWatcher } from 'node:fs';
import { chmod, lstat, open, readdir, readlink, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export type WorkspaceIntegrity = 'content' | 'metadata';
export interface WorkspaceDescriptor {
  version: 2; sourcePath: string; path: string;
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
interface Inspection { hash: string; metadataHash: string; structureHash: string; entries: WorkspaceEntry[] }
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
const changed = (detail = '') => failure(`Review workspace changed${detail ? `: ${detail}` : '.'}`, 'WORKSPACE_CHANGED');

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

/** Every entry participates: no Git, ignore rules, extension filters or implicit exclusions. */
async function inspect(root: string, { signal, contents = true, onProgress }: { signal?: AbortSignal; contents?: boolean; onProgress?: (progress: WorkspaceScanProgress) => void } = {}): Promise<Inspection> {
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
      if (JSON.stringify(node.metadata) !== JSON.stringify(metadata(after))) throw changed(node.relative || '.');
      complete(node);
    };
    const walk = async (node: ScanNode): Promise<void> => {
      check();
      const relative = node.relative;
      const absolute = relative ? path.join(root, relative) : root;
      const before = await lstat(absolute, { bigint: true });
      node.metadata = metadata(before);
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
          if (JSON.stringify(metadata(before)) !== JSON.stringify(metadata(opened))) throw changed(relative);
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
      if (JSON.stringify(metadata(before)) !== JSON.stringify(metadata(after))) throw changed(relative || '.');
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
  return { hash, metadataHash: digest(JSON.stringify(metadataEntries)), structureHash, entries };
}

export async function fingerprintWorkspace(workspacePath: string) {
  return (await inspect(await realpath(workspacePath))).hash;
}

function observe(root: string, externalSignal?: AbortSignal, onProgress?: (progress: WorkspaceScanProgress) => void, integrity: WorkspaceIntegrity = 'content') {
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
          current = await inspect(root, { signal: controller.signal, contents, ...(contents ? { onProgress } : {}) });
          if (baseline && ((contents && current.hash !== baseline.hash) || current.metadataHash !== baseline.metadataHash ||
              (integrity === 'metadata' && current.structureHash !== baseline.structureHash))) throw changed();
          controller.signal.throwIfAborted();
        } while (eventPending);
        return current;
      }) };
      scanning = operation;
      operation.promise = operation.promise.catch((error: unknown) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        // An entry can disappear or stop being a directory between lstat and readdir.
        // Once a baseline exists, these races are input mutations, not unrelated IO failures.
        if (baseline && (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')) error = changed(errorMessage(error));
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
    async initialize(expected?: Pick<Inspection, 'hash' | 'metadataHash'> & Partial<Pick<Inspection, 'structureHash'>>) {
      const before = await inspect(root, { signal: controller.signal, contents: false, onProgress });
      const current = integrity === 'metadata' && expected ? { ...before, hash: expected.hash }
        : await inspect(root, { signal: controller.signal, onProgress });
      if (before.metadataHash !== current.metadataHash) throw changed('input changed while acquiring the workspace');
      baseline = current;
      if (expected && (expected.hash !== baseline.hash || expected.metadataHash !== baseline.metadataHash ||
          (expected.structureHash !== undefined && expected.structureHash !== baseline.structureHash))) {
        abort(changed('input changed since the request was prepared'));
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

/** Delete only caller-owned private scratch, never a source workspace. */
export async function removeOwnedWorkspaceTree(directory: string) {
  // The caller must own this scratch directory; reviewed inputs are never modified.
  const makeWritable = async (current: string): Promise<void> => {
    const info = await lstat(current);
    if (!info.isDirectory()) return;
    await chmod(current, 0o700);
    for (const name of await readdir(current)) await makeWritable(path.join(current, name));
  };
  try { await makeWritable(directory); await rm(directory, { recursive: true, force: true }); }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
}

export async function prepareWorkspace({ repoPath, stateDir, integrity = 'content', signal, ...removed }: { repoPath?: string; stateDir?: string; integrity?: WorkspaceIntegrity; signal?: AbortSignal } = {}): Promise<WorkspaceHandle> {
  if ('mode' in removed) throw failure('Workspace modes are no longer supported; supply an unchanged workspace.');
  if (!['content', 'metadata'].includes(integrity)) throw failure('Workspace integrity must be content or metadata.');
  const canonical = await validateStateLocation(repoPath, stateDir);
  const source = canonical.repoPath;
  const observer = observe(source, signal, undefined, integrity);
  try {
    const initial = await observer.initialize();
    const descriptor = Object.freeze({ version: 2 as const, sourcePath: source, path: source, hash: initial.hash,
      stateDir: canonical.stateDir, baselineMetadataHash: initial.metadataHash,
      ...(integrity === 'metadata' ? { integrity, structureHash: initial.structureHash } : {}) });
    return { descriptor, signal: observer.signal, assertUnchanged: observer.assertUnchanged, close: observer.close };
  } catch (error) { await observer.close(); throw error; }
}

export async function reopenWorkspace(descriptor: WorkspaceDescriptor, { signal, onProgress, integrity }: { signal?: AbortSignal; onProgress?: (progress: WorkspaceScanProgress) => void; integrity?: WorkspaceIntegrity } = {}): Promise<WorkspaceHandle> {
  if (!descriptor || descriptor.version !== 2 || 'mode' in descriptor ||
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
  const { sourcePath, stateDir } = descriptor;
  if (contained(sourcePath, stateDir)) throw failure('Persisted stateDir must be outside the source workspace.');
  const expectedPath = sourcePath;
  if (descriptor.path !== expectedPath || await realpath(descriptor.path) !== expectedPath || !(await lstat(expectedPath)).isDirectory()) {
    throw failure('Persisted workspace descriptor has an invalid input path.');
  }
  const observer = observe(expectedPath, signal, onProgress, effectiveIntegrity);
  try {
    await observer.initialize({ hash: descriptor.hash, metadataHash: descriptor.baselineMetadataHash, structureHash: descriptor.structureHash });
    return { descriptor: Object.freeze({ ...descriptor, ...(integrity !== undefined ? { integrity } : {}) }), signal: observer.signal, assertUnchanged: observer.assertUnchanged, close: observer.close };
  } catch (error) { await observer.close(); throw error; }
}

export { inspect as inspectWorkspace };
