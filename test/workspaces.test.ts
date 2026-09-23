import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fingerprintWorkspace, prepareWorkspace, reopenWorkspace, removeOwnedWorkspaceTree, validateStateLocation, type WorkspaceDescriptor } from '../src/workspaces/index.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-workspace-'));
  const repoPath = join(root, 'repo');
  const stateDir = join(root, 'state');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'why.md'), 'Why\n');
  t.after(() => removeOwnedWorkspaceTree(root));
  return { root, repoPath, stateDir };
}

test('default preparation observes every entry in place without writing input or creating a cache', async t => {
  const data = await fixture(t);
  await mkdir(join(data.repoPath, 'node_modules', 'empty'), { recursive: true });
  await mkdir(join(data.repoPath, '.git'));
  await writeFile(join(data.repoPath, '.git', 'HEAD'), 'ref: refs/heads/main');
  await writeFile(join(data.repoPath, '.gitignore'), 'node_modules/');
  await writeFile(join(data.repoPath, 'node_modules', 'untracked.txt'), 'included');
  const target = join(data.repoPath, 'why.md');
  const before = await lstat(target, { bigint: true });
  const handles = await Promise.all([prepareWorkspace(data), prepareWorkspace(data)]);
  t.after(() => Promise.all(handles.map(handle => handle.close())));
  for (const handle of handles) {
    assert.equal(handle.descriptor.path, await realpath(data.repoPath));
    assert.equal(handle.descriptor.sourcePath, handle.descriptor.path);
    assert.equal(Object.hasOwn(handle.descriptor, 'mode'), false);
    assert.equal(handle.descriptor.hash, await fingerprintWorkspace(data.repoPath));
    await handle.assertUnchanged();
  }
  const after = await lstat(target, { bigint: true });
  for (const key of ['ino', 'mode', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key]);
  await assert.rejects(lstat(data.stateDir), { code: 'ENOENT' });
  await writeFile(join(data.repoPath, 'node_modules', 'untracked.txt'), 'changed');
  for (const handle of handles) await assert.rejects(handle.assertUnchanged(), { code: 'WORKSPACE_CHANGED' });
});

test('removed workspace options fail before input acquisition instead of silently changing semantics', async t => {
  const data = await fixture(t);
  for (const mode of ['copy', 'lock']) {
    await assert.rejects(prepareWorkspace({ ...data, mode } as Parameters<typeof prepareWorkspace>[0]), /modes are no longer supported/);
  }
  await assert.rejects(lstat(data.stateDir), { code: 'ENOENT' });
});

test('historical workspace descriptors cannot resume execution', async t => {
  const data = await fixture(t);
  const handle = await prepareWorkspace(data);
  await handle.close();
  const legacy = { ...handle.descriptor, version: 1, mode: 'lock' } as unknown as WorkspaceDescriptor;
  await assert.rejects(reopenWorkspace(legacy), /Invalid persisted/);
  await assert.rejects(reopenWorkspace({ ...legacy, mode: 'copy' } as unknown as WorkspaceDescriptor), /Invalid persisted/);
  await assert.rejects(reopenWorkspace({ ...handle.descriptor, path: data.root }), /invalid input path/);
});

test('content identity includes executable bits and empty directories but excludes timestamps', async t => {
  const data = await fixture(t);
  const first = await fingerprintWorkspace(data.repoPath);
  await writeFile(join(data.repoPath, 'why.md'), 'Why\n');
  assert.equal(await fingerprintWorkspace(data.repoPath), first);
  await chmod(join(data.repoPath, 'why.md'), 0o755);
  assert.notEqual(await fingerprintWorkspace(data.repoPath), first);
  const executable = await fingerprintWorkspace(data.repoPath);
  await mkdir(join(data.repoPath, 'empty'));
  assert.notEqual(await fingerprintWorkspace(data.repoPath), executable);
});

test('in-place review retains the supplied workspace and latches edited-then-restored contents', async t => {
  const data = await fixture(t);
  const handle = await prepareWorkspace({ ...data });
  t.after(() => handle.close());
  assert.equal(handle.descriptor.path, await realpath(data.repoPath));
  await writeFile(join(data.repoPath, 'why.md'), 'changed');
  await writeFile(join(data.repoPath, 'why.md'), 'Why\n');
  await assert.rejects(handle.assertUnchanged(), error => error instanceof Error && 'code' in error && error.code === 'WORKSPACE_CHANGED');
  assert.equal(handle.signal.aborted, true);
});

test('in-place review detects create-delete and directory rename activity', async t => {
  const data = await fixture(t);
  const handle = await prepareWorkspace({ ...data });
  t.after(() => handle.close());
  await mkdir(join(data.repoPath, 'transient'));
  await writeFile(join(data.repoPath, 'transient', 'file'), 'temporary');
  await rename(join(data.repoPath, 'transient'), join(data.repoPath, 'renamed'));
  await removeOwnedWorkspaceTree(join(data.repoPath, 'renamed'));
  await assert.rejects(handle.assertUnchanged(), error => error instanceof Error && 'code' in error && error.code === 'WORKSPACE_CHANGED');
});

test('persisted workspace descriptors reject mutation and restoration between process lifetimes', async t => {
  const data = await fixture(t);
  const handle = await prepareWorkspace({ ...data });
  const descriptor = structuredClone(handle.descriptor);
  await handle.close();
  await writeFile(join(data.repoPath, 'why.md'), 'temporary');
  await writeFile(join(data.repoPath, 'why.md'), 'Why\n');
  await assert.rejects(reopenWorkspace(descriptor), error => error instanceof Error && 'code' in error && error.code === 'WORKSPACE_CHANGED');
});

test('internal relative symlinks remain inside the observed workspace', async t => {
  const data = await fixture(t);
  await symlink('why.md', join(data.repoPath, 'alias.md'));
  const handle = await prepareWorkspace(data);
  t.after(() => handle.close());
  assert.equal(await readFile(join(handle.descriptor.path, 'alias.md'), 'utf8'), 'Why\n');
  await handle.assertUnchanged();
});

test('escaping and absolute symlinks cannot extend the reviewed workspace', async t => {
  const data = await fixture(t);
  await writeFile(join(data.root, 'outside'), 'external');
  await symlink('../outside', join(data.repoPath, 'escape'));
  await assert.rejects(prepareWorkspace(data), /symlink.*inside/);
  await unlink(join(data.repoPath, 'escape'));
  await symlink(join(data.repoPath, 'why.md'), join(data.repoPath, 'absolute'));
  await assert.rejects(prepareWorkspace(data), /symlink.*relative/);
});

test('state nesting is rejected before creating files, including paths through symlink ancestors', async t => {
  const data = await fixture(t);
  await assert.rejects(prepareWorkspace({ ...data, stateDir: join(data.repoPath, 'state') }), /outside/);
  await symlink(data.repoPath, join(data.root, 'alias'));
  await assert.rejects(validateStateLocation(data.repoPath, join(data.root, 'alias', 'new', 'state')), /outside/);
  assert.deepEqual(await readdir(data.repoPath), ['why.md']);
});

test('external cancellation leaves the supplied workspace unchanged', async t => {
  const data = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(prepareWorkspace({ ...data, signal: controller.signal }), /cancelled/);
});

for (const finish of ['close', 'abort', 'change'] as const) {
  test(`metadata fallback waits for completion, adapts its delay, and stops after ${finish}`, async t => {
    const data = await fixture(t), controller = new AbortController();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const timeout = globalThis.setTimeout, scheduled: number[] = [];
    t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) => {
      scheduled.push(milliseconds ?? 0);
      return timeout(callback, milliseconds, ...args);
    });
    let clock = 0;
    t.mock.method(performance, 'now', () => clock);
    const handle = await prepareWorkspace({ ...data, signal: controller.signal });
    t.after(() => handle.close());
    const until = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 10_000; attempt++) { if (condition()) return; await nextTurn(); }
      assert.fail('The real filesystem check did not settle.');
    };
    assert.deepEqual(scheduled, [1000]);
    t.mock.timers.tick(1000);
    // Let virtual time advance while the real asynchronous filesystem scan is
    // pending. No additional fallback callback may queue behind that scan.
    t.mock.timers.tick(20_000);
    assert.deepEqual(scheduled, [1000]);
    clock = 250;
    await until(() => scheduled.length === 2);
    assert.deepEqual(scheduled, [1000, 2500]);
    t.mock.timers.tick(2499);
    assert.equal(scheduled.length, 2);
    t.mock.timers.tick(1);
    clock = 4250;
    await until(() => scheduled.length === 3);
    assert.deepEqual(scheduled, [1000, 2500, 30_000], 'Bound a slow fallback delay without weakening action boundaries.');
    if (finish === 'close') await handle.close();
    else if (finish === 'abort') controller.abort(new Error('Fixture cancelled.'));
    else {
      // A real watcher must detect this while the fallback is parked for 30 s.
      await writeFile(join(data.repoPath, 'why.md'), 'Changed before the next fallback.');
      await until(() => handle.signal.aborted);
      await assert.rejects(handle.assertUnchanged(), { code: 'WORKSPACE_CHANGED' });
    }
    t.mock.timers.tick(60_000);
    await nextTurn();
    assert.equal(scheduled.length, 3, 'Closed or invalidated monitoring must not schedule another fallback.');
  });
}


test('moving an observed workspace root classifies missing scan paths as input mutation', async t => {
  const data = await fixture(t);
  const handle = await prepareWorkspace({ ...data });
  t.after(() => handle.close());
  await rename(handle.descriptor.path, `${handle.descriptor.path}-moved`);
  await assert.rejects(handle.assertUnchanged(), { code: 'WORKSPACE_CHANGED' });
    assert.equal(handle.signal.aborted, true);
});


test('a user-created Git worktree is evaluated directly while its original checkout can change', async t => {
  const data = await fixture(t);
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: data.repoPath });
  await git(['init', '--quiet']);
  await git(['add', 'why.md']);
  await git(['-c', 'user.name=CCDD Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Workspace fixture']);
  const reviewPath = join(data.root, 'user-review');
  await git(['worktree', 'add', '--detach', reviewPath, 'HEAD']);
  const handle = await prepareWorkspace({ repoPath: reviewPath, stateDir: data.stateDir });
  t.after(() => handle.close());
  assert.equal(handle.descriptor.path, await realpath(reviewPath));
  assert.ok((await lstat(join(reviewPath, '.git'))).isFile());
  await writeFile(join(data.repoPath, 'why.md'), 'Editing the original checkout.');
  await handle.assertUnchanged();
  assert.equal(await readFile(join(reviewPath, 'why.md'), 'utf8'), 'Why\n');
  await assert.rejects(lstat(data.stateDir), { code: 'ENOENT' });
});
