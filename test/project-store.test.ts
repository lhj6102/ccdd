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
  const broker = createBroker({ repoPath, stateDir, repoId: 'fixture' });
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
    requests: () => assert.deepEqual(projectRequests(f.stateDir), []),
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
  try { assert.throws(() => projectRequests(f.stateDir), { code: 'ERR_SQLITE_ERROR', errcode: 5 }); }
  finally { await worker.terminate(); }
});

test('project readers preserve read-only, missing-store and invalid-store behavior', async t => {
  const f = await fixture(t);
  assert.throws(() => withProjectStore(f.stateDir, db => db.exec('CREATE TABLE unexpected (id INTEGER)'), null), { errcode: 8 });
  assert.throws(() => withProjectStore(f.stateDir, db => db.prepare('SELECT * FROM missing_table').all(), null), /no such table/);
  assert.deepEqual(projectRequests(join(f.root, 'missing')), []);
  await writeFile(f.filename, 'not a SQLite database');
  assert.throws(() => projectRequests(f.stateDir), { errcode: 26 });
  assert.throws(() => readStateContext(f.stateDir), { errcode: 26 });
});
