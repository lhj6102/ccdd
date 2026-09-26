import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { records, storageTestHooks } from '../src/broker/storage.js';
import { canonical } from '../src/project/identity.js';
import { createBroker } from '../src/broker/index.js';
import { artifactFixture, runtimeCritic } from './helpers/artifacts.js';

for (const mutation of ['corrupt','delete'] as const) for (const warm of [false,true]) test(`immutable ${mutation} fails closed with ${warm ? 'warm' : 'cold'} cache and external writes`, async t => {
  const fixture = await artifactFixture(t), file = join(fixture.root, 'records.sqlite');
  const db = new DatabaseSync(file), external = new DatabaseSync(file); t.after(() => { external.close(); db.close(); });
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE definitions(hash TEXT PRIMARY KEY,data TEXT NOT NULL)');
  const store = records(db), ref = store.put({ verdict: 'RED' });
  if (warm) assert.deepEqual(store.get(ref), { verdict: 'RED' });
  else store.clear();
  if (mutation === 'corrupt') external.prepare('UPDATE definitions SET data=? WHERE hash=?').run('{"json":{"verdict":"GREEN"}}', ref);
  else external.prepare('DELETE FROM definitions WHERE hash=?').run(ref);
  assert.throws(() => store.get(ref), /Corrupt|Missing/);
  assert.throws(() => records(db).get(ref), /Corrupt|Missing/);
});

test('same-connection edits and invalid authenticated reference structures are rejected', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec('CREATE TABLE definitions(hash TEXT PRIMARY KEY,data TEXT NOT NULL)');
  const store = records(db), ref = store.put({ value: 1 }); store.get(ref);
  db.prepare('DELETE FROM definitions WHERE hash=?').run(ref); assert.throws(() => store.get(ref), /Missing/);
  for (const node of [{ invalid: [] }, { json: {}, array: [] }, { array: ['not-a-hash'] }, { object: [['b','a'.repeat(64)],['a','a'.repeat(64)]] }, { object: [['a','a'.repeat(64)],['a','a'.repeat(64)]] }, { array: ['0'.repeat(64)] }]) {
    const text = canonical(node), hash = createHash('sha256').update(text).digest('hex');
    db.prepare('INSERT INTO definitions VALUES (?,?)').run(hash,text);
    assert.throws(() => store.get(hash), /Invalid|Missing/);
  }
});

test('large Unicode objects have locale-independent code-unit hashes across permutations', () => {
  const module = new URL('../src/broker/storage.js', import.meta.url).href;
  const script = `import {DatabaseSync} from 'node:sqlite';import {records} from ${JSON.stringify(module)};const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE definitions(hash TEXT PRIMARY KEY,data TEXT NOT NULL)');const keys=['\\u00e9','e\\u0301','Z','a','\\ud83d\\ude00'];if(process.argv[1]==='reverse')keys.reverse();console.log(records(db).put(Object.fromEntries(keys.map(k=>[k,'x'.repeat(500)]))));db.close();`;
  const values = ['C','en_US.UTF-8','tr_TR.UTF-8'].flatMap(locale => ['forward','reverse'].map(order => execFileSync(process.execPath, ['--input-type=module','-e',script,order], { env: { ...process.env, LANG: locale, LC_ALL: locale }, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim()));
  assert.equal(new Set(values).size, 1);
});

test('changes rejects corrupt semantic nodes and valid hashes with mismatched verdicts', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'RED' }) } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(run.id);
  const db = new DatabaseSync(join(data.stateDir,'broker.sqlite')); t.after(() => db.close());
  const header = JSON.parse(String(db.prepare('SELECT data FROM requests WHERE run_id=?').get(run.id)!.data));
  broker.changes(run.id); // Populate normal caller paths before external corruption.
  db.prepare('UPDATE definitions SET data=? WHERE hash=?').run('{"json":{"verdict":"GREEN"}}',header.semanticRef);
  assert.throws(() => broker.changes(run.id), /Corrupt/);
  const valid = records(db).put({ verdict: 'GREEN' });
  db.prepare('UPDATE request_changes SET result_ref=? WHERE result_ref=?').run(valid,header.semanticRef);
  assert.throws(() => broker.changes(run.id), /result\/status mismatch/);
});

test('compact snapshots ignore unrelated evidence and discarded event payloads', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(run.id);
  let bytes = 0; storageTestHooks.read = n => bytes += n; t.after(() => { delete storageTestHooks.read; });
  const before = broker.getRun(run.id), baseline = bytes;
  const db = new DatabaseSync(join(data.stateDir,'broker.sqlite')); t.after(() => db.close());
  const header = JSON.parse(String(db.prepare('SELECT data FROM requests WHERE run_id=?').get(run.id)!.data));
  for (let i = 0; i < 50; i++) {
    const row = { ...header, id: `unrelated-${i}`, criticId: 'unrelated/check', inputKey: String(i).padStart(64,'0'), semanticRef: '0'.repeat(64) };
    db.prepare('INSERT INTO requests VALUES (?,?,?,?,?)').run(row.id,run.id,1000+i,'GREEN',JSON.stringify(row));
  }
  // Place unrelated history in another Run, so neither listing should decode it.
  const original = JSON.parse(String(db.prepare('SELECT data FROM runs WHERE id=?').get(run.id)!.data));
  db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run('other',original.createdAt,'GREEN',JSON.stringify({ ...original,id:'other' }));
  db.prepare("UPDATE requests SET run_id='other',data=json_set(data,'$.runId','other') WHERE id LIKE 'unrelated-%'").run();
  db.prepare("INSERT INTO events(run_id,request_id,created_at,type,message,data) VALUES (?,NULL,?,'test','test','not-json')").run(run.id,new Date().toISOString());
  bytes = 0; assert.deepEqual(broker.getRun(run.id),before); assert.equal(bytes,baseline);
  // Whole-Run listing legitimately returns the other Run's own requests. Make
  // those valid; malformed discarded events must still never be parsed.
  const valid = records(db).put({ verdict: 'GREEN' });
  db.prepare("UPDATE requests SET data=json_set(data,'$.semanticRef',?) WHERE run_id='other'").run(valid);
  assert.equal(broker.listRuns().length,2);
});
