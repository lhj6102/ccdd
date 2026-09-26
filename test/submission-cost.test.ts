import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { records } from '../src/broker/storage.js';
import { createBroker } from '../src/broker/index.js';
import { artifactFixture, runtimeCritic } from './helpers/artifacts.js';
import type { RunRecord } from '../src/broker/index.js';

async function fixture(t: import('node:test').TestContext) {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, detail: 'full', executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite')); t.after(() => db.close());
  return { ...data, broker, run, db };
}

test('prepared immutable nodes retain synchronous hashes and authenticate before publication', async t => {
  const { run, db } = await fixture(t), store = records(db);
  // Boundary lengths, repeated subtrees, undefined optional object fields and Unicode.
  const shared = { 'é': 'x'.repeat(1020), nested: ['text', null, 123] };
  const record: RunRecord = { ...run, project: { ...run.project!, snapshot: { ...run.project!.snapshot, artifactHashes: { ...run.project!.snapshot.artifactHashes, extra: 'x'.repeat(1023) } } } };
  record.project!.templates[0].payload = { instruction: 'Inspect.', shared, again: shared, optional: undefined };
  const old = store.packRun(record), prepared = await store.prepareRun(record);
  assert.deepEqual(prepared.header, old);
  for (const envelope of record.project!.templates) assert.equal(prepared.envelopes.get(envelope.criticId), store.put(envelope));
  prepared.verify();
  db.prepare('DELETE FROM definitions WHERE hash=?').run(prepared.header.definitionRef);
  assert.throws(() => prepared.verify(), /missing prepared/);
});

test('prepared references cannot publish corruption arriving between async preparation and commit', async t => {
  const { run, db, stateDir } = await fixture(t), store = records(db);
  const prepared = await store.prepareRun(run), external = new DatabaseSync(join(stateDir,'broker.sqlite')); t.after(() => external.close());
  external.prepare('UPDATE definitions SET data=? WHERE hash=?').run('{"json":{"forged":true}}', prepared.header.workspaceRef);
  db.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => prepared.verify(), /Corrupt/); } finally { db.exec('ROLLBACK'); }
});

test('submission preparation yields without holding a writer lock and respects cancellation', async t => {
  const { run, db, stateDir } = await fixture(t), store = records(db), controller = new AbortController();
  const external = new DatabaseSync(join(stateDir,'broker.sqlite'), { timeout: 50 }); t.after(() => external.close());
  const big = { ...run, project: { ...run.project!, templates: Array.from({ length: 200 }, (_, n) => ({ ...run.project!.templates[0], criticId: `a/c${n}`, payload: { instruction: 'Inspect.', data: Array.from({ length: 100 }, (_, i) => ({ text: `row-${n}-${i}` })) } })) } };
  let ticks = 0;
  const timer = setInterval(() => { external.exec('BEGIN IMMEDIATE; COMMIT'); ticks++; controller.abort(new Error('controlled cancellation')); }, 1);
  try { await assert.rejects(store.prepareRun(big, controller.signal), /controlled cancellation/); }
  finally { clearInterval(timer); }
  assert.ok(ticks > 0); assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get()!.n, 1);
});

test('prepared hashes are scoped to one submission, not mutable object identity across calls', async t => {
  const { run, db } = await fixture(t), store = records(db);
  const first = await store.prepareRun(run);
  run.project!.templates[0].payload.instruction = 'Changed instruction.';
  const second = await store.prepareRun(run);
  assert.notEqual(second.header.definitionRef, first.header.definitionRef);
  second.verify();
});

test('public envelopes and compact results remain detached from caller-owned selections', async t => {
  const { broker, run, repoPath } = await fixture(t);
  const { readWorkspaceConfig } = await import('../src/broker/config.js');
  const { prepareReviewRequests } = await import('../src/requester/index.js');
  const { config } = await readWorkspaceConfig(repoPath);
  const [envelope] = await prepareReviewRequests({ repoPath, snapshotHash: run.snapshotHash, preparedConfig: config });
  envelope.payload.instruction = 'forged'; envelope.artifacts[0].path = 'forged';
  assert.notEqual(config.critics[0].payload.instruction, 'forged'); assert.notEqual(config.artifacts.a.path, 'forged');
  const selected = { kind: 'critic' as const, criticId: 'a/check' };
  const pending = broker.submitProject({ selection: selected, force: true });
  const submitted = await pending; selected.criticId = 'forged/check';
  assert.equal(broker.getRun(submitted.id)!.project!.selection.kind, 'critic');
  assert.equal((broker.getRun(submitted.id)!.project!.selection as typeof selected).criticId, 'a/check');
});
