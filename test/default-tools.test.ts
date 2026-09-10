import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { agent, human } from '@ccdd/default-tools';
import type { JsonValue, ToolContext, ToolResult } from '../src/sdk.js';

async function fixture(t: TestContext, contents = '\uccab\uc9f8\r\nsecond\nthird', directory = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-default-tools-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactPath = join(root, directory ? 'snapshot-files' : 'snapshot.txt');
  if (directory) await mkdir(artifactPath); else await writeFile(artifactPath, contents);
  const outputDir = join(root, 'output');
  const tmpDir = join(root, 'temporary');
  await mkdir(outputDir);
  await mkdir(tmpDir);
  const abort = new AbortController();
  const context: ToolContext = {
    artifactId: 'spec', artifactPath, artifactDirectory: directory, outputDir, tmpDir, signal: abort.signal,
    async resolvePath(path = '') {
      if (!directory && path) throw new Error('A file artifact has no child paths');
      const candidate = join(artifactPath, path);
      const sub = relative(artifactPath, candidate);
      if (isAbsolute(path) || path.includes('\\') || path.split('/').includes('..') || sub === '..' || sub.startsWith(`..${sep}`)) throw new Error('Requested path escapes the artifact');
      await access(candidate);
      return candidate;
    },
  };
  return { root, artifactPath, context, abort };
}

function json(result: ToolResult): Record<string, JsonValue> {
  const first = result.content[0];
  assert.equal(first.type, 'json');
  assert.ok(first.type === 'json' && first.data && typeof first.data === 'object' && !Array.isArray(first.data));
  return first.data;
}

test('default factories return independent metadata and preparation never launches a desktop program', async t => {
  const data = await fixture(t);
  const receipt = join(data.root, 'launched');
  const script = join(data.root, 'launcher.mjs');
  await writeFile(script, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(receipt)}, 'launched');`);
  const tool = human.desktop.open({ command: process.execPath, args: [script, '{artifactPath}'] });
  assert.equal(tool.metadata.observation, 'none');
  assert.deepEqual(tool.metadata.resultKinds, ['launch']);
  assert.equal((await tool.preflight!(data.context)).ok, true);
  await assert.rejects(access(receipt), { code: 'ENOENT' });
  const first = agent.text.read();
  const second = agent.text.read();
  first.metadata.description = 'changed';
  assert.notEqual(first.metadata.description, second.metadata.description);
  assert.deepEqual(Object.keys(agent), ['text', 'files', 'image']);
  assert.deepEqual(Object.keys(human), ['desktop', 'project']);
  assert.equal((await human.desktop.open({ command: '/missing-ccdd-viewer' }).preflight!(data.context)).ok, false);
});

test('Agent file reads execute the packaged CLI and preserve UTF-8, CRLF, BOM and complete-line pagination', async t => {
  const data = await fixture(t, '\ufeff\uccab\uc9f8\r\nsecond\nthird');
  const tool = agent.text.read();
  const first = await tool.execute(data.context, { lineCount: 1 });
  assert.deepEqual(json(first), { artifactId: 'spec', path: '', content: '\ufeff\uccab\uc9f8\r\n', startLine: 1, endLine: 1, lineCount: 1, truncated: true, nextStartLine: 2 });
  assert.equal(first.observation?.kind, 'content');
  assert.deepEqual(json(await tool.execute(data.context, { startLine: 2, lineCount: 2 })), {
    artifactId: 'spec', path: '', content: 'second\nthird', startLine: 2, endLine: 3, lineCount: 2, totalLines: 3, truncated: false, nextStartLine: null,
  });
  assert.equal((await tool.preflight!(data.context)).ok, true);
  await assert.rejects(tool.execute(data.context, { lineCount: 501 }), /Invalid lineCount/);
  await assert.rejects(tool.execute(data.context, { startLine: -1 }), /Invalid startLine/);
  await assert.rejects(tool.execute(data.context, { path: 'other' } as never), /Invalid artifact tool arguments/);
});

test('the package-local Agent CLI does not inherit Node startup injection from the host environment', async t => {
  const data = await fixture(t);
  const preload = join(data.root, 'preload.cjs');
  const receipt = join(data.root, 'injected');
  await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(receipt)},'injected');`);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${preload}`;
  t.after(() => { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; });
  assert.equal(json(await agent.text.read().execute(data.context, { lineCount: 1 })).content, '\uccab\uc9f8\r\n');
  await assert.rejects(access(receipt), { code: 'ENOENT' });
});

test('reads keep the 64 KiB limit and distinguish a truly empty file from a request past EOF', async t => {
  const data = await fixture(t, `${'x'.repeat(64 * 1024 - 1)}\nnext\n`);
  const tool = agent.text.read();
  const first = json(await tool.execute(data.context, {}));
  assert.equal(Buffer.byteLength(first.content as string), 64 * 1024);
  assert.equal(first.nextStartLine, 2);
  const past = await tool.execute(data.context, { startLine: 99 });
  assert.equal(json(past).totalLines, 2);
  assert.equal(past.observation, undefined);
  await writeFile(data.artifactPath, '');
  const empty = await tool.execute(data.context, {});
  assert.equal(json(empty).totalLines, 0);
  assert.equal(empty.observation?.kind, 'empty');
  await writeFile(data.artifactPath, 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(tool.execute(data.context, {}), /exceeds the 65536-byte read limit/);
  await writeFile(data.artifactPath, Buffer.from([0xff, 0x0a, 0x61, 0x0a]));
  await assert.rejects(tool.execute(data.context, {}), /invalid UTF-8/);
  assert.equal(json(await tool.execute(data.context, { startLine: 2 })).content, 'a\n');
  await writeFile(data.artifactPath, Buffer.from([0x61, 0x00, 0x0a]));
  await assert.rejects(tool.execute(data.context, {}), /Binary artifacts/);
});

test('directory tools paginate real entries and reject traversal, wrong shapes and symlinks inside the CLI', async t => {
  const data = await fixture(t, '', true);
  await mkdir(join(data.artifactPath, 'nested'));
  await writeFile(join(data.artifactPath, 'a.ts'), 'a\n');
  await writeFile(join(data.artifactPath, 'b.ts'), 'b\n');
  await writeFile(join(data.artifactPath, 'nested', 'c.ts'), 'c\n');
  await symlink('a.ts', join(data.artifactPath, 'linked.ts'));
  const listing = await agent.files.list().execute(data.context, { limit: 1 });
  assert.equal(listing.observation, undefined);
  assert.deepEqual(json(listing).entries, [{ name: 'a.ts', path: 'a.ts', kind: 'file' }]);
  assert.equal(json(listing).totalEntries, 4);
  assert.equal(json(listing).nextOffset, 1);
  assert.equal(json(await agent.files.read().execute(data.context, { path: 'nested/c.ts' })).content, 'c\n');
  await assert.rejects(agent.files.read().execute(data.context, { path: 'linked.ts' }), /symlink/);
  await assert.rejects(agent.files.read().execute(data.context, { path: '../output' }), /safe internal/);
  await assert.rejects(agent.files.read().execute(data.context, { path: '' }), /requires an internal file path/);
  await assert.rejects(agent.text.read().execute(data.context, {}), /file Artifact/);
  assert.equal((await agent.text.read().preflight!(data.context)).ok, false);
});

test('Human desktop tools pass a scoped snapshot path as argv, omit credentials and return only a launch receipt', async t => {
  const data = await fixture(t, 'secret text that must not become a tool result');
  const script = join(data.root, 'desktop.mjs');
  const receipt = join(data.root, 'receipt.json');
  await writeFile(script, `import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify({args:process.argv.slice(3), cwd:process.cwd(), secret:process.env.CCDD_DEFAULT_TOOL_SECRET, nodeOptions:process.env.NODE_OPTIONS}));`);
  const previous = process.env.CCDD_DEFAULT_TOOL_SECRET;
  process.env.CCDD_DEFAULT_TOOL_SECRET = 'must-not-reach-launcher';
  t.after(() => { if (previous === undefined) delete process.env.CCDD_DEFAULT_TOOL_SECRET; else process.env.CCDD_DEFAULT_TOOL_SECRET = previous; });
  const args = [script, receipt, '{artifactPath}'];
  const tool = human.desktop.open({ command: process.execPath, args });
  args[2] = 'mutated after factory';
  assert.deepEqual(await tool.execute(data.context, {}), { content: [{ type: 'launch', launched: true }] });
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), { args: [data.artifactPath], cwd: data.context.outputDir });
  await assert.rejects(tool.execute(data.context, { path: '' }), /does not accept path/);
  await assert.rejects(tool.execute(data.context, { command: '/bin/sh' } as never), /Invalid artifact tool arguments/);
  assert.throws(() => human.desktop.open({ command: process.execPath, args: ['unscoped'] }), /standalone/);
  assert.throws(() => human.desktop.open({ app: 'TextEdit', command: process.execPath }), /cannot be combined/);
});

test('tool cancellation removes descendant processes and timeouts stop a stalled launcher', { skip: process.platform === 'win32' }, async t => {
  const data = await fixture(t);
  const script = join(data.root, 'launcher.mjs');
  const pidFile = join(data.root, 'child.pid');
  await writeFile(script, `import {spawn} from 'node:child_process';
const code = ${JSON.stringify(`import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},100);`)};
spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'}); setInterval(()=>{},100);`);
  const running = human.desktop.open({ command: process.execPath, args: [script, '{artifactPath}'] }).execute(data.context, {});
  const rejected = assert.rejects(running, /aborted/);
  let pid = 0;
  for (let attempt = 0; attempt < 300 && !pid; attempt++) {
    try { pid = Number(await readFile(pidFile, 'utf8')); } catch { await delay(10); }
  }
  assert.ok(pid, 'The real launcher started its descendant before cancellation.');
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  data.abort.abort();
  await rejected;
  let alive = true;
  for (let attempt = 0; attempt < 100 && alive; attempt++) {
    try { process.kill(pid, 0); await delay(10); } catch { alive = false; }
  }
  assert.equal(alive, false, 'The descendant that ignored SIGTERM was removed.');
  const clean = { ...data.context, signal: new AbortController().signal };
  await assert.rejects(human.desktop.open({ command: process.execPath, args: ['-e', 'setInterval(()=>{},100)', '{artifactPath}'], timeoutMs: 30 }).execute(clean, {}), /timed out/);
  const before = { ...data.context, signal: AbortSignal.abort() };
  await assert.rejects(agent.text.read().execute(before, {}), /abort/i);
});
