import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fingerprintWorkspace, prepareWorkspace, reopenWorkspace, removeOwnedWorkspaceTree, validateStateLocation } from '../src/workspaces/index.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-workspace-'));
  const repoPath = join(root, 'repo');
  const stateDir = join(root, 'state');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'why.md'), 'Why\n');
  t.after(() => removeOwnedWorkspaceTree(root));
  return { root, repoPath, stateDir };
}

test('copy includes all files without Git, including dotfiles, ignored and untracked entries', async t => {
  const data = await fixture(t);
  await mkdir(join(data.repoPath, 'ignored'));
  await writeFile(join(data.repoPath, '.gitignore'), 'ignored/\n');
  await writeFile(join(data.repoPath, 'ignored', 'untracked.txt'), 'included');
  await writeFile(join(data.repoPath, '.hidden'), 'included');
  const handle = await prepareWorkspace({ ...data, mode: 'copy' });
  t.after(() => handle.close());
  assert.equal(handle.descriptor.hash, await fingerprintWorkspace(data.repoPath));
  assert.equal(await readFile(join(handle.descriptor.path, 'ignored', 'untracked.txt'), 'utf8'), 'included');
  assert.equal(await readFile(join(handle.descriptor.path, '.hidden'), 'utf8'), 'included');
  assert.equal((await lstat(join(handle.descriptor.path, 'why.md'))).mode & 0o222, 0);
  await writeFile(join(data.repoPath, 'why.md'), 'Builder continues');
  await writeFile(join(data.repoPath, 'added-after.txt'), 'new');
  await handle.assertUnchanged();
  assert.equal(await readFile(join(handle.descriptor.path, 'why.md'), 'utf8'), 'Why\n');
});

test('simultaneous identical copies share one immutable input, while source differences select another hash', async t => {
  const data = await fixture(t);
  const handles = await Promise.all(Array.from({ length: 3 }, () => prepareWorkspace({ ...data, mode: 'copy' })));
  t.after(() => Promise.all(handles.map(handle => handle.close())));
  assert.equal(new Set(handles.map(handle => handle.descriptor.path)).size, 1);
  assert.equal((await readdir(join(data.stateDir, 'workspaces'))).length, 1);
  await Promise.all(handles.map(handle => handle.assertUnchanged()));
  await writeFile(join(data.repoPath, 'why.md'), 'different');
  const next = await prepareWorkspace({ ...data, mode: 'copy' });
  t.after(() => next.close());
  assert.notEqual(next.descriptor.hash, handles[0].descriptor.hash);
  await Promise.all(handles.map(handle => handle.assertUnchanged()));
});

test('concurrent empty workspace copies cannot replace the first published directory', async t => {
  const data = await fixture(t);
  await unlink(join(data.repoPath, 'why.md'));
  const handles = await Promise.all([prepareWorkspace(data), prepareWorkspace(data)]);
  t.after(() => Promise.all(handles.map(handle => handle.close())));
  assert.equal(handles[0].descriptor.path, handles[1].descriptor.path);
  await delay(30);
  await Promise.all(handles.map(handle => handle.assertUnchanged()));
});

test('independent processes publish and reuse one copy for the same hash', async t => {
  const data = await fixture(t);
  const moduleUrl = new URL('../src/workspaces/index.js', import.meta.url).href;
  const source = `const {prepareWorkspace} = await import(process.argv[1]); const handle = await prepareWorkspace(JSON.parse(process.argv[2])); console.log(JSON.stringify(handle.descriptor)); await handle.close();`;
  const outputs = await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, moduleUrl, JSON.stringify(data)])));
  const descriptors = outputs.map(output => JSON.parse(output.stdout));
  assert.equal(new Set(descriptors.map(descriptor => descriptor.path)).size, 1);
  assert.equal(new Set(descriptors.map(descriptor => descriptor.baselineMetadataHash)).size, 1);
  assert.equal((await readdir(join(data.stateDir, 'workspaces'))).length, 1);
});

test('a source mutation during capture fails without publishing a partial cache', async t => {
  const data = await fixture(t);
  for (let i = 0; i < 4; i++) await writeFile(join(data.repoPath, `large-${i}`), Buffer.alloc(2 * 1024 * 1024, i));
  let settled = false;
  let mutated = false;
  const capture = prepareWorkspace(data).finally(() => { settled = true; });
  const writer = (async () => {
    while (!settled) {
      const entries = await readdir(join(data.stateDir, 'workspaces')).catch(() => []);
      if (entries.some(entry => entry.startsWith('.capture-'))) {
        // Adding a file avoids Windows copyFile's temporary source-file lock.
        await writeFile(join(data.repoPath, 'added-during-copy.txt'), 'Changed while copying');
        mutated = true;
        return;
      }
      await delay(1);
    }
  })();
  await assert.rejects(capture, /workspace changed/i);
  await writer;
  assert.equal(mutated, true);
  assert.deepEqual(await readdir(join(data.stateDir, 'workspaces')), []);
});

test('lock retains original workspace and latches edited-then-restored contents', async t => {
  const data = await fixture(t);
  const handle = await prepareWorkspace({ ...data, mode: 'lock' });
  t.after(() => handle.close());
  assert.equal(handle.descriptor.path, await realpath(data.repoPath));
  await writeFile(join(data.repoPath, 'why.md'), 'changed');
  await writeFile(join(data.repoPath, 'why.md'), 'Why\n');
  await assert.rejects(handle.assertUnchanged(), error => error instanceof Error && 'code' in error && error.code === 'WORKSPACE_CHANGED');
  assert.equal(handle.signal.aborted, true);
});

test('lock detects create-delete and directory rename activity', async t => {
  const data = await fixture(t);
  const handle = await prepareWorkspace({ ...data, mode: 'lock' });
  t.after(() => handle.close());
  await mkdir(join(data.repoPath, 'transient'));
  await writeFile(join(data.repoPath, 'transient', 'file'), 'temporary');
  await rename(join(data.repoPath, 'transient'), join(data.repoPath, 'renamed'));
  await removeOwnedWorkspaceTree(join(data.repoPath, 'renamed'));
  await assert.rejects(handle.assertUnchanged(), error => error instanceof Error && 'code' in error && error.code === 'WORKSPACE_CHANGED');
});

test('persisted lock descriptors reject mutation and restoration between process lifetimes', async t => {
  const data = await fixture(t);
  const handle = await prepareWorkspace({ ...data, mode: 'lock' });
  const descriptor = structuredClone(handle.descriptor);
  await handle.close();
  await writeFile(join(data.repoPath, 'why.md'), 'temporary');
  await writeFile(join(data.repoPath, 'why.md'), 'Why\n');
  await assert.rejects(reopenWorkspace(descriptor), error => error instanceof Error && 'code' in error && error.code === 'WORKSPACE_CHANGED');
});

test('copy remains usable after source deletion, and descriptor paths are validated', async t => {
  const data = await fixture(t);
  const handle = await prepareWorkspace(data);
  const descriptor = structuredClone(handle.descriptor);
  await handle.close();
  await removeOwnedWorkspaceTree(data.repoPath);
  const reopened = await reopenWorkspace(descriptor);
  t.after(() => reopened.close());
  await reopened.assertUnchanged();
  await assert.rejects(reopenWorkspace({ ...descriptor, path: data.root }), /invalid input path/);
});

test('cache tampering is rejected by active and future users of the same hash', async t => {
  const data = await fixture(t);
  const handle = await prepareWorkspace(data);
  t.after(() => handle.close());
  const file = join(handle.descriptor.path, 'why.md');
  await chmod(file, 0o644);
  await writeFile(file, 'tampered');
  await chmod(file, 0o444);
  await assert.rejects(handle.assertUnchanged(), error => error instanceof Error && 'code' in error && error.code === 'WORKSPACE_CACHE_TAMPERED');
  await assert.rejects(prepareWorkspace(data), error => error instanceof Error && 'code' in error && error.code === 'WORKSPACE_CACHE_TAMPERED');
});

test('copy handoff returns a live cancellable observer and a reopenable published metadata baseline', async t => {
  for (const cached of [false, true]) await t.test(cached ? 'existing cache' : 'new publication', async t => {
    const data = await fixture(t);
    if (cached) { const first = await prepareWorkspace(data); await first.close(); }
    const controller = new AbortController();
    const handle = await prepareWorkspace({ ...data, signal: controller.signal });
    t.after(() => handle.close());
    const reopened = await reopenWorkspace(structuredClone(handle.descriptor));
    t.after(() => reopened.close());
    await reopened.assertUnchanged();
    assert.equal(await fingerprintWorkspace(handle.descriptor.path), handle.descriptor.hash);
    controller.abort(new Error('The acquiring caller cancelled this copy.'));
    await assert.rejects(handle.assertUnchanged(), /acquiring caller cancelled/);
    assert.equal(handle.signal.aborted, true);
    await reopened.assertUnchanged();
  });
});

test('copy handoff rejects tampering after publication lock release for new and reused caches', async t => {
  for (const cached of [false, true]) await t.test(cached ? 'existing cache' : 'new publication', async t => {
    const data = await fixture(t);
    await mkdir(join(data.repoPath, 'padding'));
    for (let i = 0; i < 128; i++) await writeFile(join(data.repoPath, 'padding', `${i}.txt`), 'Bound the asynchronous acquisition window.\n');
    if (cached) { const first = await prepareWorkspace(data); await first.close(); }
    const hash = await fingerprintWorkspace(data.repoPath);
    let settled = false;
    const capture = prepareWorkspace(data).then(handle => { t.after(() => handle.close()); return handle; }).finally(() => { settled = true; });
    const tamper = (async () => {
      let publicationObserved = false;
      while (!settled) {
        const entries: string[] = await readdir(join(data.stateDir, 'workspaces')).catch(() => []);
        const publishing = entries.includes(`.publish-${hash}`);
        publicationObserved ||= publishing;
        if (publicationObserved && !publishing && entries.includes(hash)) {
          const file = join(data.stateDir, 'workspaces', hash, 'why.md');
          await chmod(file, 0o600);
          await writeFile(file, 'Changed after publication and before acquisition returned.');
          await chmod(file, 0o444);
          return true;
        }
        await delay(1);
      }
      return false;
    })();
    try {
      await assert.rejects(capture, { code: 'WORKSPACE_CACHE_TAMPERED' });
      assert.equal(await tamper, true, 'The test must mutate the actual published copy during handoff.');
    } finally { await tamper; }
    await assert.rejects(prepareWorkspace(data), { code: 'WORKSPACE_CACHE_TAMPERED' });
  });
});

test('internal relative symlinks are copied without referring back to the mutable source', async t => {
  const data = await fixture(t);
  await symlink('why.md', join(data.repoPath, 'alias.md'));
  const handle = await prepareWorkspace(data);
  t.after(() => handle.close());
  await writeFile(join(data.repoPath, 'why.md'), 'changed source');
  assert.equal(await readFile(join(handle.descriptor.path, 'alias.md'), 'utf8'), 'Why\n');
  await handle.assertUnchanged();
});

test('escaping and absolute symlinks fail instead of silently copying external data', async t => {
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

test('content hashes preserve executable bits but ignore content-preserving timestamp differences', async t => {
  const data = await fixture(t);
  const first = await fingerprintWorkspace(data.repoPath);
  await writeFile(join(data.repoPath, 'why.md'), 'Why\n');
  assert.equal(await fingerprintWorkspace(data.repoPath), first);
  await chmod(join(data.repoPath, 'why.md'), 0o755);
  assert.notEqual(await fingerprintWorkspace(data.repoPath), first);
});

test('external cancellation closes without publishing a partial copy', async t => {
  const data = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(prepareWorkspace({ ...data, signal: controller.signal }), /cancelled/);
});

test('copy preserves nested and empty directories while materializing many sibling files', async t => {
  const data = await fixture(t);
  await mkdir(join(data.repoPath, 'tree', 'nested', 'empty'), { recursive: true });
  await mkdir(join(data.repoPath, '.hidden-empty'));
  for (let i = 0; i < 40; i++) {
    await writeFile(join(data.repoPath, 'tree', 'nested', `file-${i}`), Buffer.alloc(1024 + i, i));
  }
  const expected = await fingerprintWorkspace(data.repoPath);
  const handle = await prepareWorkspace(data);
  t.after(() => handle.close());
  assert.equal(handle.descriptor.hash, expected);
  assert.equal(await fingerprintWorkspace(handle.descriptor.path), expected);
  assert.deepEqual(await readdir(join(handle.descriptor.path, 'tree', 'nested', 'empty')), []);
  assert.deepEqual(await readdir(join(handle.descriptor.path, '.hidden-empty')), []);
  assert.equal((await lstat(join(handle.descriptor.path, 'tree', 'nested'))).mode & 0o222, 0);
  await handle.assertUnchanged();
});

test('cancelling an active copy drains file operations before removing private staging', async t => {
  const data = await fixture(t);
  for (let i = 0; i < 64; i++) await writeFile(join(data.repoPath, `file-${i}`), Buffer.alloc(256 * 1024, i));
  const controller = new AbortController();
  let settled = false, cancelled = false;
  const capture = prepareWorkspace({ ...data, signal: controller.signal }).finally(() => { settled = true; });
  const cancellation = (async () => {
    while (!settled) {
      const cache = join(data.stateDir, 'workspaces');
      const stage = (await readdir(cache).catch(() => [])).find(entry => entry.startsWith('.capture-'));
      if (stage && (await readdir(join(cache, stage)).catch(() => [])).length) {
        cancelled = true;
        controller.abort(new Error('cancelled during materialization'));
        return;
      }
      await delay(1);
    }
  })();
  await assert.rejects(capture, /cancelled during materialization/);
  await cancellation;
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(join(data.stateDir, 'workspaces')), []);
  // A late copy callback must not recreate or leave files after cleanup resolves.
  await delay(25);
  assert.deepEqual(await readdir(join(data.stateDir, 'workspaces')), []);
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
    const handle = await prepareWorkspace({ ...data, mode: 'lock', signal: controller.signal });
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
  for (const mode of ['lock', 'copy'] as const) {
    const data = await fixture(t);
    const handle = await prepareWorkspace({ ...data, mode });
    t.after(() => handle.close());
    await rename(handle.descriptor.path, `${handle.descriptor.path}-moved`);
    await assert.rejects(handle.assertUnchanged(), { code: mode === 'lock' ? 'WORKSPACE_CHANGED' : 'WORKSPACE_CACHE_TAMPERED' });
    assert.equal(handle.signal.aborted, true);
  }
});
