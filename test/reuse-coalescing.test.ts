import test from 'node:test';
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
