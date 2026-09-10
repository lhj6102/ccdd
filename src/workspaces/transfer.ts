import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  acquireWorkspacePublication, inspectWorkspace, removeOwnedWorkspaceTree, reopenWorkspace,
  type WorkspaceDescriptor,
} from './index.js';

export type WorkspaceTransferEntry =
  | { path: string; type: 'directory'; executable: number }
  | { path: string; type: 'file'; executable: number; content: string; size: number }
  | { path: string; type: 'symlink'; target: string };
export interface WorkspaceManifest { version: 1; hash: string; entries: WorkspaceTransferEntry[] }
export interface WorkspaceTransferProgress {
  downloadedFiles: number; downloadedBytes: number; reusedFiles: number; totalFiles: number;
}
type FileEntry = Extract<WorkspaceTransferEntry, { type: 'file' }>;
const validatedManifests = new WeakMap<object, Map<string, FileEntry>>();
const HASH = /^[a-f0-9]{64}$/;
const failure = (message: string) => Object.assign(new Error(message), { code: 'WORKSPACE_TRANSFER_INVALID' });
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',');
const executable = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && (Number(value) & ~0o111) === 0 && Number(value) <= 0o111;
// POSIX permits literal colons and backslashes. Windows interprets them as streams,
// drives or separators, so those names cannot be safely materialized on Windows.
const supportedPathText = (value: string) => !value.includes('\0') &&
  (process.platform !== 'win32' || (!value.includes('\\') && !value.includes(':')));
const safePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  supportedPathText(value) &&
  value.split('/').every(component => component !== '' && component !== '.' && component !== '..');

// Snapshot traversal sorts names within each directory, then visits children before siblings.
function compareEntries(left: WorkspaceTransferEntry, right: WorkspaceTransferEntry) {
  const a = left.path.split('/'); const b = right.path.split('/');
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/** Validate untrusted transfer metadata before creating directories or requesting any bytes. */
export function validateWorkspaceManifest(value: unknown): WorkspaceManifest {
  if (record(value) && validatedManifests.has(value)) return value as unknown as WorkspaceManifest;
  if (!record(value) || !exactKeys(value, ['version', 'hash', 'entries']) || value.version !== 1 ||
      typeof value.hash !== 'string' || !HASH.test(value.hash) || !Array.isArray(value.entries)) {
    throw failure('Invalid workspace transfer manifest.');
  }
  const entries: WorkspaceTransferEntry[] = [];
  const byPath = new Map<string, WorkspaceTransferEntry>();
  const sizes = new Map<string, number>();
  const blobs = new Map<string, FileEntry>();
  for (const item of value.entries) {
    if (!record(item) || !safePath(item.path) || byPath.has(item.path)) throw failure('Invalid or duplicate workspace entry path.');
    let entry: WorkspaceTransferEntry;
    if (item.type === 'directory' && exactKeys(item, ['path', 'type', 'executable']) && executable(item.executable)) {
      entry = { path: item.path, type: 'directory', executable: item.executable };
    } else if (item.type === 'file' && exactKeys(item, ['path', 'type', 'executable', 'content', 'size']) && executable(item.executable) &&
        typeof item.content === 'string' && HASH.test(item.content) && typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0) {
      if (sizes.has(item.content) && sizes.get(item.content) !== item.size) throw failure('Conflicting sizes for one workspace blob.');
      sizes.set(item.content, item.size);
      entry = { path: item.path, type: 'file', executable: item.executable, content: item.content, size: item.size };
      if (!blobs.has(entry.content)) blobs.set(entry.content, entry);
    } else if (item.type === 'symlink' && exactKeys(item, ['path', 'type', 'target']) && typeof item.target === 'string' &&
        item.target.length > 0 && supportedPathText(item.target) && !path.isAbsolute(item.target)) {
      entry = { path: item.path, type: 'symlink', target: item.target };
    } else throw failure(`Invalid workspace entry: ${item.path}`);
    const parent = path.posix.dirname(entry.path);
    if (parent !== '.' && byPath.get(parent)?.type !== 'directory') throw failure(`Workspace entry has no preceding directory parent: ${entry.path}`);
    if (entries.length && compareEntries(entries[entries.length - 1], entry) >= 0) throw failure('Workspace entries must use canonical snapshot order.');
    entries.push(Object.freeze(entry)); byPath.set(entry.path, entry);
  }
  // Resolve link components in filesystem order: a link followed by '..' must not bypass checks.
  for (const entry of entries) {
    if (entry.type !== 'symlink') continue;
    const remaining = entry.path.split('/'); const resolved: string[] = [];
    let links = 0;
    while (remaining.length) {
      const component = remaining.shift()!;
      if (component === '' || component === '.') continue;
      if (component === '..') {
        if (!resolved.length) throw failure(`Workspace symlink escapes the snapshot: ${entry.path}`);
        resolved.pop(); continue;
      }
      const target = byPath.get([...resolved, component].join('/'));
      if (!target) throw failure(`Workspace symlink is dangling: ${entry.path}`);
      if (target.type === 'symlink') {
        if (++links > 40) throw failure(`Workspace symlink cycle or excessive depth: ${entry.path}`);
        remaining.unshift(...target.target.split('/'));
      } else {
        if (remaining.length && target.type !== 'directory') throw failure(`Workspace symlink traverses a file: ${entry.path}`);
        resolved.push(component);
      }
    }
  }
  const identity = entries.map(entry => entry.type === 'file'
    ? { path: entry.path, type: entry.type, executable: entry.executable, content: entry.content } : entry);
  if (digest(JSON.stringify(identity)) !== value.hash) throw failure('Workspace manifest does not match its snapshot hash.');
  Object.freeze(entries);
  const manifest: WorkspaceManifest = Object.freeze({ version: 1, hash: value.hash, entries });
  validatedManifests.set(manifest, blobs);
  return manifest;
}

export async function createWorkspaceManifest(descriptor: WorkspaceDescriptor, { signal }: { signal?: AbortSignal } = {}): Promise<WorkspaceManifest> {
  if (descriptor.mode !== 'copy') throw failure('Only immutable copy workspaces can be transferred.');
  const handle = await reopenWorkspace(descriptor, { signal });
  try {
    const inspected = await inspectWorkspace(descriptor.path, { signal: handle.signal, requireReadonly: true });
    const entries: WorkspaceTransferEntry[] = [];
    for (const entry of inspected.entries) {
      handle.signal.throwIfAborted();
      if (entry.type === 'file') {
        const info = await lstat(path.join(descriptor.path, entry.path));
        if (!info.isFile() || !entry.content) throw failure('Workspace file changed while preparing its manifest.');
        entries.push({ ...entry, content: entry.content, size: info.size });
      } else entries.push({ ...entry });
    }
    await handle.assertUnchanged();
    return validateWorkspaceManifest({ version: 1, hash: descriptor.hash, entries });
  } finally { await handle.close(); }
}

/** Open only a blob named by this immutable workspace's validated manifest. */
export async function openWorkspaceBlob(descriptor: WorkspaceDescriptor, value: WorkspaceManifest, hash: string, { signal }: { signal?: AbortSignal } = {}): Promise<{ stream: Readable; size: number }> {
  const manifest = validateWorkspaceManifest(value);
  if (descriptor.mode !== 'copy' || descriptor.hash !== manifest.hash || !HASH.test(hash)) throw failure('Blob does not belong to the requested copy workspace.');
  const entry = validatedManifests.get(manifest)!.get(hash);
  if (!entry) throw failure('Blob is not present in this workspace.');
  const expectedRoot = path.join(descriptor.stateDir, 'workspaces', manifest.hash);
  if (!path.isAbsolute(descriptor.stateDir) || descriptor.path !== expectedRoot || await realpath(expectedRoot) !== expectedRoot || !(await lstat(expectedRoot)).isDirectory()) {
    throw failure('Workspace blob root is invalid.');
  }
  const parts = entry.path.split('/');
  for (let index = 1; index < parts.length; index++) {
    const parent = await lstat(path.join(expectedRoot, ...parts.slice(0, index)));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw failure('Workspace blob has an invalid directory ancestor.');
  }
  signal?.throwIfAborted();
  const file = await open(path.join(expectedRoot, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== entry.size || (info.mode & 0o222) !== 0) throw failure('Workspace blob changed or is not a readonly file.');
    signal?.throwIfAborted();
    return { stream: file.createReadStream({ signal }), size: entry.size };
  } catch (error) { await file.close(); throw error; }
}

async function ensureDirectory(directory: string) {
  const absolute = path.resolve(directory);
  const parent = path.dirname(absolute);
  if (parent !== absolute) await ensureDirectory(parent);
  try { await mkdir(absolute, { mode: 0o700 }); }
  catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw failure('Workspace transfer state paths must not contain symlinks.');
}

async function validBlob(filename: string, hash: string, size: number, signal?: AbortSignal): Promise<boolean> {
  let file;
  try { file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw failure('Workspace blob cache entry must be a regular file.');
    if (before.size !== BigInt(size) || (before.mode & 0o222n) !== 0n) return false;
    const hashState = createHash('sha256'); const buffer = Buffer.allocUnsafe(128 * 1024);
    let position = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hashState.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    return position === size && before.ino === after.ino && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs && hashState.digest('hex') === hash;
  } finally { await file.close(); }
}

async function writeVerifiedBlob(source: Readable, filename: string, hash: string, size: number, signal?: AbortSignal) {
  let file;
  try { file = await open(filename, 'wx', 0o600); }
  catch (error) { source.destroy(); throw error; }
  const hashState = createHash('sha256'); let bytes = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > size) { callback(failure('Downloaded workspace blob exceeds its declared size.')); return; }
      hashState.update(chunk); callback(null, chunk);
    },
    flush(callback) {
      callback(bytes !== size || hashState.digest('hex') !== hash ? failure('Downloaded workspace blob failed content verification.') : null);
    },
  });
  try {
    await pipeline(source, check, file.createWriteStream(), { signal });
  } finally { await file.close(); }
}

export async function materializeWorkspace({ manifest: value, stateDir, fetchBlob, signal, onProgress }: {
  manifest: WorkspaceManifest;
  stateDir: string;
  fetchBlob: (hash: string, signal?: AbortSignal) => Promise<ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>>;
  signal?: AbortSignal;
  onProgress?: (progress: Readonly<WorkspaceTransferProgress>) => void;
}): Promise<{ descriptor: WorkspaceDescriptor; downloadedFiles: number; downloadedBytes: number; reusedFiles: number }> {
  const manifest = validateWorkspaceManifest(value);
  if (typeof stateDir !== 'string' || !stateDir || !path.isAbsolute(stateDir)) throw failure('An absolute external transfer state directory is required.');
  signal?.throwIfAborted();
  stateDir = path.resolve(stateDir);
  const cacheRoot = path.join(stateDir, 'workspaces');
  const blobRoot = path.join(stateDir, 'workspace-blobs');
  await ensureDirectory(cacheRoot); await ensureDirectory(blobRoot);
  const destination = path.join(cacheRoot, manifest.hash);
  const progress: WorkspaceTransferProgress = { downloadedFiles: 0, downloadedBytes: 0, reusedFiles: 0, totalFiles: manifest.entries.filter(entry => entry.type === 'file').length };
  const notify = () => onProgress?.(Object.freeze({ ...progress }));
  const release = await acquireWorkspacePublication(cacheRoot, manifest.hash, signal);
  let stage: string | undefined;
  try {
    let existing = false;
    try {
      const info = await lstat(destination);
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure('Imported workspace cache root must be a regular directory.');
      const inspected = await inspectWorkspace(destination, { signal, requireReadonly: true });
      if (inspected.hash !== manifest.hash) throw failure('Imported workspace cache content does not match its hash.');
      existing = true;
    } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    if (existing) { progress.reusedFiles = progress.totalFiles; notify(); }
    else {
      stage = path.join(cacheRoot, `.transfer-${randomUUID()}`);
      await mkdir(stage, { mode: 0o700 });
      for (const entry of manifest.entries) {
        signal?.throwIfAborted();
        const target = path.join(stage, entry.path);
        if (entry.type === 'directory') { await mkdir(target, { mode: 0o700 }); continue; }
        if (entry.type === 'symlink') { await symlink(entry.target, target); continue; }
        const blob = path.join(blobRoot, entry.content);
        const releaseBlob = await acquireWorkspacePublication(blobRoot, entry.content, signal);
        let scratch: string | undefined;
        try {
          if (await validBlob(blob, entry.content, entry.size, signal)) progress.reusedFiles++;
          else {
            // A corrupt byte cache is replaceable; published review snapshots are never repaired in place.
            await unlink(blob).catch(error => { if (errorCode(error) !== 'ENOENT') throw error; });
            const fetched = await fetchBlob(entry.content, signal);
            // Web and Node streams have async iterators too. Keep their native cancellation
            // adapters so an idle read is destroyed immediately when preparation is aborted.
            const source = fetched instanceof Readable ? fetched
              : typeof (fetched as ReadableStream<Uint8Array>).getReader === 'function'
                ? Readable.fromWeb(fetched as import('node:stream/web').ReadableStream<Uint8Array>)
                : Readable.from(fetched as AsyncIterable<Uint8Array>);
            scratch = path.join(blobRoot, `.download-${randomUUID()}`);
            await writeVerifiedBlob(source, scratch, entry.content, entry.size, signal);
            await chmod(scratch, 0o444);
            signal?.throwIfAborted();
            await rename(scratch, blob); scratch = undefined;
            progress.downloadedFiles++; progress.downloadedBytes += entry.size;
          }
          const source = await open(blob, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try { await writeVerifiedBlob(source.createReadStream(), target, entry.content, entry.size, signal); }
          finally { await source.close(); }
          await chmod(target, 0o444 | entry.executable);
          notify();
        } finally {
          if (scratch) await unlink(scratch).catch(() => {});
          await releaseBlob();
        }
      }
      for (const entry of [...manifest.entries].reverse()) {
        if (entry.type === 'directory') await chmod(path.join(stage, entry.path), 0o444 | entry.executable);
      }
      await chmod(stage, 0o555);
      const inspected = await inspectWorkspace(stage, { signal, requireReadonly: true });
      if (inspected.hash !== manifest.hash) throw failure('Reconstructed workspace does not match its snapshot hash.');
      signal?.throwIfAborted();
      await rename(stage, destination); stage = undefined;
    }
    const inspected = await inspectWorkspace(destination, { signal, requireReadonly: true });
    if (inspected.hash !== manifest.hash) throw failure('Imported workspace changed before it could be used.');
    const descriptor: WorkspaceDescriptor = {
      version: 1, mode: 'copy', sourcePath: destination, path: destination,
      hash: manifest.hash, stateDir, baselineMetadataHash: inspected.metadataHash,
    };
    return { descriptor: Object.freeze(descriptor), downloadedFiles: progress.downloadedFiles, downloadedBytes: progress.downloadedBytes, reusedFiles: progress.reusedFiles };
  } finally {
    if (stage) await removeOwnedWorkspaceTree(stage);
    await release();
  }
}
