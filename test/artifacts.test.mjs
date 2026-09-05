import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createArtifactViewer, createArtifactTools, readArtifact } from '../src/artifacts/index.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-artifacts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worktreePath = join(dir, 'snapshot');
  await mkdir(join(worktreePath, 'tests'), { recursive: true });
  await writeFile(join(worktreePath, 'why.md'), '# Why\nPick two tasks.\n');
  await writeFile(join(worktreePath, 'tests', 'rank.test.mjs'), 'export const expected = 2;\n');
  await writeFile(join(worktreePath, 'private.md'), 'Not declared for this review');
  const artifacts = [{ id: 'why', type: 'markdown', path: 'why.md' }, { id: 'tests', type: 'code', path: 'tests' }];
  const artifactTypes = { markdown: { viewer: 'text' }, code: { viewer: 'files' } };
  return { dir, worktreePath, artifacts, artifactTypes };
}

test('request artifact types produce concrete read and directory viewer tools', async t => {
  const fixtureData = await fixture(t);
  const viewer = await createArtifactViewer(fixtureData);
  const registry = createArtifactTools(viewer);
  assert.deepEqual(registry.tools.map(x => x.name), ['read_why', 'list_tests', 'read_tests']);
  assert.match((await registry.call('read_why', {})).content, /Pick two/);
  const listing = await registry.call('list_tests', {});
  assert.equal(listing.entries[0].path, 'rank.test.mjs');
  assert.match((await registry.call('read_tests', { path: listing.entries[0].path })).content, /expected = 2/);
  assert.equal((await readArtifact({ ...fixtureData, artifactId: 'tests' })).directory, true);
  assert.match((await readArtifact({ ...fixtureData, artifactId: 'tests', file: 'rank.test.mjs' })).content, /expected/);
});

test('bounded reads paginate and reject undeclared paths, traversal, absolute paths and symlink escapes', async t => {
  const data = await fixture(t);
  await writeFile(join(data.dir, 'outside'), 'outside secret');
  await symlink(join(data.dir, 'outside'), join(data.worktreePath, 'tests', 'escape'));
  await symlink('../private.md', join(data.worktreePath, 'tests', 'other-artifact'));
  const viewer = await createArtifactViewer(data);
  const first = await viewer.read({ artifactId: 'why', limit: 4 });
  assert.equal(first.content, '# Wh');
  assert.equal(first.nextOffset, 4);
  assert.equal(first.truncated, true);
  assert.equal((await viewer.read({ artifactId: 'why', offset: 4, limit: 2 })).content, 'y\n');
  for (const path of ['../private.md', '/etc/passwd', 'escape', 'other-artifact', 'nested/../../private.md', '..\\private.md']) {
    await assert.rejects(viewer.read({ artifactId: 'tests', path }));
  }
  await assert.rejects(viewer.read({ artifactId: 'private' }));
  await assert.rejects(viewer.read({ artifactId: 'why', path: 'private.md' }));
  await assert.rejects(viewer.read({ artifactId: 'why', limit: 65_537 }));
  await assert.rejects(viewer.read({ artifactId: 'why', offset: -1 }));
  await assert.rejects(createArtifactTools(viewer).call('read_why', { artifactId: 'private' }));
});

test('declared artifacts and type adapters are checked before exposing tools', async t => {
  const data = await fixture(t);
  await symlink(data.dir, join(data.worktreePath, 'escape'));
  await assert.rejects(createArtifactViewer({ ...data, artifacts: [{ id: 'escape', type: 'code', path: 'escape' }] }), /escapes/);
  await assert.rejects(createArtifactViewer({ ...data, artifacts: [{ id: 'why', type: 'missing', path: 'why.md' }] }), /Unsupported/);
  await assert.rejects(createArtifactViewer({ ...data, artifacts: [data.artifacts[0], data.artifacts[0]] }), /duplicate/);
});

test('actual stdio MCP process negotiates and serves scoped viewer calls with bounded errors', async t => {
  const data = await fixture(t);
  const manifest = join(data.dir, 'manifest.json');
  await writeFile(manifest, JSON.stringify(data));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/artifacts/mcp-server.mjs', import.meta.url)), manifest], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
  let sequence = 0;
  const call = (method, params) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  assert.equal((await call('initialize', { protocolVersion: '2024-11-05' })).result.serverInfo.name, 'ccdd-artifact-runner');
  assert.equal((await call('tools/list')).result.tools.length, 3);
  assert.match((await call('tools/call', { name: 'read_why', arguments: {} })).result.content[0].text, /Pick two/);
  assert.equal((await call('tools/call', { name: 'read_tests', arguments: { path: '../private.md' } })).result.isError, true);
  assert.equal((await call('does-not-exist')).error.code, -32601);
  child.stdin.end();
});
