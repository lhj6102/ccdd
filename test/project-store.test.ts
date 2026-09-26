import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createBroker, readStateContext } from '../src/broker/index.js';
import { projectRequests, withProjectStore } from '../src/project/store.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-project-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoPath = join(root, 'repo'), stateDir = join(root, 'state');
  await mkdir(repoPath);
  const broker = createBroker({ detail: 'full', repoPath, stateDir, repoId: 'fixture' });
  await broker.close();
  return { root, repoPath, stateDir, filename: join(stateDir, 'broker.sqlite') };
}

async function lockStore(t: TestContext, filename: string) {
  // Hold the same exclusive WAL lock that briefly blocks readers during connection cleanup.
  const worker = new Worker(`
    const { DatabaseSync } = require('node:sqlite');
    const { workerData, parentPort } = require('node:worker_threads');
    const database = new DatabaseSync(workerData);
    database.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    parentPort.postMessage('locked');
    parentPort.once('message', milliseconds => setTimeout(() => database.close(), milliseconds));
  `, { eval: true, workerData: filename });
  t.after(() => worker.terminate());
  await once(worker, 'message');
  return worker;
}

test('project readers wait for a transient WAL lock without changing stored data', async t => {
  const f = await fixture(t);
  const before = await readFile(f.filename);
  for (const [name, read] of Object.entries({
    identity: () => assert.deepEqual(readStateContext(f.stateDir), { repoPath: f.repoPath, repoId: 'fixture', stateDir: f.stateDir }),
    requests: () => assert.deepEqual(projectRequests(f.stateDir, undefined, { detail: 'full' }), []),
  })) {
    await t.test(name, async t => {
      const worker = await lockStore(t, f.filename);
      const closed = once(worker, 'exit');
      worker.postMessage(200);
      try { read(); }
      finally { await closed; }
    });
  }
  assert.deepEqual(await readFile(f.filename), before);
});

test('a persistent WAL lock still fails after a bounded reader wait', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const worker = await lockStore(t, f.filename);
  try { assert.throws(() => projectRequests(f.stateDir, undefined, { detail: 'full' }), { code: 'ERR_SQLITE_ERROR', errcode: 5 }); }
  finally { await worker.terminate(); }
});

test('project readers preserve read-only, missing-store and invalid-store behavior', async t => {
  const f = await fixture(t);
  assert.throws(() => withProjectStore(f.stateDir, db => db.exec('CREATE TABLE unexpected (id INTEGER)'), null), { errcode: 8 });
  assert.throws(() => withProjectStore(f.stateDir, db => db.prepare('SELECT * FROM missing_table').all(), null), /no such table/);
  assert.deepEqual(projectRequests(join(f.root, 'missing')), []);
  await writeFile(f.filename, 'not a SQLite database');
  assert.throws(() => projectRequests(f.stateDir, undefined, { detail: 'full' }), { errcode: 26 });
  assert.throws(() => readStateContext(f.stateDir), { errcode: 26 });
});

test('all store entry points reject pre-5.0 state without migrating it', async t => {
  const f = await fixture(t);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(f.filename);
  database.exec('PRAGMA user_version=0'); database.close();
  const before = await readFile(f.filename);
  const expected = /earlier CCDD major.*use a new state directory/;
  assert.throws(() => createBroker({ repoPath: f.repoPath, stateDir: f.stateDir, repoId: 'fixture' }), expected);
  assert.throws(() => readStateContext(f.stateDir), expected);
  const { pruneProject } = await import('../src/project/prune.js');
  assert.throws(() => pruneProject(f.stateDir), expected);
  const { createStatusPolling } = await import('../src/broker/polling.js');
  const reader = new DatabaseSync(f.filename, { readOnly: true });
  try { assert.throws(() => createStatusPolling(reader), expected); } finally { reader.close(); }
  assert.throws(() => projectRequests(f.stateDir), expected);
  const { createMonitorStore } = await import('../src/monitor/store.js');
  const overview = await createMonitorStore({ stateDirs: [f.stateDir] }).overview();
  assert.match(overview.projects[0].issue!, expected);
  assert.equal(overview.requests.length, 0);
  assert.deepEqual(await readFile(f.filename), before);
});
