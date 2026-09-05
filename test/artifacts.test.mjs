import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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
  const artifactTypes = { markdown: { viewer: 'text', tools: { read: { description: '{artifactName}의 문서를 줄 단위로 읽는다.' } } }, code: { viewer: 'files', tools: { list: { description: '{artifactName}의 파일 목록을 조회한다.' }, read: { description: '{artifactName}의 소스 텍스트를 읽는다.' } } } };
  return { dir, worktreePath, artifacts, artifactTypes };
}

test('request artifact types produce concrete read and directory viewer tools', async t => {
  const fixtureData = await fixture(t);
  const viewer = await createArtifactViewer(fixtureData);
  const registry = createArtifactTools(viewer);
  assert.deepEqual(registry.tools.map(x => x.name), ['read_why', 'list_tests', 'read_tests']);
  assert.equal(registry.tools[0].description, 'why의 문서를 줄 단위로 읽는다.');
  assert.equal(registry.tools[2].description, 'tests의 소스 텍스트를 읽는다.');
  assert.equal(registry.tools[0].inputSchema.properties.path, undefined);
  assert.deepEqual(registry.tools[2].inputSchema.required, ['path']);
  assert.equal(registry.tools[0].inputSchema.properties.offset, undefined);
  assert.equal(registry.tools[0].inputSchema.properties.lineCount.default, 80);
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
  const first = await viewer.read({ artifactId: 'why', lineCount: 1 });
  assert.equal(first.content, '# Why\n');
  assert.equal(first.nextStartLine, 2);
  assert.equal(first.truncated, true);
  assert.equal((await viewer.read({ artifactId: 'why', startLine: 2, lineCount: 1 })).content, 'Pick two tasks.\n');
  for (const path of ['../private.md', '/etc/passwd', 'escape', 'other-artifact', 'nested/../../private.md', '..\\private.md']) {
    await assert.rejects(viewer.read({ artifactId: 'tests', path }));
  }
  await assert.rejects(viewer.read({ artifactId: 'private' }));
  await assert.rejects(viewer.read({ artifactId: 'why', path: 'private.md' }));
  await assert.rejects(viewer.read({ artifactId: 'why', lineCount: 501 }));
  await assert.rejects(viewer.read({ artifactId: 'why', startLine: -1 }));
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
  data.auditPath = join(data.dir, 'audit.jsonl');
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
  const toolList = (await call('tools/list')).result.tools;
  assert.equal(toolList.length, 3);
  assert.match(toolList.find(tool => tool.name === 'read_tests').description, /^tests의 소스 텍스트를 읽는다\./);
  assert.deepEqual(toolList.find(tool => tool.name === 'read_tests').inputSchema.required, ['path']);
  assert.match((await call('tools/call', { name: 'read_why', arguments: {} })).result.content[0].text, /Pick two/);
  assert.equal((await call('tools/call', { name: 'read_tests', arguments: { path: '../private.md' } })).result.isError, true);
  for (const arguments_ of [{}, { path: '' }, { path: null }, { path: 'rank.test.mjs', limit: 30 }]) {
    assert.equal((await call('tools/call', { name: 'read_tests', arguments: arguments_ })).result.isError, true);
  }
  assert.equal((await call('tools/call', { name: 'read_why', arguments: null })).result.isError, true);
  assert.equal((await call('tools/call', { name: 'list_tests', arguments: {} })).result.isError, false);
  assert.equal((await call('tools/call', { name: 'read_why', arguments: { startLine: 99 } })).result.isError, false);
  const audit = (await readFile(data.auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(audit.length, 3, 'Rejected calls must never be recorded as successful observations');
  assert.deepEqual(audit[0].observation, { artifactId: 'why', operation: 'read', startLine: 1, endLine: 2, lineCount: 2, totalLines: 2 });
  assert.deepEqual(audit[1].observation, { artifactId: 'tests', operation: 'list' });
  assert.deepEqual(audit[2].observation, { artifactId: 'why', operation: 'read', startLine: 99, endLine: null, lineCount: 0, totalLines: 2 });
  assert.equal(JSON.stringify(audit).includes('Pick two'), false, 'Audit must not contain Artifact content');
  assert.equal((await call('does-not-exist')).error.code, -32601);
  child.stdin.end();
});

test('line reads preserve UTF-8, CRLF, empty lines and final newline semantics', async t => {
  const data = await fixture(t);
  const content = '한글🙂 첫째\r\n\r\n끝줄🌱';
  await writeFile(join(data.worktreePath, 'why.md'), content);
  const viewer = await createArtifactViewer(data);
  const first = await viewer.read({ artifactId: 'why', startLine: 1, lineCount: 2 });
  assert.equal(first.content, '한글🙂 첫째\r\n\r\n');
  assert.equal(first.startLine, 1);
  assert.equal(first.endLine, 2);
  assert.equal(first.lineCount, 2);
  assert.equal(first.nextStartLine, 3);
  assert.equal(first.totalLines, undefined);
  const last = await viewer.read({ artifactId: 'why', startLine: first.nextStartLine, lineCount: 2 });
  assert.equal(last.content, '끝줄🌱');
  assert.equal(last.totalLines, 3);
  assert.equal(last.endLine, 3);
  assert.equal(last.lineCount, 1);
  assert.equal(last.nextStartLine, null);
  assert.equal(last.truncated, false);
  assert.equal(first.content + last.content, content);
  await writeFile(join(data.worktreePath, 'why.md'), '끝\n');
  const terminated = await viewer.read({ artifactId: 'why' });
  assert.equal(terminated.totalLines, 1);
  assert.equal(terminated.lineCount, 1);
  assert.equal(terminated.content, '끝\n');
});

test('empty files and reads past EOF return unambiguous line metadata', async t => {
  const data = await fixture(t);
  const viewer = await createArtifactViewer(data);
  const beyond = await viewer.read({ artifactId: 'why', startLine: 3 });
  assert.deepEqual({ content: beyond.content, startLine: beyond.startLine, endLine: beyond.endLine, lineCount: beyond.lineCount, totalLines: beyond.totalLines, nextStartLine: beyond.nextStartLine, truncated: beyond.truncated }, { content: '', startLine: 3, endLine: null, lineCount: 0, totalLines: 2, nextStartLine: null, truncated: false });
  await writeFile(join(data.worktreePath, 'why.md'), '');
  const empty = await viewer.read({ artifactId: 'why' });
  assert.equal(empty.lineCount, 0);
  assert.equal(empty.totalLines, 0);
  assert.equal(empty.endLine, null);
  assert.equal(empty.content, '');
  assert.equal(empty.nextStartLine, null);
  await writeFile(join(data.worktreePath, 'why.md'), '\n\n');
  assert.equal((await viewer.read({ artifactId: 'why' })).totalLines, 2);
});

test('line reads default to 80 lines and support the declared 500-line maximum', async t => {
  const data = await fixture(t);
  await writeFile(join(data.worktreePath, 'why.md'), Array.from({ length: 510 }, (_, index) => `줄 ${index + 1}\n`).join(''));
  const registry = createArtifactTools(await createArtifactViewer(data));
  const defaults = await registry.call('read_why', {});
  assert.equal(defaults.lineCount, 80);
  assert.equal(defaults.endLine, 80);
  assert.equal(defaults.nextStartLine, 81);
  const maximum = await registry.call('read_why', { startLine: 11, lineCount: 500 });
  assert.equal(maximum.lineCount, 500);
  assert.equal(maximum.endLine, 510);
  assert.equal(maximum.totalLines, 510);
  assert.equal(maximum.nextStartLine, null);
});

test('bounded line responses continue at complete lines without splitting UTF-8 characters', async t => {
  const data = await fixture(t);
  const line = `${'한'.repeat(10_000)}🙂\r\n`;
  await writeFile(join(data.worktreePath, 'why.md'), line.repeat(3));
  const viewer = await createArtifactViewer(data);
  const first = await viewer.read({ artifactId: 'why', lineCount: 80 });
  assert.equal(first.content, line.repeat(2));
  assert.equal(first.lineCount, 2);
  assert.equal(first.nextStartLine, 3);
  assert.ok(Buffer.byteLength(first.content) <= 65_536);
  const next = await viewer.read({ artifactId: 'why', startLine: first.nextStartLine });
  assert.equal(next.content, line);
  assert.equal(next.totalLines, 3);
  // The Korean character below crosses the reader's internal chunk boundary.
  await writeFile(join(data.worktreePath, 'why.md'), `${'x'.repeat(65_533)}\n한글🙂\r\n`);
  assert.equal((await viewer.read({ artifactId: 'why', startLine: 2 })).content, '한글🙂\r\n');
});

test('oversized lines fail explicitly and earlier unrequested lines are streamed without retention', async t => {
  const data = await fixture(t);
  await writeFile(join(data.worktreePath, 'why.md'), `${'x'.repeat(1_000_000)}\n작은 줄\n`);
  const viewer = await createArtifactViewer(data);
  await assert.rejects(viewer.read({ artifactId: 'why' }), /line 1 exceeds the 65536-byte read limit/);
  const second = await viewer.read({ artifactId: 'why', startLine: 2 });
  assert.equal(second.content, '작은 줄\n');
  assert.equal(second.totalLines, 2);
  await writeFile(join(data.worktreePath, 'why.md'), `${'a'.repeat(65_535)}\nnext`);
  const exact = await viewer.read({ artifactId: 'why' });
  assert.equal(Buffer.byteLength(exact.content), 65_536);
  assert.equal(exact.nextStartLine, 2);
});

test('operation arguments are validated at runtime and source files expose only read', async t => {
  const data = await fixture(t);
  const viewer = await createArtifactViewer(data);
  const registry = createArtifactTools(viewer);
  for (const args of [null, [], 'read', { tool: 'read' }, { path: '' }, { offset: 0 }, { limit: 10 }, { startLine: 0 }, { startLine: 1.5 }, { startLine: '1' }, { startLine: Number.MAX_SAFE_INTEGER + 1 }, { lineCount: 0 }, { lineCount: 501 }, { lineCount: null }]) {
    await assert.rejects(registry.call('read_why', args));
  }
  for (const args of [{}, { path: '' }, { path: null }, { path: 1 }, { path: '.' }, { path: 'rank.test.mjs', lineCount: -1 }]) {
    await assert.rejects(registry.call('read_tests', args));
  }
  await assert.rejects(viewer.read({ artifactId: 'why', path: '' }));
  await assert.rejects(viewer.read({ artifactId: 'why', offset: 0 }));
  await assert.rejects(viewer.list({ artifactId: 'tests', startLine: 1 }));
  await assert.rejects(readArtifact({ ...data, artifactId: 'why', offset: 0 }));
  await assert.rejects(readArtifact({ ...data, artifactId: 'why', file: 'why.md' }));
  await assert.rejects(readArtifact({ ...data, artifactId: 'why', file: 0 }));
  await assert.rejects(readArtifact({ ...data, artifactId: 'tests', lineCount: 1 }));
  const source = createArtifactTools(await createArtifactViewer({ ...data, artifacts: [{ id: 'source', type: 'code', path: 'tests/rank.test.mjs' }] }));
  assert.deepEqual(source.tools.map(tool => tool.name), ['read_source']);
  assert.equal(source.tools[0].inputSchema.properties.path, undefined);
  assert.match((await source.call('read_source', {})).content, /expected/);
});

test('directory listing retains bounded entry pagination', async t => {
  const data = await fixture(t);
  await writeFile(join(data.worktreePath, 'tests', 'a.test.mjs'), 'a');
  await writeFile(join(data.worktreePath, 'tests', 'b.test.mjs'), 'b');
  const registry = createArtifactTools(await createArtifactViewer(data));
  const first = await registry.call('list_tests', { limit: 1 });
  assert.equal(first.entries[0].name, 'a.test.mjs');
  assert.equal(first.totalEntries, 3);
  assert.equal(first.nextOffset, 1);
  const second = await registry.call('list_tests', { offset: first.nextOffset, limit: 2 });
  assert.deepEqual(second.entries.map(entry => entry.name), ['b.test.mjs', 'rank.test.mjs']);
  assert.equal(second.nextOffset, null);
});

test('direct viewer callers cannot bypass type validation or read internal symlink targets', async t => {
  const data = await fixture(t);
  for (const type of [{ viewer: 'text', tools: { list: { description: 'list' } } }, { viewer: 'text', tools: { read: { description: '{unknown}' } } }, { viewer: 'text', tools: { read: { description: '' } } }]) {
    await assert.rejects(createArtifactViewer({ ...data, artifactTypes: { ...data.artifactTypes, markdown: type } }));
  }
  await symlink('rank.test.mjs', join(data.worktreePath, 'tests', 'alias.mjs'));
  const viewer = await createArtifactViewer(data);
  await assert.rejects(viewer.read({ artifactId: 'tests', path: 'alias.mjs' }), /symlink/);
  await symlink('why.md', join(data.worktreePath, 'alias.md'));
  await assert.rejects(createArtifactViewer({ ...data, artifacts: [{ id: 'alias', type: 'markdown', path: 'alias.md' }] }), /symlink/);
  await assert.rejects(createArtifactViewer({ ...data, artifacts: [{ id: 'dir', type: 'markdown', path: 'tests' }] }), /text viewer requires a regular file/);
  await writeFile(join(data.worktreePath, 'why.md'), 'binary\0content');
  await assert.rejects(viewer.read({ artifactId: 'why' }), /Binary artifacts/);
});

test('requested invalid UTF-8 is rejected while a valid UTF-8 BOM is preserved', async t => {
  const data = await fixture(t);
  const viewer = await createArtifactViewer(data);
  await writeFile(join(data.worktreePath, 'why.md'), Buffer.from([0x76, 0x61, 0x6c, 0x69, 0x64, 0x0a, 0xc3, 0x28, 0x0a]));
  assert.equal((await viewer.read({ artifactId: 'why', lineCount: 1 })).content, 'valid\n');
  await assert.rejects(viewer.read({ artifactId: 'why', startLine: 2 }), /invalid UTF-8/);
  await writeFile(join(data.worktreePath, 'why.md'), '\uFEFF한글\n');
  assert.equal((await viewer.read({ artifactId: 'why' })).content, '\uFEFF한글\n');
});

test('direct directory viewers reject FIFO reads without waiting for a writer', { skip: process.platform === 'win32' }, async t => {
  const data = await fixture(t);
  execFileSync('mkfifo', [join(data.worktreePath, 'tests', 'pipe')]);
  const viewer = await createArtifactViewer(data);
  await assert.rejects(viewer.read({ artifactId: 'tests', path: 'pipe' }), /requires a regular file/);
});
