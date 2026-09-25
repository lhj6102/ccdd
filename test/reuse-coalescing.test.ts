import test from 'node:test';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from '../src/broker/index.js';
import { inspectProject, projectRun } from '../src/project/index.js';
import { artifactFixture, runtimeCritic } from './helpers/artifacts.js';

for (const verdict of ['GREEN', 'RED'] as const) test(`matching ${verdict} is reused, force retries, and identical active requests coalesce`, async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const executors = { canExecute: () => ({ ok: true as const }), execute: async () => { calls++; await gate; return { verdict }; } };
  const owner = createBroker({ ...data, executors }), follower = createBroker({ ...data, executors });
  data.cleanup(() => owner.close()); data.cleanup(() => follower.close());
  const first = await owner.submitProject({ selection: { kind: 'all' } }); const running = owner.run(first.id);
  const second = await follower.submitProject({ selection: { kind: 'all' } });
  assert.equal(second.requests.length, 0); assert.equal(second.status, 'RUNNING');
  const waiting = follower.run(second.id);
  await delay(50); assert.equal(calls, 1); release();
  assert.equal((await running)!.status, verdict); const adopted = (await waiting)!; assert.equal(adopted.status, verdict);
  assert.equal(adopted.results.length, 1); assert.equal(adopted.results[0].reusedFrom!.runId, first.id);
  assert.equal(projectRun(data.stateDir, second.id)!.project!.coalescedRequestIds![0], first.requests[0].id);
  const reused = await follower.submitProject({ selection: { kind: 'all' } });
  assert.equal(reused.status, verdict); assert.equal(reused.requests.length, 0); assert.equal(calls, 1);
  const plan = (await inspectProject(data)).plan;
  assert.equal(plan.items[0].action, 'REUSE'); assert.equal(plan.satisfied, verdict === 'GREEN');
  const forced = await follower.submitProject({ selection: { kind: 'all' }, force: true });
  assert.equal(forced.requests.length, 1); await follower.run(forced.id); assert.equal(calls, 2);
  assert.equal(projectRun(data.stateDir, first.id)!.requests[0].result!.verdict, verdict);
});

test('cancelling a follower does not cancel the shared evaluation; force does not coalesce', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async () => { await gate; return { verdict: 'GREEN' }; } } }); data.cleanup(() => broker.close());
  const first = await broker.submitProject({ selection: { kind: 'all' } }), running = broker.run(first.id);
  const follower = await broker.submitProject({ selection: { kind: 'all' } }); broker.cancel(follower.id);
  const forced = await broker.submitProject({ selection: { kind: 'all' }, force: true });
  assert.equal(forced.requests.length, 1); assert.equal(broker.getRun(first.id)!.status, 'RUNNING');
  release(); assert.equal((await running)!.status, 'GREEN'); await broker.run(forced.id);
});

test('source cancellation becomes a follower failure without fabricating a verdict', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } }); data.cleanup(() => broker.close());
  const source = await broker.submitProject({ selection: { kind: 'all' } });
  const follower = await broker.submitProject({ selection: { kind: 'all' } }); broker.cancel(source.id);
  assert.equal((await broker.run(follower.id))!.status, 'ERROR');
  assert.deepEqual(broker.getRun(follower.id)!.results, []);
});

// Separate processes share only SQLite; each candidate uses the real atomic Run
// owner claim and reconciliation code, not a mock lock or a same-process mutex.
async function worker(t: Parameters<typeof artifactFixture>[0], data: { repoPath: string; stateDir: string }, runId: string, mode: 'finish' | 'hang', callsFile: string) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createBroker } from ${JSON.stringify(new URL('../src/broker/index.js', import.meta.url).href)};
    import { appendFileSync } from 'node:fs';
    const broker = createBroker({ ...${JSON.stringify(data)}, executors: {
      canExecute: () => ({ok:true}), execute: async () => {
        appendFileSync(${JSON.stringify(callsFile)}, 'executed\\n');
        ${mode === 'hang' ? "process.send('executing'); await new Promise(() => {});" : ''}
        return {verdict:'GREEN'};
      }
    }});
    process.send('ready');
    process.once('message', async () => {
      try { const result = await broker.run(${JSON.stringify(runId)}); await broker.close(); process.send(result.status); process.disconnect(); }
      catch (error) { console.error(error); process.exit(1); }
    });
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  let errors = ''; child.stderr!.on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit');
  assert.equal((await once(child, 'message'))[0], 'ready');
  return { child, exited, errors: () => errors, message: async () => (await once(child, 'message'))[0] };
}

test('a dead source owner is reconciled and its follower settles without replaying partial execution', { timeout: 15000 }, async t => {
  const { join } = await import('node:path'); const { readFile } = await import('node:fs/promises');
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  let retried = 0;
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async () => { retried++; return { verdict: 'GREEN' }; } } }); data.cleanup(() => broker.close());
  const source = await broker.submitProject({ selection: { kind: 'all' } }), callsFile = join(data.root, 'calls');
  const sourceWorker = await worker(t, { repoPath: data.repoPath, stateDir: data.stateDir }, source.id, 'hang', callsFile);
  t.after(() => sourceWorker.child.kill('SIGKILL'));
  const executing = sourceWorker.message(); sourceWorker.child.send('go'); assert.equal(await executing, 'executing');
  const follower = await broker.submitProject({ selection: { kind: 'all' } }), waiting = broker.run(follower.id);
  sourceWorker.child.kill('SIGKILL'); await sourceWorker.exited;
  assert.equal((await waiting)!.status, 'ERROR');
  const stored = projectRun(data.stateDir, source.id)!;
  assert.equal(stored.requests[0].errorCode, 'WORKER_EXITED'); assert.equal(stored.requests[0].result, null);
  assert.equal(retried, 0); assert.equal(await readFile(callsFile, 'utf8'), 'executed\n');
});


// Launch the production worker entry point, including its finally/broker.close().
async function actualWorker(t: Parameters<typeof artifactFixture>[0], data: { repoPath: string; stateDir: string }, runId: string) {
  const { fork } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const child = fork(fileURLToPath(new URL('../src/worker.js', import.meta.url)), [JSON.stringify({ ...data, repoId: 'demo', runId, humanInbox: false })], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
  });
  t.after(() => child.kill('SIGKILL'));
  let errors = ''; child.stderr!.on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit');
  const [ready] = await once(child, 'message'); assert.equal(ready.type, 'ready', JSON.stringify(ready));
  return { child, exited, errors: () => errors };
}
async function runtimeFixture(t: Parameters<typeof artifactFixture>[0], hold = false) {
  const { join } = await import('node:path');
  const data = await artifactFixture(t), calls = join(data.root, 'calls');
  // Mutable execution barriers/counters stay outside the reviewed workspace.
  const script = (name: string, wait: boolean) => `import {appendFileSync,existsSync} from 'node:fs';
    appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(name + '\n')});
    ${wait ? `while (!existsSync(${JSON.stringify(join(data.root, 'release'))})) await new Promise(r=>setTimeout(r,20));` : ''}`;
  await data.write('a', { name: 'a', critics: [runtimeCritic()] }, { 'check.test.mjs': script('a', hold) });
  const broker = createBroker({ ...data, coalescingGraceMs: 1000, executors: { canExecute: () => ({ ok: true }), execute: async () => { throw new Error('Only actual workers execute'); } } });
  data.cleanup(() => broker.close());
  return { ...data, broker, calls, script };
}
async function waitForCall(calls: string, name: string) {
  const { readFile } = await import('node:fs/promises');
  for (let attempt = 0; attempt < 250; attempt++) {
    if ((await readFile(calls, 'utf8').catch(() => '')).split('\n').includes(name)) return;
    await delay(20);
  }
  assert.fail(`No ${name} execution observed`);
}

for (const scenario of ['future timestamp', 'invalid timestamp', 'missing timestamp', 'backward clock', 'zero grace', 'zero grace with backward clock', 'invalid grace', 'missing grace'] as const) {
  test(`unowned submission lease fails closed for ${scenario} without changing its source`, async t => {
    const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
    let calls = 0;
    const broker = createBroker({ ...data, coalescingGraceMs: scenario.startsWith('zero grace') ? 0 : 100,
      executors: { canExecute: () => ({ ok: true }), execute: async () => { calls++; return { verdict: 'GREEN' }; } } });
    data.cleanup(() => broker.close());
    const source = await broker.submitProject({ selection: { kind: 'all' } });
    const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite'));
    try {
      const record = JSON.parse(String(db.prepare('SELECT data FROM runs WHERE id=?').get(source.id)!.data));
      if (scenario === 'future timestamp') record.createdAt = new Date(Date.now() + 86_400_000).toISOString();
      if (scenario === 'invalid timestamp') record.createdAt = 'invalid';
      if (scenario === 'missing timestamp') delete record.createdAt;
      if (scenario === 'invalid grace') record.coalescingGraceMs = -1;
      if (scenario === 'missing grace') delete record.coalescingGraceMs;
      db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(record), source.id);
    } finally { db.close(); }
    const before = storedSource(data.stateDir, source.id);
    if (scenario.includes('backward clock')) {
      const rolledBack = Date.now() - 60_000;
      t.mock.method(Date, 'now', () => rolledBack);
    }
    const follower = await broker.submitProject({ selection: { kind: 'all' } });
    assert.equal(follower.requests.length, 1);
    assert.equal((await broker.run(follower.id))!.status, 'GREEN');
    assert.equal(calls, 1);
    assert.deepEqual(storedSource(data.stateDir, source.id), before);
  });
}

test('a waiting follower bounds its lease monotonically across a backward wall-clock adjustment', { timeout: 10000 }, async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  let calls = 0;
  const broker = createBroker({ ...data, detail: 'full', coalescingGraceMs: 2000,
    executors: { canExecute: () => ({ ok: true }), execute: async () => { calls++; return { verdict: 'GREEN' }; } } });
  data.cleanup(() => broker.close());
  const source = await broker.submitProject({ selection: { kind: 'all' } }), before = storedSource(data.stateDir, source.id);
  const createdAt = Date.parse(source.createdAt);
  let wallClock = createdAt + 1000;
  t.mock.method(Date, 'now', () => wallClock);
  const follower = await broker.submitProject({ selection: { kind: 'all' } });
  assert.equal(follower.requests.length, 0);
  const running = broker.run(follower.id);
  const timeout = setTimeout(() => broker.cancel(follower.id), 3000);
  try {
    await delay(100);
    assert.equal(calls, 0);
    // Still a valid positive wall-clock age: only the monotonic bound can expire it.
    wallClock = createdAt + 500;
    assert.equal((await running)!.status, 'GREEN');
    assert.equal(calls, 1);
    assert.deepEqual(storedSource(data.stateDir, source.id), before);
  } finally { clearTimeout(timeout); }
});

test('submission grace coalesces simultaneous submits into one ticket', async t => {
  const data = await runtimeFixture(t);
  const runs = await Promise.all([data.broker.submitProject({ selection: { kind: 'all' } }), data.broker.submitProject({ selection: { kind: 'all' } })]);
  assert.equal(runs.reduce((sum, run) => sum + run.requests.length, 0), 1);
});

test('actual follower worker expires an abandoned lease without changing its source; revived source executes its queued ticket', { timeout: 15000 }, async t => {
  const { readFile } = await import('node:fs/promises');
  const data = await runtimeFixture(t);
  await data.write('b', { name: 'b', critics: [runtimeCritic()] }, { 'check.test.mjs': data.script('b', false) });
  const source = await data.broker.submitProject({ selection: { kind: 'all' } });
  const before = storedSource(data.stateDir, source.id);
  const follower = await data.broker.submitProject({ selection: { kind: 'artifact', artifactId: 'a' } }); assert.equal(follower.requests.length, 0);
  const worker = await actualWorker(t, data, follower.id); assert.equal((await worker.exited)[0], 0, worker.errors());
  assert.equal(data.broker.getRun(follower.id)!.status, 'GREEN');
  assert.deepEqual(storedSource(data.stateDir, source.id), before);
  assert.equal(await readFile(data.calls, 'utf8'), 'a\n');
  const revived = await actualWorker(t, data, source.id); assert.equal((await revived.exited)[0], 0, revived.errors());
  assert.equal(data.broker.getRun(source.id)!.status, 'GREEN');
  assert.deepEqual((await readFile(data.calls, 'utf8')).trim().split('\n').sort(), ['a', 'a', 'b']);
});

for (const expired of [false, true]) test(`actual worker close after follower cancellation leaves abandoned source untouched (expired=${expired})`, { timeout: 15000 }, async t => {
  const data = await runtimeFixture(t, true);
  const source = await data.broker.submitProject({ selection: { kind: 'all' } }), before = storedSource(data.stateDir, source.id);
  const follower = await data.broker.submitProject({ selection: { kind: 'all' } });
  const worker = await actualWorker(t, data, follower.id);
  if (expired) await waitForCall(data.calls, 'a');
  data.broker.cancel(follower.id);
  assert.equal((await worker.exited)[0], 0, worker.errors());
  assert.equal(data.broker.getRun(follower.id)!.status, 'ERROR');
  assert.deepEqual(storedSource(data.stateDir, source.id), before);
});

test('actual A follower worker finishes and closes while source B keeps running', { timeout: 15000 }, async t => {
  const { join } = await import('node:path'); const { readFile, writeFile } = await import('node:fs/promises');
  const data = await runtimeFixture(t);
  await data.write('b', { name: 'b', critics: [runtimeCritic()] }, { 'check.test.mjs': data.script('b', true) });
  const source = await data.broker.submitProject({ selection: { kind: 'all' } });
  const follower = await data.broker.submitProject({ selection: { kind: 'artifact', artifactId: 'a' } });
  const sourceWorker = await actualWorker(t, data, source.id); await waitForCall(data.calls, 'b');
  const followerWorker = await actualWorker(t, data, follower.id);
  assert.equal((await followerWorker.exited)[0], 0, followerWorker.errors());
  assert.equal(data.broker.getRun(follower.id)!.status, 'GREEN');
  assert.equal(data.broker.getRun(source.id)!.status, 'RUNNING');
  assert.equal(projectRun(data.stateDir, source.id)!.requests.find(request => request.target === 'b')!.status, 'RUNNING');
  await writeFile(join(data.root, 'release'), 'go');
  assert.equal((await sourceWorker.exited)[0], 0, sourceWorker.errors());
  assert.equal(data.broker.getRun(source.id)!.status, 'GREEN');
  assert.deepEqual((await readFile(data.calls, 'utf8')).trim().split('\n').sort(), ['a', 'b']);
});

test('two actual follower workers race at lease expiry and execute one own ticket', { timeout: 15000 }, async t => {
  const { readFile } = await import('node:fs/promises');
  const data = await runtimeFixture(t);
  const source = await data.broker.submitProject({ selection: { kind: 'all' } }), before = storedSource(data.stateDir, source.id);
  const followers = await Promise.all([data.broker.submitProject({ selection: { kind: 'all' } }), data.broker.submitProject({ selection: { kind: 'all' } })]);
  assert.equal(followers.reduce((sum, run) => sum + run.requests.length, 0), 0);
  const workers = await Promise.all(followers.map(run => actualWorker(t, data, run.id)));
  for (const worker of workers) assert.equal((await worker.exited)[0], 0, worker.errors());
  assert.equal(await readFile(data.calls, 'utf8'), 'a\n');
  assert.deepEqual(storedSource(data.stateDir, source.id), before);
  assert.equal(followers.reduce((sum, run) => sum + data.broker.getRun(run.id)!.requests.length, 0), 1);
  for (const run of followers) assert.equal(data.broker.getRun(run.id)!.status, 'GREEN');
});


function storedSource(stateDir: string, runId: string) {
  const db = new DatabaseSync(join(stateDir, 'broker.sqlite'), { readOnly: true });
  try { return {
    run: db.prepare('SELECT data FROM runs WHERE id=?').get(runId)!.data,
    requests: db.prepare('SELECT data FROM requests WHERE run_id=? ORDER BY ordinal').all(runId),
    events: db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY id').all(runId),
  }; } finally { db.close(); }
}

test('actual follower worker cancellation and close leave a live source worker running', { timeout: 15000 }, async t => {
  const { writeFile } = await import('node:fs/promises');
  const data = await runtimeFixture(t, true);
  const source = await data.broker.submitProject({ selection: { kind: 'all' } });
  const sourceWorker = await actualWorker(t, data, source.id); await waitForCall(data.calls, 'a');
  const follower = await data.broker.submitProject({ selection: { kind: 'all' } });
  const followerWorker = await actualWorker(t, data, follower.id);
  data.broker.cancel(follower.id); assert.equal((await followerWorker.exited)[0], 0, followerWorker.errors());
  assert.equal(data.broker.getRun(source.id)!.status, 'RUNNING');
  await writeFile(join(data.root, 'release'), 'go');
  assert.equal((await sourceWorker.exited)[0], 0, sourceWorker.errors());
  assert.equal(data.broker.getRun(source.id)!.status, 'GREEN');
});
