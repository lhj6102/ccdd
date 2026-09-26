import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from '../src/broker/index.js';
import { inspectProject, createProjectSnapshot } from '../src/project/index.js';
import { main } from '../src/project/cli.js';
import { artifactFixture, fixtureViews, runtimeCritic } from './helpers/artifacts.js';

for (const cap of [1, 2, 6, undefined]) test(`non-Human executor concurrency cap ${cap ?? 'default 4'} is observed per Run`, async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: Array.from({ length: 8 }, (_, i) => runtimeCritic(`c${i}`)) });
  let active = 0, peak = 0, calls = 0;
  const broker = createBroker({ ...data, maxConcurrentExecutors: cap, executors: { canExecute: () => ({ ok: true }), execute: async () => {
    calls++; peak = Math.max(peak, ++active); try { await delay(60); return { verdict: 'GREEN' }; } finally { active--; }
  } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  assert.equal((await broker.run(run.id))!.status, 'GREEN'); assert.equal(calls, 8); assert.equal(peak, cap ?? 4);
});

async function identities(t: Parameters<typeof artifactFixture>[0], mode = 'normal') {
  const data = await artifactFixture(t), log = join(data.root, 'identities.log');
  for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) await data.write(id, {
    name: id, stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] }, timeoutMs: mode === 'timeout' ? 100 : 5000 }, critics: [runtimeCritic()],
  }, { 'identity.mjs': `import {appendFileSync} from 'node:fs';
    const log=${JSON.stringify(log)}, id=${JSON.stringify(id)};
    appendFileSync(log, JSON.stringify({id,event:'start'})+'\\n');
    await new Promise(r=>setTimeout(r,${mode === 'normal' ? [250, 40, 180, 20][i] : id === 'a' && mode === 'fail' ? 100 : 3000}));
    ${mode === 'fail' && id === 'a' ? "process.exit(3);" : ''}
    appendFileSync(log, JSON.stringify({id,event:'end'})+'\\n'); console.log(id+'-value');` });
  return { ...data, log };
}
async function events(log: string) { return (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: string; event: string }); }
function peak(events: { event: string }[]) { let active = 0, max = 0; for (const event of events) { active += event.event === 'start' ? 1 : -1; max = Math.max(max, active); } return max; }

test('parallel owner identities obey the cap and produce identical keys regardless of completion order', async t => {
  const data = await identities(t);
  const sequential = await inspectProject({ ...data, detail: 'full', identityConcurrency: 1 });
  assert.equal(peak(await events(data.log)), 1); await writeFile(data.log, '');
  const parallel = await inspectProject({ ...data, detail: 'full', identityConcurrency: 2 });
  const observed = await events(data.log); assert.equal(peak(observed), 2);
  assert.notDeepEqual(observed.filter(e => e.event === 'end').map(e => e.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(parallel.snapshot, sequential.snapshot);
  await writeFile(data.log, '');
  const direct = await createProjectSnapshot(await data.config(), data.repoPath, sequential.snapshot.snapshotHash, undefined, 'content', { kind: 'all' }, { identityConcurrency: 3 });
  assert.deepEqual(direct, sequential.snapshot); assert.equal(peak(await events(data.log)), 3);
  await writeFile(data.log, '');
  const broker = createBroker({ ...data, identityConcurrency: 3, executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } }); data.cleanup(() => broker.close());
  await broker.submitProject({ selection: { kind: 'all' }, identityConcurrency: 1 });
  assert.equal(peak(await events(data.log)), 1, 'verify submission override reaches snapshot');
  await writeFile(data.log, '');
  await broker.submitProject({ selection: { kind: 'all' } });
  assert.equal(peak(await events(data.log)), 3, 'Broker identity default reaches verify');
});

for (const mode of ['cancel', 'fail', 'timeout']) test(`parallel owner identities ${mode} fail closed and stop queued work`, { timeout: 10000 }, async t => {
  const data = await identities(t, mode), controller = new AbortController();
  const broker = createBroker({ ...data, identityConcurrency: 2, executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } }); data.cleanup(() => broker.close());
  const pending = broker.submitProject({ selection: { kind: 'all' }, signal: controller.signal });
  const rejected = assert.rejects(pending, mode === 'cancel' ? /cancel fixture/ : /Identity script/);
  if (mode === 'cancel') {
    for (let n = 0; n < 200 && (await events(data.log)).length < 2; n++) await delay(10);
    assert.equal((await events(data.log)).length, 2); controller.abort(new Error('cancel fixture'));
  }
  await rejected;
  assert.equal(broker.listRuns().length, 0);
  const observed = await events(data.log);
  assert.ok(observed.every(e => ['a', 'b'].includes(e.id)), 'no queued owners start after failure');
  assert.ok(observed.every(e => e.event === 'start'), 'in-flight peers are cancelled before finishing');
});

test('concurrency rejects non-positive, fractional and nonnumeric settings', async t => {
  const data = await artifactFixture(t);
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => createBroker({ ...data, maxConcurrentExecutors: value }), /positive integer/);
    assert.throws(() => createBroker({ ...data, identityConcurrency: value }), /positive integer/);
    await assert.rejects(inspectProject({ ...data, identityConcurrency: value }), /positive integer/);
  }
  for (const option of ['--concurrency', '--identity-concurrency']) for (const value of ['0', '-1', '1.5', 'wat']) {
    let output = ''; const code = await main(['verify', '--all', option, value, '--json'], { stdout: { write: text => { output += text; } }, stderr: { write() {} } });
    assert.equal(code, 2); assert.match(output, /positive integer/);
  }
});

test('Human alarms do not consume the non-Human concurrency budget', { timeout: 10000 }, async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [runtimeCritic('first'), runtimeCritic('second'), { id: 'human', title: 'Human', profile: { kind: 'human' }, payload: { instruction: 'Inspect a.' } }] });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let notified!: () => void; const alarm = new Promise<void>(resolve => { notified = resolve; });
  let calls = 0;
  const broker = createBroker({ ...data, maxConcurrentExecutors: 1, executors: { canExecute: () => ({ ok: true }), execute: async () => { calls++; await gate; return { verdict: 'GREEN' }; }, notifyHuman: async () => { notified(); } } });
  data.cleanup(async () => { release(); await broker.close(); });
  const submitted = await broker.submitProject({ selection: { kind: 'all' } }); const running = broker.run(submitted.id);
  try { await alarm; assert.equal(calls, 1); } finally { broker.cancel(submitted.id); release(); await running; }
});
