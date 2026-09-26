import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { localAdmission } from '../src/broker/admission.js';
import { createBroker } from '../src/broker/index.js';
import { artifactFixture, runtimeCritic } from './helpers/artifacts.js';

test('local admission is FIFO and canceled waiters do not consume slots', async () => {
  const pool = localAdmission(1), request = { requestId: 'r', runId: 'run', kind: 'agent' };
  const first = await pool.acquire(request, { signal: new AbortController().signal, waiting() {} });
  const canceled = new AbortController(), order: number[] = [];
  const second = pool.acquire(request, { signal: canceled.signal, waiting() {} });
  const rejected = assert.rejects(second);
  const third = pool.acquire(request, { signal: new AbortController().signal, waiting() {} }).then(lease => { order.push(3); return lease; });
  canceled.abort(); await rejected; first.release(); first.release();
  const lease = await third; assert.deepEqual(order, [3]); await lease.release();
});

test('admission waits stay QUEUED and release even if cancellation wins the acquisition race', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  let acquired!: () => void, release = 0, calls = 0;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const broker = createBroker({ ...data, admission: { async acquire(_request, { signal, waiting }) {
    waiting('Waiting for test provider pool.'); acquired(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return { release() { release++; } };
  } }, executors: { canExecute: () => ({ ok: true }), execute: async () => { calls++; return { verdict: 'GREEN' }; } } });
  data.cleanup(() => broker.close()); const run = await broker.submitProject({ selection: { kind: 'all' } });
  const executing = broker.run(run.id); await ready;
  const request = broker.getRequest(run.requests[0].id)!;
  assert.equal(request.status, 'QUEUED'); assert.match(request.blockedReason!, /provider pool/);
  broker.cancel(run.id); await executing;
  assert.equal(calls, 0); assert.equal(release, 1);
});

test('admission exceptions fail only their request and other work progresses', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  let released = 0;
  const broker = createBroker({ ...data, admission: { async acquire() { await delay(1); return { release() { released++; } }; } }, executors: { canExecute: () => ({ ok: true }), execute: async () => { throw new Error('controlled executor failure'); } } });
  data.cleanup(() => broker.close()); const run = await broker.submitProject({ selection: { kind: 'all' } });
  assert.equal((await broker.run(run.id))!.status, 'ERROR'); assert.equal(released, 1);
});
