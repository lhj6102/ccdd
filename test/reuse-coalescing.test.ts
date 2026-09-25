import test from 'node:test';
import { once } from 'node:events';
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

test('a follower executes an unowned queued source once and settles both Runs', { timeout: 10000 }, async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  let calls = 0;
  const executors = { canExecute: () => ({ ok: true as const }), execute: async () => { calls++; return { verdict: 'GREEN' as const }; } };
  const source = createBroker({ ...data, executors });
  const first = await source.submitProject({ selection: { kind: 'all' } }); await source.close();
  const follower = createBroker({ ...data, executors }); data.cleanup(() => follower.close());
  const second = await follower.submitProject({ selection: { kind: 'all' } });
  assert.equal(second.requests.length, 0);
  assert.equal((await follower.run(second.id))!.status, 'GREEN');
  assert.equal(follower.getRun(first.id)!.status, 'GREEN'); assert.equal(calls, 1);
  assert.equal(follower.getRun(second.id)!.results[0].reference.runId, first.id);
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

test('two follower processes race to recover one abandoned source with one execution', { timeout: 15000 }, async t => {
  const { join } = await import('node:path'); const { readFile } = await import('node:fs/promises');
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async () => { throw new Error('Only child workers execute'); } } }); data.cleanup(() => broker.close());
  const source = await broker.submitProject({ selection: { kind: 'all' } });
  const followers = await Promise.all([broker.submitProject({ selection: { kind: 'all' } }), broker.submitProject({ selection: { kind: 'all' } })]);
  const callsFile = join(data.root, 'calls');
  const workers = await Promise.all(followers.map(run => worker(t, { repoPath: data.repoPath, stateDir: data.stateDir }, run.id, 'finish', callsFile)));
  t.after(() => { for (const w of workers) w.child.kill('SIGKILL'); });
  const results = workers.map(w => w.message()); workers.forEach(w => w.child.send('go'));
  assert.deepEqual(await Promise.all(results), ['GREEN', 'GREEN']);
  for (const w of workers) assert.equal((await w.exited)[0], 0, w.errors());
  assert.equal(await readFile(callsFile, 'utf8'), 'executed\n');
  assert.equal(broker.getRun(source.id)!.status, 'GREEN');
  for (const run of followers) { assert.equal(broker.getRun(run.id)!.status, 'GREEN'); assert.equal(broker.getRun(run.id)!.requests.length, 0); }
});

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
