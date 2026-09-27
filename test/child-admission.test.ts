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

for (const admitted of [false, true]) test(`managed launch host parent death ${admitted ? 'after' : 'before'} admission terminates only its owned work`, async t => {
  if (process.platform !== 'linux') return t.skip('Linux group lifecycle proof');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { setTimeout: delay } = await import('node:timers/promises');
  const root = await mkdtemp(join(tmpdir(), 'ccdd-launch-death-')); t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'user-pid'), hostPath = fileURLToPath(new URL('../src/executors/launch-host.js', import.meta.url));
  const parent = spawn(process.execPath, ['--input-type=module', '--eval', `import {spawn} from 'node:child_process';const c=spawn(process.execPath,[${JSON.stringify(hostPath)},process.execPath,'-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`) }],{detached:true,stdio:['ignore','ignore','ignore','ipc']});console.log(c.pid);${admitted ? "c.send('admitted');" : ''}setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; parent.stdout.on('data', bytes => output += bytes); const exited = new Promise<void>(resolve => parent.once('exit', () => resolve()));
  const deadline = Date.now() + 5000; while (!output.trim() || admitted && !(await readFile(marker).catch(() => null))) { if (Date.now() > deadline) throw new Error('Launch fixture did not become ready.'); await delay(10); }
  const hostPid = Number(output.trim()), userPid = admitted ? Number(await readFile(marker, 'utf8')) : null;
  t.after(() => { parent.kill('SIGKILL'); try { process.kill(-hostPid, 'SIGKILL'); } catch {} });
  parent.kill('SIGKILL'); await exited;
  const running = async (pid: number) => { const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null); return stat !== null && !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z '); };
  while (await running(hostPid) || userPid && await running(userPid)) { if (Date.now() > deadline) throw new Error('Owned launch group survived parent death.'); await delay(10); }
  if (!admitted) await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('managed launch preserves argv, cwd, environment, stdout, stderr and actual exit status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-launch-contract-')); t.after(() => rm(root, { recursive: true, force: true }));
  const scope = { runtimeRoot: root, declaredPaths: [], trackChild() { return () => {}; } };
  const result = await executionScope.run(scope, () => runProcess(process.execPath, ['-e', "process.stdout.write(JSON.stringify({arg:process.argv[1],cwd:process.cwd(),value:process.env.TEST_VALUE}));process.stderr.write('stderr bytes');process.exit(7)", 'arg with spaces'], { cwd: root, env: { TEST_VALUE: 'controlled' } }));
  assert.deepEqual(JSON.parse(result.stdout), { arg: 'arg with spaces', cwd: root, value: 'controlled' }); assert.equal(result.stderr, 'stderr bytes'); assert.equal(result.exitCode, 7); assert.equal(result.exitSignal, null);
  const signaled = await executionScope.run(scope, () => runProcess(process.execPath, ['-e', "process.kill(process.pid,'SIGTERM')"], { cwd: root }));
  assert.equal(signaled.exitCode, null); assert.equal(signaled.exitSignal, 'SIGTERM');
});
