import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createBroker } from '../src/broker/index.js';
import { createReadiness, readinessTestHooks } from '../src/broker/readiness.js';
import { records, storageTestHooks } from '../src/broker/storage.js';
import { artifactFixture, runtimeCritic } from './helpers/artifacts.js';

for (const count of [20, 2000]) test(`one transition visits one membership with ${count} Critics`, async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', critics: Array.from({ length: count }, (_, n) => runtimeCritic(`c${n}`)) });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } });
  data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' }, force: true });
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite')); t.after(() => db.close());
  const store = records(db), state = createReadiness(db, store, { reconcile() {}, deadlines: new Map() }, () => {});
  let members = 0, statuses = 0, bytes = 0;
  readinessTestHooks.member = () => members++; readinessTestHooks.status = () => statuses++; storageTestHooks.read = n => bytes += n;
  t.after(() => { delete readinessTestHooks.member; delete readinessTestHooks.status; delete storageTestHooks.read; });
  const request = JSON.parse(String(db.prepare('SELECT data FROM requests WHERE id=?').get(run.requests[0].id)!.data));
  request.status = 'RUNNING'; db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE requests SET status=?,data=? WHERE id=?').run(request.status, JSON.stringify(request), request.id);
  state.transition(request); db.exec('COMMIT');
  assert.equal(members, 1); assert.equal(statuses, 1); assert.equal(bytes, 0, 'dispatch does not hydrate any immutable definition');
  const page = broker.changes(run.id, { after: count, limit: 1 })!;
  assert.equal(page.changes.length, 1); assert.equal(page.changes[0].status, 'RUNNING');
  const cursor = page.cursor;
  assert.deepEqual(broker.changes(run.id, { after: cursor })!.changes, []);
  t.diagnostic(`${count} Critics: one membership, one counter check, zero definition bytes on transition.`);
});

for (const artifacts of [1, 1000]) test(`an isolated request and telemetry stay small with ${artifacts} Artifacts`, async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  for (let i = 1; i < artifacts; i++) await data.write(`basis${i}`, { name: `basis${i}`, basis: true });
  let callbacks = 0, cursor = 0;
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async (_request, context) => {
    for (let i = 0; i < 100; i++) await context.onEvent?.({ type: 'executor.usage', usage: { input: 1, output: 1 } });
    return { verdict: 'GREEN' };
  } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite'), { readOnly: true }); t.after(() => db.close());
  const size = Number(db.prepare('SELECT length(data) AS size FROM requests WHERE id=?').get(run.requests[0].id)!.size);
  assert.ok(size < 3000, `request header ${size} bytes`);
  const unsubscribe = broker.onChange(() => { const page = broker.changes(run.id, { after: cursor })!; cursor = page.cursor; callbacks++; });
  assert.equal((await broker.run(run.id))!.status, 'GREEN'); unsubscribe();
  assert.ok(callbacks >= 100);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM request_changes WHERE run_id=?').get(run.id)!.n), 3, 'telemetry never creates lifecycle changes');
  const changes = broker.changes(run.id, { after: 0 })!;
  assert.deepEqual(changes.changes.map(c => c.status), ['QUEUED','RUNNING','GREEN']);
  assert.equal(changes.changes.at(-1)!.result!.verdict, 'GREEN');
  changes.changes.at(-1)!.result!.verdict = 'RED';
  assert.equal(broker.changes(run.id)!.changes.at(-1)!.result!.verdict, 'GREEN');
  t.diagnostic(`${artifacts} Artifacts: ${size}-byte request, 3 lifecycle changes despite 100 telemetry callbacks.`);
});

test('changed-result cursors preserve rollback and reject invalid pages', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  const before = broker.changes(run.id)!;
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite')); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_cancel BEFORE INSERT ON events WHEN NEW.type='run.error' BEGIN SELECT RAISE(ABORT,'rollback'); END");
  assert.throws(() => broker.cancel(run.id), /rollback/);
  assert.deepEqual(broker.changes(run.id), before);
  for (const options of [{ after: -1 }, { after: 1.5 }, { limit: 0 }, { limit: 1001 }]) assert.throws(() => broker.changes(run.id, options));
});

test('fresh state rejects every previous major before touching records', async t => {
  const { mkdir } = await import('node:fs/promises');
  const data = await artifactFixture(t); await mkdir(data.stateDir);
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite'));
  db.exec('PRAGMA user_version=5; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES (\'preserve\');'); db.close();
  assert.throws(() => createBroker(data), /new state directory/);
  const verify = new DatabaseSync(join(data.stateDir, 'broker.sqlite'), { readOnly: true });
  try { assert.equal(verify.prepare('PRAGMA user_version').get()!.user_version, 5); assert.equal(verify.prepare('SELECT value FROM evidence').get()!.value, 'preserve'); }
  finally { verify.close(); }
});

test('sixty concurrent executors tolerate a changed-results read on every telemetry event', async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', critics: Array.from({ length: 180 }, (_, n) => runtimeCritic(`c${n}`)) });
  const { monitorEventLoopDelay } = await import('node:perf_hooks'); const { setTimeout: delay } = await import('node:timers/promises');
  let active = 0, maximum = 0, pages = 0, cursor = 0;
  const broker = createBroker({ ...data, maxConcurrentExecutors: 60, executors: { canExecute: () => ({ ok: true }), execute: async (_request, context) => {
    maximum = Math.max(maximum, ++active);
    try { for (let turn = 0; turn < 5; turn++) { await context.onEvent?.({ type: 'executor.usage', usage: { input: 100, output: 20 } }); await delay(2); } return { verdict: 'GREEN' }; }
    finally { active--; }
  } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const unsubscribe = broker.onChange(() => { let result; do { result = broker.changes(run.id, { after: cursor })!; cursor = result.cursor; pages++; } while (result.hasMore); });
  try { assert.equal((await broker.run(run.id))!.status, 'GREEN'); }
  finally { unsubscribe(); loop.disable(); }
  assert.equal(maximum, 60); assert.ok(pages >= 900); assert.ok(loop.max / 1e6 < 2000, `event loop ${loop.max / 1e6}ms`);
});

test('cancel emits each affected request and blocked reused evidence stays out of changes', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); const cursor = broker.changes(run.id)!.cursor;
  broker.cancel(run.id); const page = broker.changes(run.id, { after: cursor })!;
  assert.equal(page.status, 'ERROR'); assert.equal(page.changes.length, 1); assert.equal(page.changes[0].status, 'ERROR');
});

test('a cursor observes another process cancellation without hydrating definitions', async t => {
  const { spawn } = await import('node:child_process')
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }), cursor = broker.changes(run.id)!.cursor;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {createBroker} from ${JSON.stringify(new URL('../src/broker/index.js', import.meta.url).href)};const b=createBroker(${JSON.stringify({ repoPath: data.repoPath, stateDir: data.stateDir })});b.cancel(${JSON.stringify(run.id)});await b.close();`], { stdio: 'ignore' });
  t.after(() => child.kill()); assert.equal((await once(child, 'exit'))[0], 0);
  let bytes = 0; storageTestHooks.read = n => bytes += n; t.after(() => { delete storageTestHooks.read; });
  const page = broker.changes(run.id, { after: cursor })!;
  assert.equal(page.status, 'ERROR'); assert.equal(page.changes[0].status, 'ERROR'); assert.equal(bytes, 0);
});
