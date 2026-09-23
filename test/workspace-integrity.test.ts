import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fingerprintWorkspace, inspectWorkspace, prepareWorkspace, reopenWorkspace, removeOwnedWorkspaceTree, type WorkspaceDescriptor } from '../src/workspaces/index.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'ccdd-integrity-'));
  const repoPath = join(root, 'input'), stateDir = join(root, 'state');
  await fs.mkdir(repoPath);
  await fs.writeFile(join(repoPath, 'file'), 'AAAA');
  t.after(() => removeOwnedWorkspaceTree(root));
  return { root, repoPath, stateDir };
}

function trackFileOpens(t: TestContext) {
  const original = fs.open;
  let opens = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => { opens++; return original(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => opens;
}

test('metadata policy first hashes complete input, then reopens and checks every entry without reopening file bytes', async t => {
  const data = await fixture(t);
  await fs.mkdir(join(data.repoPath, 'node_modules'));
  await fs.writeFile(join(data.repoPath, '.gitignore'), 'node_modules/');
  await fs.writeFile(join(data.repoPath, 'node_modules', 'ignored'), 'included');
  const opens = trackFileOpens(t);
  const prepared = await prepareWorkspace({ ...data, integrity: 'metadata' });
  const descriptor = prepared.descriptor;
  assert.equal(descriptor.integrity, 'metadata');
  assert.match(descriptor.structureHash!, /^[a-f0-9]{64}$/);
  assert.ok(opens() >= 3, 'the first capture reads all three files, including ignored dependencies');
  assert.equal(descriptor.hash, await fingerprintWorkspace(data.repoPath));
  const afterCapture = opens();
  await prepared.assertUnchanged();
  await prepared.close();
  const reopened = await reopenWorkspace(descriptor);
  await reopened.assertUnchanged();
  await reopened.close();
  assert.equal(opens(), afterCapture, 'metadata mode retains full traversal without opening file contents');
  const strict = await reopenWorkspace(descriptor, { integrity: 'content' });
  try {
    assert.equal(strict.descriptor.integrity, 'content');
    assert.equal(descriptor.integrity, 'metadata', 'the stored audit descriptor is not mutated');
    const beforeBoundary = opens();
    await strict.assertUnchanged();
    assert.ok(opens() > beforeBoundary, 'strict override hashes bytes at subsequent boundaries too');
  } finally { await strict.close(); }
});


test('ordinary edits, restoration, additions, permissions and replacement invalidate metadata-policy input', async t => {
  const changes = [
    async (directory: string) => fs.writeFile(join(directory, 'file'), 'BBBB'),
    async (directory: string) => { await fs.writeFile(join(directory, 'file'), 'BBBB'); await fs.writeFile(join(directory, 'file'), 'AAAA'); },
    async (directory: string) => fs.writeFile(join(directory, '.hidden'), 'new'),
    async (directory: string) => fs.chmod(join(directory, 'file'), 0o444),
    async (directory: string) => { await fs.unlink(join(directory, 'file')); await fs.writeFile(join(directory, 'file'), 'AAAA'); },
    async (directory: string) => fs.rename(join(directory, 'file'), join(directory, 'renamed')),
  ];
  for (const change of changes) {
    const data = await fixture(t);
    // Make writes differ from captured mtime even within one timestamp tick. The separate
    // spoofed-stat test covers metadata that cannot distinguish different bytes.
    await fs.utimes(join(data.repoPath, 'file'), new Date(0), new Date(0));
    const handle = await prepareWorkspace({ ...data, integrity: 'metadata' });
    const descriptor = handle.descriptor;
    try {
      await change(data.repoPath);
      await assert.rejects(handle.assertUnchanged(), { code: 'WORKSPACE_CHANGED' });
    } finally { await handle.close(); }
    await assert.rejects(reopenWorkspace(descriptor), { code: 'WORKSPACE_CHANGED' });
  }
});

test('metadata proofs reject malformed policies, missing structure, mismatches and silent downgrades', async t => {
  const data = await fixture(t);
  await assert.rejects(prepareWorkspace({ ...data, integrity: 'unknown' as 'metadata' }), /integrity must be/);
  const handle = await prepareWorkspace({ ...data, integrity: 'metadata' });
  const descriptor = handle.descriptor;
  await handle.close();
  for (const invalid of [
    { ...descriptor, integrity: 'unknown' },
    { ...descriptor, structureHash: undefined },
    { ...descriptor, structureHash: null },
    { ...descriptor, structureHash: 'not-a-hash' },
    { ...descriptor, hash: { toString: () => descriptor.hash } },
  ]) await assert.rejects(reopenWorkspace(invalid as WorkspaceDescriptor), /Invalid persisted workspace descriptor/);
  await assert.rejects(reopenWorkspace({ ...descriptor, structureHash: '0'.repeat(64) }), { code: 'WORKSPACE_CHANGED' });
  await assert.rejects(reopenWorkspace(descriptor, { integrity: 'unknown' as 'metadata' }), /integrity must be/);
  const strict = await prepareWorkspace({ ...data });
  try {
    assert.equal(strict.descriptor.integrity, undefined);
    assert.equal(strict.descriptor.structureHash, undefined);
    await assert.rejects(reopenWorkspace(strict.descriptor, { integrity: 'metadata' }), /explicitly captured/);
  } finally { await strict.close(); }
});

test('default strict hashing detects same-size bytes under spoofed metadata; opt-in metadata policy documents its weaker assumption', async t => {
  const data = await fixture(t);
  const filePath = resolve(data.repoPath, 'file');
  const strict = await prepareWorkspace({ ...data });
  const strictDescriptor = strict.descriptor;
  await strict.close();
  const metadata = await prepareWorkspace({ ...data, integrity: 'metadata' });
  const metadataDescriptor = metadata.descriptor;
  await metadata.close();
  const originalStats = await fs.lstat(filePath, { bigint: true });
  await fs.writeFile(filePath, 'BBBB');
  const lstat = fs.lstat, open = fs.open;
  t.mock.method(fs, 'lstat', async (...args: unknown[]) => String(args[0]) === filePath ? originalStats : Reflect.apply(lstat, fs, args));
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === filePath) t.mock.method(handle, 'stat', async () => originalStats);
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(reopenWorkspace(strictDescriptor), { code: 'WORKSPACE_CHANGED' });
  await assert.rejects(reopenWorkspace(metadataDescriptor, { integrity: 'content' }), { code: 'WORKSPACE_CHANGED' });
  const weaker = await reopenWorkspace(metadataDescriptor);
  try {
    await weaker.assertUnchanged();
    assert.equal(await fs.readFile(filePath, 'utf8'), 'BBBB');
    assert.equal(weaker.descriptor.hash, metadataDescriptor.hash, 'unchanged metadata cannot prove unchanged bytes');
  } finally { await weaker.close(); }
  const freshStrict = await prepareWorkspace({ ...data });
  try { assert.notEqual(freshStrict.descriptor.hash, strictDescriptor.hash, 'new strict captures always read actual bytes'); }
  finally { await freshStrict.close(); }
});

test('metadata acquisition honors cancellation and cannot return a changed structural proof', async t => {
  const data = await fixture(t);
  const handle = await prepareWorkspace({ ...data, integrity: 'metadata' });
  const descriptor = handle.descriptor;
  await handle.close();
  const controller = new AbortController();
  await assert.rejects(reopenWorkspace(descriptor, {
    signal: controller.signal,
    onProgress(progress) { if (!progress.completed) controller.abort(new Error('cancel metadata acquisition')); },
  }), /cancel metadata acquisition/);
  const completedController = new AbortController();
  await assert.rejects(reopenWorkspace(descriptor, {
    signal: completedController.signal,
    onProgress(progress) { if (progress.completed) completedController.abort(new Error('cancel after completed progress')); },
  }), /cancel after completed progress/);
  let clock = 0, edited = false;
  t.mock.method(Date, 'now', () => clock += 1001);
  await assert.rejects(reopenWorkspace(descriptor, {
    onProgress(progress) {
      if (!edited && !progress.completed && progress.files === 1) {
        edited = true;
        writeFileSync(join(data.repoPath, 'file'), 'BBBB');
      }
    },
  }), { code: 'WORKSPACE_CHANGED' });
  assert.equal(edited, true, 'mutation occurs inside the acquisition traversal');
  await fs.mkdir(join(data.repoPath, 'empty-directory'));
  await assert.rejects(reopenWorkspace(descriptor), { code: 'WORKSPACE_CHANGED' });
});

test('explicit metadata boundaries start a fresh traversal after any earlier background scan', async t => {
  const data = await fixture(t);
  const laterPath = resolve(data.repoPath, 'z-later');
  await fs.writeFile(laterPath, 'unchanged');
  let notify: () => void = () => { throw new Error('watcher not installed'); };
  const watch = nativeFs.watch, lstat = fs.lstat;
  let pause = false, paused = false;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(nativeFs, 'watch', (...args: unknown[]) => {
    const callback = args[2] as (event: string, name: string) => void;
    notify = () => callback('change', 'file');
    // Model delayed OS delivery: only explicitly triggered notifications reach the observer.
    return Reflect.apply(watch, nativeFs, [args[0], args[1], () => {}]);
  });
  t.mock.method(fs, 'lstat', async (...args: unknown[]) => {
    const info = await Reflect.apply(lstat, fs, args);
    if (pause && !paused && String(args[0]) === laterPath) {
      paused = true;
      entered();
      await gate;
    }
    return info;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const handle = await prepareWorkspace({ ...data, integrity: 'metadata' });
  try {
    pause = true;
    notify();
    await blocked; // The background traversal has already checked the earlier file.
    await fs.writeFile(join(data.repoPath, 'file'), 'BBBB');
    const assertion = handle.assertUnchanged();
    release();
    await assert.rejects(assertion, { code: 'WORKSPACE_CHANGED' });
  } finally { release(); await handle.close(); }
});

test('structure verification rejects changed symlink targets even when reported stat tuples match', async t => {
  const data = await fixture(t);
  const linkPath = resolve(data.repoPath, 'link');
  await fs.writeFile(linkPath, 'controlled symlink fixture');
  await fs.writeFile(join(data.repoPath, 'other'), 'BBBB');
  const info = await fs.lstat(linkPath, { bigint: true });
  const linkInfo = Object.assign(Object.create(info), {
    mode: (info.mode & 0o777n) | 0o120000n,
    isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true,
  });
  let target = 'file';
  const lstat = fs.lstat, readlink = fs.readlink, realpath = fs.realpath;
  // Controlled filesystem primitives model a link whose target changes without a stat change.
  // No privileged symlink creation is needed for this proof-comparison regression.
  t.mock.method(fs, 'lstat', async (...args: unknown[]) => String(args[0]) === linkPath ? linkInfo : Reflect.apply(lstat, fs, args));
  t.mock.method(fs, 'readlink', async (...args: unknown[]) => String(args[0]) === linkPath ? target : Reflect.apply(readlink, fs, args));
  t.mock.method(fs, 'realpath', async (...args: unknown[]) => String(args[0]) === linkPath ? join(data.repoPath, target) : Reflect.apply(realpath, fs, args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const handle = await prepareWorkspace({ ...data, integrity: 'metadata' });
  const descriptor = handle.descriptor;
  await handle.close();
  target = 'other';
  const changed = await inspectWorkspace(data.repoPath, { contents: false });
  assert.equal(changed.metadataHash, descriptor.baselineMetadataHash);
  assert.notEqual(changed.structureHash, descriptor.structureHash);
  await assert.rejects(reopenWorkspace(descriptor), { code: 'WORKSPACE_CHANGED' });
});
