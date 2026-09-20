import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { prepareWorkspace, reopenWorkspace, removeOwnedWorkspaceTree, type WorkspaceIntegrity } from '../src/workspaces/index.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'ccdd-publication-'));
  const repoPath = join(root, 'input'), stateDir = join(root, 'state');
  await fs.mkdir(join(repoPath, 'nested'), { recursive: true });
  await fs.writeFile(join(repoPath, 'nested', 'file'), 'captured input');
  t.after(() => removeOwnedWorkspaceTree(root));
  return { root, repoPath, stateDir };
}

function trackPublishedReads(t: TestContext, stateDir: string) {
  const open = fs.open;
  let reads = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const parts = relative(join(stateDir, 'workspaces'), String(args[0])).split(/[/\\]/);
    if (/^[a-f0-9]{64}$/.test(parts[0]) && parts.length > 1) reads++;
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => reads;
}

test('metadata copy acquisition carries staged content proof across publication without rereading published bytes', async t => {
  const f = await fixture(t);
  const reads = trackPublishedReads(t, f.stateDir);
  const handle = await prepareWorkspace({ ...f, integrity: 'metadata' });
  try {
    assert.equal(await fs.readFile(join(handle.descriptor.path, 'nested', 'file'), 'utf8'), 'captured input');
    assert.equal(reads(), 0, 'fresh metadata acquisition must not repeat the staged content traversal');
    await handle.assertUnchanged();
    const reopened = await reopenWorkspace(handle.descriptor);
    try { await reopened.assertUnchanged(); } finally { await reopened.close(); }
    assert.equal(reads(), 0, 'the published metadata baseline remains valid after reopening');
  } finally { await handle.close(); }
});

test('content copy acquisition still reads published bytes before returning its observer', async t => {
  const f = await fixture(t);
  const reads = trackPublishedReads(t, f.stateDir);
  const handle = await prepareWorkspace(f);
  try { assert.equal(reads(), 1); } finally { await handle.close(); }
});

test('cached copies receive one complete content validation at acquisition under either policy', async t => {
  for (const integrity of ['content', 'metadata'] as WorkspaceIntegrity[]) await t.test(integrity, async t => {
    const f = await fixture(t);
    const first = await prepareWorkspace({ ...f, integrity });
    await first.close();
    const reads = trackPublishedReads(t, f.stateDir);
    const cached = await prepareWorkspace({ ...f, integrity });
    try {
      assert.equal(cached.descriptor.path, first.descriptor.path);
      assert.equal(reads(), 1, 'cache admission validates bytes once with its retained observer');
    } finally { await cached.close(); }
  });
});

function afterPublication(t: TestContext, action: (directory: string) => Promise<void>) {
  const rename = fs.rename;
  let invoked = false;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    const result = await rename(...args);
    if (basename(String(args[0])).startsWith('.capture-')) {
      invoked = true;
      await action(String(args[1]));
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => invoked;
}

test('a changed child after publication cannot inherit the staged metadata proof', async t => {
  const f = await fixture(t);
  const invoked = afterPublication(t, async directory => {
    const file = join(directory, 'nested', 'file');
    await fs.chmod(file, 0o644);
    await fs.writeFile(file, 'different data');
    await fs.chmod(file, 0o444);
  });
  await assert.rejects(prepareWorkspace({ ...f, integrity: 'metadata' }), { code: 'WORKSPACE_CACHE_TAMPERED' });
  assert.equal(invoked(), true);
});

test('unexpected directory timestamp changes fall back to content validation and record the published baseline', async t => {
  const f = await fixture(t);
  const reads = trackPublishedReads(t, f.stateDir);
  const invoked = afterPublication(t, async directory => {
    const info = await fs.stat(directory);
    await fs.utimes(directory, info.atime, new Date(info.mtimeMs + 10000));
  });
  const handle = await prepareWorkspace({ ...f, integrity: 'metadata' });
  try {
    assert.equal(invoked(), true);
    assert.equal(reads(), 1, 'a failed handoff proof requires actual byte validation');
    const reopened = await reopenWorkspace(handle.descriptor);
    try { await reopened.assertUnchanged(); } finally { await reopened.close(); }
  } finally { await handle.close(); }
});
