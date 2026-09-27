import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executionScope } from '../src/execution-scope.js';
import { runEnvironmentScript } from '../src/tools/environment.js';
import { runProcess } from '../src/executors/process.js';

for (const owner of ['identity', 'executor']) test(`${owner} child registration failure cannot start user work or settle before launch host cleanup`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-child-fault-')); t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'started'); let pid = 0;
  const scope = { runtimeRoot: root, declaredPaths: [], trackChild(child: number): () => void { pid = child; throw new Error('database is locked'); } };
  const args = ['--eval', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`];
  await executionScope.run(scope, async () => {
    if (owner === 'identity') {
      const result = await runEnvironmentScript({ command: process.execPath, args, cwd: root, outputDir: root, tmpDir: root, timeoutMs: 200 });
      assert.equal(result.ok, false); assert.match(result.message, /registration failed: database is locked/);
    } else await assert.rejects(runProcess(process.execPath, args, { cwd: root, timeoutMs: 200 }), /registration failed: database is locked/);
  });
  assert.ok(pid > 0); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

for (const owner of ['identity', 'executor']) test(`${owner} cancellation during child registration never sends launch admission`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-child-cancel-')); t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController(), marker = join(root, 'started'); let pid = 0;
  await executionScope.run({ runtimeRoot: root, declaredPaths: [], trackChild(child) { pid = child; controller.abort(new Error('cancel at registration')); return () => {}; } }, async () => {
    const args = ['--eval', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`];
    if (owner === 'identity') assert.equal((await runEnvironmentScript({ command: process.execPath, args, cwd: root, outputDir: root, tmpDir: root, signal: controller.signal })).ok, false);
    else await assert.rejects(runProcess(process.execPath, args, { cwd: root, signal: controller.signal }), /aborted/);
  });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
