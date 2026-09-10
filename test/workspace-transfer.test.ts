import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { fingerprintWorkspace, prepareWorkspace, removeOwnedWorkspaceTree, reopenWorkspace, type WorkspaceDescriptor } from '../src/workspaces/index.js';
import { createWorkspaceManifest, materializeWorkspace, openWorkspaceBlob, validateWorkspaceManifest, type WorkspaceManifest, type WorkspaceTransferEntry } from '../src/workspaces/transfer.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-transfer-'));
  const repoPath = join(root, 'repo'); const stateDir = join(root, 'source-state'); const reviewerState = join(root, 'reviewer-state');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'asset.txt'), 'Original asset\n');
  t.after(() => removeOwnedWorkspaceTree(root));
  const capture = async () => {
    const handle = await prepareWorkspace({ repoPath, stateDir, mode: 'copy' });
    const descriptor = { ...handle.descriptor };
    await handle.close();
    const manifest = await createWorkspaceManifest(descriptor);
    const fetched: string[] = [];
    const fetchBlob = async (hash: string, signal?: AbortSignal) => {
      fetched.push(hash);
      return (await openWorkspaceBlob(descriptor, manifest, hash, { signal })).stream;
    };
    return { descriptor, manifest, fetched, fetchBlob };
  };
  return { root, repoPath, stateDir, reviewerState, capture };
}

function manifestFor(entries: WorkspaceTransferEntry[]): WorkspaceManifest {
  const identity = entries.map(entry => entry.type === 'file'
    ? { path: entry.path, type: entry.type, executable: entry.executable, content: entry.content } : entry);
  return { version: 1, hash: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), entries };
}

test('full transfer preserves workspace identity, dependencies, executable bits, empty directories and internal links', async t => {
  const data = await fixture(t);
  await mkdir(join(data.repoPath, '.git'));
  await writeFile(join(data.repoPath, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(join(data.repoPath, 'asset'));
  await mkdir(join(data.repoPath, 'asset', 'empty'));
  await writeFile(join(data.repoPath, 'asset', 'image.txt'), '\uD55C\uAE00 image\n');
  await mkdir(join(data.repoPath, 'bin'));
  await writeFile(join(data.repoPath, 'bin', 'viewer'), '#!/bin/sh\nexit 0\n', { mode: 0o751 });
  await symlink('../asset/image.txt', join(data.repoPath, 'bin', 'preview'));
  await symlink('asset', join(data.repoPath, 'shortcut'));
  const source = await data.capture();
  const progress: number[] = [];
  const result = await materializeWorkspace({ ...source, stateDir: data.reviewerState, onProgress: item => progress.push(item.downloadedFiles + item.reusedFiles) });
  assert.equal(result.descriptor.hash, source.descriptor.hash);
  assert.equal(await fingerprintWorkspace(result.descriptor.path), source.manifest.hash);
  assert.equal(await readFile(join(result.descriptor.path, 'bin', 'preview'), 'utf8'), '\uD55C\uAE00 image\n');
  assert.equal(await readlink(join(result.descriptor.path, 'shortcut')), 'asset');
  assert.equal((await lstat(join(result.descriptor.path, 'bin', 'viewer'))).mode & 0o777, 0o555);
  assert.equal((await lstat(join(result.descriptor.path, 'asset', 'empty'))).mode & 0o222, 0);
  assert.equal(result.downloadedFiles, 4);
  assert.equal(result.reusedFiles, 0);
  assert.deepEqual(progress, [1, 2, 3, 4]);
  assert.equal(result.descriptor.sourcePath, result.descriptor.path);
  assert.notEqual(result.descriptor.baselineMetadataHash, source.descriptor.baselineMetadataHash);
  assert.ok(result.descriptor.path.startsWith(data.reviewerState));
  const reopened = await reopenWorkspace(result.descriptor);
  try { await reopened.assertUnchanged(); } finally { await reopened.close(); }
});

test('later revisions download only missing file contents and keep old snapshots independent', async t => {
  const data = await fixture(t);
  await writeFile(join(data.repoPath, 'viewer'), 'Bundled executable', { mode: 0o755 });
  const first = await data.capture();
  const original = await materializeWorkspace({ ...first, stateDir: data.reviewerState });
  const reused = await materializeWorkspace({ ...first, stateDir: data.reviewerState, fetchBlob: async () => { throw new Error('Unexpected download'); } });
  assert.equal(reused.descriptor.path, original.descriptor.path);
  assert.equal(reused.downloadedFiles, 0); assert.equal(reused.reusedFiles, 2);
  await writeFile(join(data.repoPath, 'asset.txt'), 'Changed asset\n');
  const second = await data.capture();
  const changed = await materializeWorkspace({ ...second, stateDir: data.reviewerState });
  assert.equal(second.fetched.length, 1); assert.equal(changed.downloadedFiles, 1); assert.equal(changed.reusedFiles, 1);
  assert.equal(changed.downloadedBytes, Buffer.byteLength('Changed asset\n'));
  assert.equal(await readFile(join(original.descriptor.path, 'asset.txt'), 'utf8'), 'Original asset\n');
  assert.equal(await readFile(join(changed.descriptor.path, 'asset.txt'), 'utf8'), 'Changed asset\n');
  const viewer = first.manifest.entries.find(entry => entry.path === 'viewer');
  assert.ok(viewer?.type === 'file');
  const nodes = await Promise.all([
    lstat(join(original.descriptor.path, 'viewer')),
    lstat(join(changed.descriptor.path, 'viewer')),
    lstat(join(data.reviewerState, 'workspace-blobs', viewer.content)),
  ]);
  assert.equal(new Set(nodes.map(info => info.ino)).size, 3, 'Snapshots and blob caches must not share mutable hard links.');
});

test('POSIX transfer preserves literal colon and backslash names and symlink targets', { skip: process.platform === 'win32' }, async t => {
  const data = await fixture(t);
  await mkdir(join(data.repoPath, 'build:2026'));
  await writeFile(join(data.repoPath, 'build:2026', 'mesh\\preview.txt'), 'Preview content');
  await writeFile(join(data.repoPath, 'C:\\asset.txt'), 'A literal POSIX filename');
  await symlink('build:2026/mesh\\preview.txt', join(data.repoPath, 'preview:link'));
  const source = await data.capture();
  const result = await materializeWorkspace({ ...source, stateDir: data.reviewerState });
  assert.equal(result.descriptor.hash, source.descriptor.hash);
  assert.equal(await fingerprintWorkspace(result.descriptor.path), source.manifest.hash);
  assert.equal(await readFile(join(result.descriptor.path, 'preview:link'), 'utf8'), 'Preview content');
  assert.equal(await readlink(join(result.descriptor.path, 'preview:link')), 'build:2026/mesh\\preview.txt');
  assert.equal(await readFile(join(result.descriptor.path, 'C:\\asset.txt'), 'utf8'), 'A literal POSIX filename');
});

test('Windows transfer rejects drive, UNC, alternate-stream and backslash traversal paths', { skip: process.platform !== 'win32' }, () => {
  for (const name of ['C:\\escape', 'C:/escape', '\\\\server\\share', 'file:stream', '..\\escape']) {
    const entry: WorkspaceTransferEntry = { path: name, type: 'file', executable: 0, size: 0, content: createHash('sha256').digest('hex') };
    assert.throws(() => validateWorkspaceManifest(manifestFor([entry])), { code: 'WORKSPACE_TRANSFER_INVALID' });
    assert.throws(() => validateWorkspaceManifest(manifestFor([{ path: 'link', type: 'symlink', target: name }])), { code: 'WORKSPACE_TRANSFER_INVALID' });
  }
});

test('duplicate contents within a snapshot and executable-only edits reuse the same verified blob', async t => {
  const data = await fixture(t);
  await writeFile(join(data.repoPath, 'copy.txt'), 'Original asset\n');
  const first = await data.capture();
  const initial = await materializeWorkspace({ ...first, stateDir: data.reviewerState });
  assert.equal(initial.downloadedFiles, 1); assert.equal(initial.reusedFiles, 1);
  await chmod(join(data.repoPath, 'copy.txt'), 0o755);
  const next = await data.capture();
  const changed = await materializeWorkspace({ ...next, stateDir: data.reviewerState });
  assert.notEqual(changed.descriptor.hash, initial.descriptor.hash);
  assert.equal(changed.downloadedFiles, 0); assert.equal(changed.reusedFiles, 2);
  assert.equal((await lstat(join(changed.descriptor.path, 'copy.txt'))).mode & 0o111, 0o111);
});

test('corrupt blob caches are redownloaded without repairing or modifying historical snapshots', async t => {
  const data = await fixture(t);
  const first = await data.capture();
  const original = await materializeWorkspace({ ...first, stateDir: data.reviewerState });
  const entry = first.manifest.entries[0]; assert.equal(entry.type, 'file');
  const blob = join(data.reviewerState, 'workspace-blobs', entry.content);
  await chmod(blob, 0o644); await writeFile(blob, 'Corrupted cache'); await chmod(blob, 0o444);
  await mkdir(join(data.repoPath, 'new-empty'));
  const next = await data.capture();
  const changed = await materializeWorkspace({ ...next, stateDir: data.reviewerState });
  assert.equal(changed.downloadedFiles, 1);
  assert.equal(await readFile(join(original.descriptor.path, 'asset.txt'), 'utf8'), 'Original asset\n');
  assert.equal(await readFile(blob, 'utf8'), 'Original asset\n');
  const file = join(changed.descriptor.path, 'asset.txt');
  await chmod(file, 0o644); await writeFile(file, 'Snapshot corruption'); await chmod(file, 0o444);
  await assert.rejects(materializeWorkspace({ ...next, stateDir: data.reviewerState }), /does not match/);
});

test('incorrect downloaded bytes and oversized streams never publish a workspace or usable blob', async t => {
  const data = await fixture(t);
  const source = await data.capture();
  for (const content of ['Wrong bytes!!!\n', 'A payload that exceeds the recorded byte length']) {
    await assert.rejects(materializeWorkspace({
      ...source, stateDir: data.reviewerState, fetchBlob: async () => (async function* () { yield Buffer.from(content); })(),
    }), /verification|declared size/);
    assert.deepEqual(await readdir(join(data.reviewerState, 'workspaces')), []);
    assert.deepEqual(await readdir(join(data.reviewerState, 'workspace-blobs')), []);
  }
});

test('simultaneous imports publish one immutable snapshot and download each blob once', async t => {
  const data = await fixture(t);
  const source = await data.capture();
  const imports = await Promise.all(Array.from({ length: 3 }, () => materializeWorkspace({ ...source, stateDir: data.reviewerState })));
  assert.equal(new Set(imports.map(result => result.descriptor.path)).size, 1);
  assert.equal(new Set(imports.map(result => result.descriptor.baselineMetadataHash)).size, 1);
  assert.equal(source.fetched.length, 1);
  assert.deepEqual(await readdir(join(data.reviewerState, 'workspaces')), [source.manifest.hash]);
});

test('empty snapshots transfer without fetching bytes and retain directory identity', async t => {
  const data = await fixture(t);
  const manifest = manifestFor([]);
  const result = await materializeWorkspace({ manifest, stateDir: data.reviewerState, fetchBlob: async () => { throw new Error('Unexpected fetch'); } });
  assert.equal(result.downloadedFiles, 0); assert.equal(result.reusedFiles, 0);
  assert.equal(await fingerprintWorkspace(result.descriptor.path), manifest.hash);
});

test('malformed manifests reject traversal, conflicting paths, special files and invalid metadata before downloading', async t => {
  const data = await fixture(t);
  const source = await data.capture();
  const file = source.manifest.entries[0]; assert.equal(file.type, 'file');
  const invalid: unknown[] = [
    { ...source.manifest, hash: 'invalid' },
    { ...source.manifest, extra: true },
    { ...source.manifest, entries: [{ ...file, path: '../escape' }] },
    { ...source.manifest, entries: [{ ...file, path: '/absolute' }] },
    { ...source.manifest, entries: [{ ...file, path: 'C:\\escape' }] },
    { ...source.manifest, entries: [{ ...file, path: 'missing/child' }] },
    { ...source.manifest, entries: [file, file] },
    { ...source.manifest, entries: [file, { ...file, path: 'asset.txt/child' }] },
    { ...source.manifest, entries: [{ ...file, type: 'fifo' }] },
    { ...source.manifest, entries: [{ ...file, executable: 0o777 }] },
    { ...source.manifest, entries: [{ ...file, size: -1 }] },
    { ...source.manifest, entries: [{ ...file, size: 0.5 }] },
    { ...source.manifest, entries: [{ ...file, hidden: true }] },
    { ...source.manifest, entries: [{ ...file, path: 'last' }, file] },
    { ...source.manifest, entries: [file, { ...file, path: 'other', size: file.size + 1 }] },
  ];
  for (const manifest of invalid) await assert.rejects(materializeWorkspace({
    manifest: manifest as WorkspaceManifest, stateDir: data.reviewerState,
    fetchBlob: async () => { assert.fail('Invalid metadata must not request blobs.'); },
  }), { code: 'WORKSPACE_TRANSFER_INVALID' });
  await assert.rejects(lstat(data.reviewerState), { code: 'ENOENT' });
});

test('symlink manifests reject escapes, dangling links, cycles and traversal through files', () => {
  const directory: WorkspaceTransferEntry = { path: 'a', type: 'directory', executable: 0o111 };
  const file: WorkspaceTransferEntry = { path: 'file', type: 'file', executable: 0, size: 0, content: createHash('sha256').digest('hex') };
  const cases: WorkspaceTransferEntry[][] = [
    [{ path: 'link', type: 'symlink', target: '../escape' }],
    [{ path: 'link', type: 'symlink', target: '/outside' }],
    [{ path: 'link', type: 'symlink', target: 'missing' }],
    [{ path: 'link', type: 'symlink', target: 'link' }],
    [directory, { path: 'a/root', type: 'symlink', target: '..' }, { path: 'link', type: 'symlink', target: 'a/root/../outside' }],
    [file, { path: 'link', type: 'symlink', target: 'file/child' }],
    [{ path: 'a', type: 'symlink', target: 'b' }, { path: 'b', type: 'symlink', target: 'a' }],
  ];
  for (const entries of cases) assert.throws(() => validateWorkspaceManifest(manifestFor(entries)), { code: 'WORKSPACE_TRANSFER_INVALID' });
});

test('state directory symlinks and blob symlinks never expose external files', async t => {
  const data = await fixture(t);
  const source = await data.capture();
  await symlink(data.repoPath, data.reviewerState);
  await assert.rejects(materializeWorkspace({ ...source, stateDir: data.reviewerState }), /symlinks/);
  assert.deepEqual(await readdir(data.repoPath), ['asset.txt']);
  const safeState = join(data.root, 'safe-state');
  await mkdir(join(safeState, 'workspace-blobs'), { recursive: true });
  const file = source.manifest.entries[0]; assert.equal(file.type, 'file');
  await symlink(join(data.repoPath, 'asset.txt'), join(safeState, 'workspace-blobs', file.content));
  await assert.rejects(materializeWorkspace({ ...source, stateDir: safeState }), /ELOOP|symlink/);
  assert.equal(await readFile(join(data.repoPath, 'asset.txt'), 'utf8'), 'Original asset\n');
  assert.equal(source.fetched.length, 0);
});

test('blob serving rejects unknown hashes, descriptor relocation, and replaced directory ancestors', async t => {
  const data = await fixture(t);
  await mkdir(join(data.repoPath, 'nested'));
  await writeFile(join(data.repoPath, 'nested', 'file'), 'Nested content');
  const source = await data.capture();
  const file = source.manifest.entries.find(entry => entry.path === 'nested/file'); assert.ok(file?.type === 'file');
  await assert.rejects(openWorkspaceBlob(source.descriptor, source.manifest, '../escape'), /belong/);
  await assert.rejects(openWorkspaceBlob(source.descriptor, source.manifest, '0'.repeat(64)), /not present/);
  await assert.rejects(openWorkspaceBlob({ ...source.descriptor, path: data.repoPath }, source.manifest, file.content), /root is invalid/);
  await chmod(source.descriptor.path, 0o755);
  await removeOwnedWorkspaceTree(join(source.descriptor.path, 'nested'));
  await symlink(join(data.repoPath, 'nested'), join(source.descriptor.path, 'nested'));
  await chmod(source.descriptor.path, 0o555);
  await assert.rejects(openWorkspaceBlob(source.descriptor, source.manifest, file.content), /directory ancestor/);
});

test('lock workspaces cannot be offered as immutable download manifests', async t => {
  const data = await fixture(t);
  const handle = await prepareWorkspace({ ...data, mode: 'lock' });
  try { await assert.rejects(createWorkspaceManifest(handle.descriptor as WorkspaceDescriptor), /immutable copy/); }
  finally { await handle.close(); }
});

test('streamed cancellation removes partial files and retains completed cache blobs for retry', async t => {
  const data = await fixture(t);
  await writeFile(join(data.repoPath, 'large.bin'), Buffer.alloc(2 * 1024 * 1024, 3));
  const source = await data.capture();
  const controller = new AbortController();
  let closed = false;
  await assert.rejects(materializeWorkspace({
    ...source, stateDir: data.reviewerState, signal: controller.signal,
    fetchBlob: async (hash, signal) => {
      const entry = source.manifest.entries.find(item => item.type === 'file' && item.content === hash);
      if (entry?.path !== 'large.bin') return source.fetchBlob(hash, signal);
      return (async function* () {
        try {
          yield Buffer.alloc(16 * 1024, 3);
          controller.abort(new Error('Reviewer cancelled preparation'));
          yield Buffer.alloc(16 * 1024, 3);
        } finally { closed = true; }
      })();
    },
  }), /abort|cancelled/i);
  assert.equal(closed, true);
  assert.deepEqual(await readdir(join(data.reviewerState, 'workspaces')), []);
  assert.equal((await readdir(join(data.reviewerState, 'workspace-blobs'))).length, 1);
  const retry = await materializeWorkspace({ ...source, stateDir: data.reviewerState });
  assert.equal(retry.downloadedFiles, 1); assert.equal(retry.reusedFiles, 1);
  assert.equal(retry.descriptor.hash, source.manifest.hash);
});

test('pre-cancelled transfers create no state or downloads', async t => {
  const data = await fixture(t);
  const source = await data.capture();
  const controller = new AbortController(); controller.abort(new Error('Preparation cancelled'));
  await assert.rejects(materializeWorkspace({ ...source, stateDir: data.reviewerState, signal: controller.signal }), /cancelled/);
  await assert.rejects(lstat(data.reviewerState), { code: 'ENOENT' });
  assert.equal(source.fetched.length, 0);
});

test('cancelling an idle Web or Node download promptly releases streams, locks and staging', async t => {
  const data = await fixture(t);
  const source = await data.capture();
  for (const kind of ['web', 'node'] as const) {
    const controller = new AbortController();
    let cancelled = false;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const preparation = materializeWorkspace({
      ...source, stateDir: data.reviewerState, signal: controller.signal,
      fetchBlob: async () => {
        markStarted();
        return kind === 'web'
          ? new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })
          : new Readable({ read() {}, destroy(error, callback) { cancelled = true; callback(error); } });
      },
    });
    await started;
    const abort = setTimeout(() => controller.abort(new Error('Reviewer cancelled an idle download')), 25);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(Promise.race([
        preparation,
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Idle download did not stop promptly')), 1000); }),
      ]), /abort|cancelled/i);
    } finally { clearTimeout(abort); clearTimeout(timeout); }
    assert.equal(cancelled, true);
    assert.deepEqual(await readdir(join(data.reviewerState, 'workspaces')), []);
    assert.deepEqual(await readdir(join(data.reviewerState, 'workspace-blobs')), []);
  }
  const retry = await materializeWorkspace({ ...source, stateDir: data.reviewerState });
  assert.equal(retry.descriptor.hash, source.manifest.hash);
});
