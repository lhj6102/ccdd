import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { artifactFixture, fixtureViews, runtimeCritic } from './helpers/artifacts.js';
import { createBroker } from '../src/broker/index.js';
import { projectRun } from '../src/project/store.js';
import { main } from '../src/project/cli.js';

const cli = fileURLToPath(new URL('../src/project/cli.js', import.meta.url));
async function separate(args: string[]) {
  try { const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env, NODE_TEST_CONTEXT: '' }, timeout: 20000 }); return { code: 0, data: JSON.parse(stdout) }; }
  catch (error: any) { if (typeof error.stdout !== 'string' || !error.stdout.trim()) throw error; return { code: error.code, data: JSON.parse(error.stdout) }; }
}
async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 500; i++) { const value = await read(); if (ready(value)) return value; await delay(20); }
  throw new Error('Detached worker did not settle.');
}
async function fixture(t: Parameters<typeof artifactFixture>[0], { human = false, slow = 0, red = false } = {}) {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [human ? { id: 'review', title: 'Human review', profile: { kind: 'human' }, payload: { instruction: 'Read {a}.' } } : runtimeCritic()] }, {
    'check.test.mjs': `import test from 'node:test';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';import {writeFile} from 'node:fs/promises';test('actual runtime',async()=>{await delay(${slow});await writeFile(process.env.CCDD_OUTPUT_DIR+'/result.txt','actual output');assert.equal(${red ? 1 : 0},0);});`,
  });
  const args = ['--repo', data.repoPath, '--state-dir', data.stateDir, '--json'];
  data.cleanup(async () => {
    if (!(await readFile(join(data.stateDir, 'broker.sqlite')).catch(() => null))) return;
    const broker = createBroker({ detail: 'full', ...data, repoId: 'local' });
    try { for (const run of broker.listRuns()) if (!['GREEN', 'RED', 'ERROR', 'INCOMPLETE'].includes(run.status)) broker.cancel(run.id); await until(() => broker.listRuns(), runs => runs.every(run => !run.owner)); } finally { await broker.close(); }
  });
  return { ...data, args };
}

test('installed-style bin symlink opens current Project help without a daemon', async t => {
  const data = await artifactFixture(t), bin = join(data.root, 'ccdd-project'); await symlink(cli, bin);
  const { stdout } = await promisify(execFile)(process.execPath, [bin, 'help']); assert.match(stdout, /CCDD Project/); assert.match(stdout, /--recursive/);
});

test('removed workspace modes, remote actions and global run syntax fail explicitly', async () => {
  for (const args of [['verify', '--all', '--copy'], ['verify', '--all', '--lock'], ['remote-review'], ['run'], ['artifact', 'id', 'a']]) {
    let output = ''; assert.equal(await main([...args, '--json'], { stdout: { write: text => { output += text; } }, stderr: { write() {} } }), 2); assert.ok(JSON.parse(output).error);
  }
});

test('real detached Runtime verification returns GREEN and RED without Git or a server', async t => {
  for (const red of [false, true]) {
    const data = await fixture(t, { red }), result = await separate(['verify', '--all', '--wait', ...data.args]);
    assert.equal(result.code, red ? 1 : 0, JSON.stringify(result.data)); assert.equal(result.data.status, red ? 'RED' : 'GREEN');
    assert.equal(result.data.requests[0].criticId, 'a/check'); assert.match(result.data.requests[0].inputKey, /^[a-f0-9]{64}$/); assert.equal(result.data.requests[0].validationInput, undefined);
  }
});

test('detached worker continues after submission exits and a later verification reuses actual results', async t => {
  const data = await fixture(t, { slow: 350 }), submitted = await separate(['verify', '--all', ...data.args]);
  assert.equal(submitted.code, 0); const id = submitted.data.id;
  const completed = await separate(['run', 'show', id, '--wait', ...data.args]); assert.equal(completed.code, 0); assert.equal(completed.data.status, 'GREEN');
  const reused = await separate(['verify', '--all', '--wait', ...data.args]); assert.equal(reused.code, 0); assert.equal(reused.data.requests.length, 0);
});

test('single Critic selection persists its result while recursive verification fills missing cycle evidence', async t => {
  const data = await fixture(t); await data.edit('a', m => { m.mounts = { peer: 'b' }; }); await data.write('b', { name: 'b', mounts: { peer: 'a' }, critics: [runtimeCritic()] });
  const partial = await separate(['verify', '--critic', 'a/check', '--wait', ...data.args]); assert.equal(partial.code, 4); assert.equal(partial.data.requests[0].status, 'GREEN');
  const complete = await separate(['verify', 'a', '--recursive', '--wait', ...data.args]); assert.equal(complete.code, 0); assert.deepEqual(complete.data.requests.map((r: any) => r.criticId), ['b/check']);
});

test('workspace edits during a detached Runtime review invalidate the active result', async t => {
  const data = await fixture(t, { slow: 1500 }), submitted = await separate(['verify', '--all', ...data.args]);
  await writeFile(join(data.repoPath, 'a/content.txt'), 'changed');
  const result = await separate(['run', 'show', submitted.data.id, '--wait', ...data.args]); assert.equal(result.code, 2); assert.equal(result.data.status, 'ERROR'); assert.equal(result.data.requests[0].result, null);
});

test('client wait timeout preserves the handle and execution can be awaited later', async t => {
  const data = await fixture(t, { slow: 700 }), submitted = await separate(['verify', '--all', '--wait', '--timeout-ms', '1', ...data.args]);
  assert.equal(submitted.code, 3); assert.equal(submitted.data.wait.completed, false);
  assert.equal((await separate(['run', 'show', submitted.data.id, '--wait', ...data.args])).code, 0);
});

test('Human claim, tool execution and submission work across fresh CLI processes', async t => {
  const data = await fixture(t, { human: true }), submitted = await separate(['verify', '--all', '--human-inbox', ...data.args]);
  const run = await until(() => projectRun(data.stateDir, submitted.data.id)!, value => Boolean(value?.requests[0]?.notifiedAt)); const id = run.requests[0].id;
  const claimed = await separate(['request', 'claim', id, '--reviewer', 'fixture-reader', ...data.args]); assert.equal(claimed.code, 0, JSON.stringify(claimed.data));
  const result = await separate(['request', 'tool', id, '--reviewer', 'fixture-reader', '--tool', 'read_a', '--args', '{"lineCount":1}', ...data.args]); assert.equal(result.code, 0); assert.equal(result.data.observation.kind, 'content');
  const filename = join(data.root, 'result.json'); await writeFile(filename, JSON.stringify({ verdict: 'GREEN' }));
  assert.equal((await separate(['request', 'submit', id, '--reviewer', 'fixture-reader', '--result-file', filename, ...data.args])).code, 0);
  assert.equal((await separate(['run', 'show', run.id, '--wait', ...data.args])).data.status, 'GREEN');
});

test('cancel and live resume retain single worker ownership', async t => {
  const data = await fixture(t, { slow: 2000 }), submitted = await separate(['verify', '--all', '--full', ...data.args]);
  const resumed = await separate(['run', 'resume', submitted.data.id, '--full', ...data.args]); assert.equal(resumed.data.owner.pid, submitted.data.owner.pid);
  const cancelled = await separate(['run', 'cancel', submitted.data.id, ...data.args]); assert.equal(cancelled.data.status, 'ERROR');
});

test('stored results remain readable after the supplied workspace is deleted', async t => {
  const data = await fixture(t), completed = await separate(['verify', '--all', '--wait', ...data.args]); await rm(data.repoPath, { recursive: true });
  const result = await separate(['run', 'show', completed.data.id, '--state-dir', data.stateDir, '--json']); assert.equal(result.code, 0); assert.equal(result.data.status, 'GREEN');
});

test('verify concurrency reaches the actual detached worker and saved configuration', async t => {
  const data = await fixture(t), log = join(data.root, 'concurrency.log');
  await data.edit('a', manifest => { manifest.critics = Array.from({ length: 4 }, (_, i) => runtimeCritic(`c${i}`)); });
  await writeFile(join(data.repoPath, 'a/check.test.mjs'), `import {appendFileSync} from 'node:fs';
    appendFileSync(${JSON.stringify(log)}, 'start\\n');
    await new Promise(r=>setTimeout(r,200));
    appendFileSync(${JSON.stringify(log)}, 'end\\n');`);
  const result = await separate(['verify', '--all', '--wait', '--concurrency', '2', '--identity-concurrency', '1', ...data.args]);
  assert.equal(result.code, 0); assert.equal(result.data.status, 'GREEN');
  let active = 0, peak = 0;
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  for (const line of lines) { active += line === 'start' ? 1 : -1; peak = Math.max(peak, active); }
  assert.equal(lines.length, 8); assert.equal(peak, 2);
  const saved = JSON.parse(await readFile(join(data.stateDir, 'runs', result.data.id, 'worker.json'), 'utf8'));
  assert.equal(saved.maxConcurrentExecutors, 2);
  const { readWorkerConfiguration } = await import('../src/worker-client.js');
  assert.equal((await readWorkerConfiguration(data.stateDir, result.data.id)).maxConcurrentExecutors, 2);
  saved.maxConcurrentExecutors = 0;
  await writeFile(join(data.stateDir, 'runs', result.data.id, 'worker.json'), JSON.stringify(saved));
  await assert.rejects(readWorkerConfiguration(data.stateDir, result.data.id), /positive integer/);
});
