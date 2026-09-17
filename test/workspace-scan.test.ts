import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectWorkspace, removeOwnedWorkspaceTree } from '../src/workspaces/index.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'ccdd-scan-'));
  t.after(() => removeOwnedWorkspaceTree(root));
  return root;
}

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('workspace scans retain persisted depth-first identities across concurrent completion order', async t => {
  const root = await fixture(t);
  const paths = ['.git', 'a', 'a/empty', 'node_modules'];
  for (const name of paths) await fs.mkdir(join(root, name));
  const files = new Map([
    ['.git/HEAD', Buffer.from('ref: refs/heads/main\n')],
    ['.gitignore', Buffer.from('node_modules/\n')],
    ['a/large', Buffer.alloc(2 * 1024 * 1024, 42)],
    ['a/small', Buffer.from('\uD55C\uAE00\r\n')],
    ['a-', Buffer.from('sibling after the complete a subtree')],
    ['node_modules/package.json', Buffer.from('{"name":"included"}')],
    ['z', Buffer.alloc(0)],
  ]);
  for (const [name, bytes] of files) await fs.writeFile(join(root, name), bytes);
  const order = ['', '.git', '.git/HEAD', '.gitignore', 'a', 'a/empty', 'a/large', 'a/small', 'a-', 'node_modules', 'node_modules/package.json', 'z'];
  const entries = [];
  const metadata = [];
  for (const name of order) {
    const info = await fs.lstat(join(root, name), { bigint: true });
    metadata.push([name, ...[info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].map(String)]);
    if (name) entries.push(files.has(name)
      ? { path: name, type: 'file', executable: Number(info.mode & 0o111n), content: digest(files.get(name)!) }
      : { path: name, type: 'directory', executable: Number(info.mode & 0o111n) });
  }
  const expectedHash = digest(JSON.stringify(entries));
  const expectedMetadata = digest(JSON.stringify(metadata));
  for (let repeat = 0; repeat < 3; repeat++) {
    const scan = await inspectWorkspace(root);
    assert.equal(scan.hash, expectedHash);
    assert.equal(scan.metadataHash, expectedMetadata);
    assert.equal((await inspectWorkspace(root, { contents: false })).metadataHash, expectedMetadata);
  }
});

async function instrumentReaders(t: TestContext, onRead?: (filePath: string) => Promise<void>) {
  const originalOpen = fs.open;
  let active = 0, peak = 0, opened = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    peak = Math.max(peak, ++active);
    opened++;
    const close = handle.close.bind(handle);
    const read = handle.read;
    t.mock.method(handle, 'close', async () => { try { await close(); } finally { active--; } });
    t.mock.method(handle, 'read', async (...readArgs: unknown[]) => {
      await onRead?.(String(args[0]));
      await delay(1);
      return Reflect.apply(read, handle, readArgs);
    });
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => ({ active, peak, opened });
}

test('wide workspace scans bound concurrent file handles and drain them before cancellation returns', async t => {
  const root = await fixture(t);
  for (let i = 0; i < 48; i++) await fs.writeFile(join(root, `file-${i}`), Buffer.alloc(512 * 1024, i));
  const controller = new AbortController();
  let reads = 0;
  let cancel = false;
  const counts = await instrumentReaders(t, async () => {
    if (cancel && ++reads === 8) controller.abort(new Error('cancel during concurrent reads'));
  });
  await inspectWorkspace(root);
  assert.equal(counts().opened, 48);
  assert.ok(counts().peak > 1, 'independent files overlap');
  assert.ok(counts().peak <= 8, 'open files remain bounded regardless of tree width');
  assert.equal(counts().active, 0);
  cancel = true;
  await assert.rejects(inspectWorkspace(root, { signal: controller.signal }), /cancel during concurrent reads/);
  assert.equal(counts().active, 0, 'rejection waits until every in-flight handle closes');
  assert.ok(counts().opened < 96, 'cancellation stops scheduling remaining files');
});

test('a directory mutation during descendant reads fails after all concurrent readers close', async t => {
  const root = await fixture(t);
  await fs.mkdir(join(root, 'directory'));
  for (let i = 0; i < 24; i++) await fs.writeFile(join(root, 'directory', `file-${i}`), Buffer.alloc(256 * 1024, i));
  let mutated = false;
  const counts = await instrumentReaders(t, async () => {
    if (!mutated) {
      mutated = true;
      await fs.writeFile(join(root, 'directory', 'added-during-scan'), 'must invalidate');
    }
  });
  await assert.rejects(inspectWorkspace(root), { code: 'WORKSPACE_CHANGED' });
  assert.equal(counts().active, 0);
});

test('concurrent readers close when a sibling symlink is unsafe', async t => {
  const root = await fixture(t);
  for (let i = 0; i < 12; i++) await fs.writeFile(join(root, `a-${i}`), Buffer.alloc(256 * 1024, i));
  try { await fs.symlink('missing-target', join(root, 'z-dangling')); }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('This Windows account cannot create symlinks.');
      return;
    }
    throw error;
  }
  const counts = await instrumentReaders(t);
  await assert.rejects(inspectWorkspace(root), /symlink must resolve/);
  assert.equal(counts().active, 0);
});

test('same-size file mutations during concurrent reads fail the content scan', async t => {
  const root = await fixture(t);
  for (let i = 0; i < 16; i++) await fs.writeFile(join(root, `file-${i}`), Buffer.alloc(256 * 1024, i));
  let mutated = false;
  const counts = await instrumentReaders(t, async filePath => {
    if (!mutated) {
      mutated = true;
      await fs.writeFile(filePath, Buffer.alloc(256 * 1024, 99));
    }
  });
  await assert.rejects(inspectWorkspace(root), { code: 'WORKSPACE_CHANGED' });
  assert.equal(counts().active, 0);
});
