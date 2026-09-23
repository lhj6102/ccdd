import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspace, reopenWorkspace, removeOwnedWorkspaceTree, type WorkspaceHandle, type WorkspaceScanProgress } from '../src/workspaces/index.js';

async function fixture(t: TestContext, options: { signal?: AbortSignal; progress?: (progress: WorkspaceScanProgress) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-concurrent-checks-'));
  const repoPath = join(root, 'input'), stateDir = join(root, 'state');
  const handles: WorkspaceHandle[] = [];
  t.after(async () => { await Promise.all(handles.map(handle => handle.close())); await removeOwnedWorkspaceTree(root); });
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'artifact.txt'), 'Fixed input.');
  await writeFile(join(repoPath, 'payload.bin'), Buffer.alloc(1024 * 1024, 42));
  const prepared = await prepareWorkspace({ repoPath, stateDir });
  handles.push(prepared);
  await prepared.close();
  const scans = { started: 0, completed: 0 };
  let recording = false;
  const handle = await reopenWorkspace(prepared.descriptor, { signal: options.signal, onProgress(progress) {
    if (!recording) return;
    if (progress.kind === 'content') {
      if (!progress.completed && progress.files === 0 && progress.bytes === 0) scans.started++;
      if (progress.completed) scans.completed++;
    }
    options.progress?.(progress);
  } });
  handles.push(handle); recording = true;
  return { handle, scans, repoPath };
}

test('concurrent content boundaries share one full validation of the supplied workspace', async t => {
  const { handle, scans } = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, () => handle.assertUnchanged()));
  assert.deepEqual(scans, { started: 1, completed: 1 });
  await handle.assertUnchanged();
  assert.deepEqual(scans, { started: 2, completed: 2 }, 'A later boundary still performs a fresh full scan.');
});

test('content boundaries arriving during a metadata poll perform one shared full scan afterward', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { handle, scans } = await fixture(t);
  t.mock.timers.tick(1000);
  await Promise.all(Array.from({ length: 8 }, () => handle.assertUnchanged()));
  assert.deepEqual(scans, { started: 1, completed: 1 }, 'Metadata polling cannot substitute for content verification.');
});

test('a content-boundary caller reentering from progress receives a successor scan', async t => {
  let current: WorkspaceHandle | undefined;
  let nested: Promise<unknown> | undefined;
  const { handle, scans } = await fixture(t, { progress(progress) {
    if (current && !nested && progress.kind === 'content' && !progress.completed) nested = current.assertUnchanged();
  } });
  current = handle;
  await handle.assertUnchanged();
  assert.ok(nested);
  await nested;
  assert.deepEqual(scans, { started: 2, completed: 2 }, 'Progress runs after traversal starts, so reentry needs a fresh successor.');
});

test('post-tool content boundaries reject a changed file already visited by an earlier scan even when events are delayed', async t => {
  const originalWatch = fs.watch;
  // Delay filesystem notification delivery, while retaining real content reads,
  // metadata checks, mutations and watcher ownership/cleanup.
  t.mock.method(fs, 'watch', (...args: unknown[]) => {
    args[args.length - 1] = () => {};
    return Reflect.apply(originalWatch, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let mutate: (() => void) | undefined, late: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let current: WorkspaceHandle | undefined;
  const { handle, scans, repoPath } = await fixture(t, { progress(progress) {
    if (progress.kind === 'content' && progress.completed && mutate) {
      const write = mutate; mutate = undefined; write();
      // These callers arrive after the earlier traversal inspected the file.
      late = Promise.allSettled(Array.from({ length: 4 }, () => current!.assertUnchanged()));
    }
  } });
  current = handle;
  mutate = () => writeFileSync(join(repoPath, 'artifact.txt'), 'Modified after the earlier traversal.');
  await Promise.allSettled([handle.assertUnchanged()]);
  assert.ok(late);
  for (const result of await late) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason.code, 'WORKSPACE_CHANGED');
  }
  assert.equal(scans.started, 2, 'Late synchronous callers share one fresh successor, never the earlier traversal.');
  assert.equal(handle.signal.aborted, true);
});

test('close drains the owned scan and every concurrent waiter before another scan can start', async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const { handle, scans } = await fixture(t, { progress(progress) {
    if (progress.kind === 'content' && !progress.completed) entered();
  } });
  const results = Promise.allSettled(Array.from({ length: 8 }, () => handle.assertUnchanged()));
  await started;
  await Promise.all([handle.close(), handle.close()]);
  assert.deepEqual(scans, { started: 1, completed: 1 }, 'Close waits until the full reader has finished.');
  for (const result of await results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.match(String(result.reason), /closed/);
  }
  await assert.rejects(handle.assertUnchanged(), /closed/);
  assert.equal(scans.started, 1);
});

test('close and cancellation prevent content waiters from restarting after a metadata poll', async t => {
  for (const action of ['close', 'cancel'] as const) await t.test(action, async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const controller = new AbortController();
    const { handle, scans } = await fixture(t, { signal: controller.signal });
    t.mock.timers.tick(1000);
    const results = Promise.allSettled(Array.from({ length: 8 }, () => handle.assertUnchanged()));
    if (action === 'cancel') controller.abort(new Error('The boundary caller cancelled.'));
    await handle.close();
    for (const result of await results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.match(String(result.reason), action === 'close' ? /closed/ : /caller cancelled/);
    }
    assert.deepEqual(scans, { started: 0, completed: 0 });
  });
});

test('a mutation during a shared validation rejects all callers and remains latched', async t => {
  let mutate: (() => void) | undefined;
  const { handle, scans, repoPath } = await fixture(t, { progress(progress) {
    if (progress.kind === 'content' && !progress.completed && mutate) {
      const write = mutate; mutate = undefined; write();
    }
  } });
  mutate = () => writeFileSync(join(repoPath, 'artifact.txt'), 'Changed during shared validation.');
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => handle.assertUnchanged()));
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason.code, 'WORKSPACE_CHANGED');
  }
  assert.equal(handle.signal.aborted, true);
  assert.equal(scans.started, 1);
  await assert.rejects(handle.assertUnchanged(), { code: 'WORKSPACE_CHANGED' });
});
