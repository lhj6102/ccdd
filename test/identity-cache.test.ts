import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { openIdentityCache, readIdentityCache, type CachedReview } from '../src/cache/index.js';

const value = (verdict: 'GREEN' | 'RED' = 'GREEN'): CachedReview => ({
  result: { verdict, answer: 'controlled fixture', toolCalls: [] },
  profile: { kind: 'agent', provider: 'test', model: 'original', reasoning: 'medium' },
  origin: { runId: 'original-run', requestId: 'original-request' }, attemptId: 'original-attempt', executionProvenance: null,
});
async function fixture(t: test.TestContext, options: Parameters<typeof openIdentityCache>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-cache-test-'));
  const cache = openIdentityCache({ ...options, directory: join(root, 'cache') });
  t.after(async () => { await cache.close(); await rm(root, { recursive: true, force: true }); });
  return { root, cache };
}
function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw Error('Test condition timed out.'); await delay(10); }
}

test('explicit identity is the only cache key and original execution survives source removal', async t => {
  const { root, cache } = await fixture(t);
  const source = join(root, 'original-repository'); await mkdir(source);
  let calls = 0;
  const first = await cache.compute('owner:v1:input', async () => { calls++; return value(); }, { scope: source });
  await rm(source, { recursive: true });
  const second = await cache.compute('owner:v1:input', async () => { calls++; return { ...value('RED'), profile: { kind: 'human' } }; }, { scope: '/different/repo/worktree' });
  assert.equal(first.disposition, 'executed'); assert.equal(second.disposition, 'hit'); assert.equal(calls, 1);
  assert.deepEqual(first.entry, second.entry);
  second.entry.value.result.answer = 'caller mutation';
  assert.equal(readIdentityCache('owner:v1:input', cache.directory)!.value.result.answer, 'controlled fixture');
});

test('without an identity every request executes and no reusable entry or in-flight alias exists', async t => {
  const { cache } = await fixture(t); let calls = 0;
  const results = await Promise.all(Array.from({ length: 4 }, () => cache.compute(null, async () => { calls++; return value(); })));
  assert.equal(calls, 4); assert.equal(cache.list().items.length, 0);
  assert.equal(new Set(results.map(r => r.entry.executionId)).size, 4);
  assert.ok(results.every(r => r.disposition === 'uncached' && r.entry.identity === null));
});

test('GREEN and RED are equally reusable; operational errors are not cached', async t => {
  const { cache } = await fixture(t);
  await cache.compute('red', async () => value('RED'));
  assert.equal((await cache.compute('red', async () => { throw Error('must not execute'); })).entry.value.result.verdict, 'RED');
  await assert.rejects(cache.compute('failed', async () => { throw Object.assign(Error('secret fixture text'), { code: 'CONTROLLED_FAILURE' }); }), e => {
    assert.equal((e as any).code, 'CONTROLLED_FAILURE'); assert.doesNotMatch(String(e), /secret fixture text/); return true;
  });
  assert.equal(cache.get('failed'), null);
  assert.equal((await cache.compute('failed', async () => value())).disposition, 'executed');
});

test('matching requests on different cache connections share one execution', async t => {
  const { cache } = await fixture(t), other = openIdentityCache({ directory: cache.directory }); t.after(() => other.close());
  const hold = barrier(); let calls = 0, joined = false;
  const first = cache.compute('shared', async () => { calls++; await hold.promise; return value(); });
  await until(() => calls === 1);
  const follower = other.compute('shared', async () => { calls++; return value('RED'); }, { onState: s => { joined ||= s === 'coalesced'; } });
  await until(() => joined); hold.release();
  const [a, b] = await Promise.all([first, follower]);
  assert.equal(calls, 1); assert.equal(b.disposition, 'coalesced'); assert.equal(a.entry.executionId, b.entry.executionId);
});

test('canceling the initiating subscriber does not abort a remaining subscriber', async t => {
  const { cache } = await fixture(t), hold = barrier(), controller = new AbortController(); let started = false, joined = false, wasAborted = false;
  const first = cache.compute('cancel-one', async signal => { started = true; signal.addEventListener('abort', () => { wasAborted = true; }); await hold.promise; signal.throwIfAborted(); return value(); }, { signal: controller.signal });
  const rejected = assert.rejects(first, /initiator canceled/); await until(() => started);
  const second = cache.compute('cancel-one', async () => { throw Error('duplicate execution'); }, { onState: s => { joined ||= s === 'coalesced'; } });
  await until(() => joined); controller.abort(Error('initiator canceled')); await rejected;
  assert.equal(wasAborted, false); hold.release();
  assert.equal((await second).entry.value.result.verdict, 'GREEN');
});

test('all subscriber cancellation aborts work and rejects late publication', async t => {
  const { cache } = await fixture(t), hold = barrier(), controller = new AbortController(); let started = false, aborted = false;
  const task = cache.compute('cancel-all', async signal => { started = true; signal.addEventListener('abort', () => { aborted = true; }); await hold.promise; return value(); }, { signal: controller.signal });
  const rejected = assert.rejects(task, /canceled/); await until(() => started); controller.abort(Error('canceled')); await rejected;
  await until(() => aborted); hold.release(); await cache.drain(); assert.equal(cache.get('cancel-all'), null);
});

test('cache close detaches its subscriptions and cancels otherwise abandoned computation', async t => {
  const { cache } = await fixture(t); let started = false;
  const task = cache.compute('close', async signal => { started = true; await delay(10000, undefined, { signal }); return value(); });
  const rejected = assert.rejects(task, /closed/i); await until(() => started); await cache.close(); await rejected;
});

test('GC is bounded and observes entry/byte budgets without semantic expiration', async t => {
  const { cache } = await fixture(t, { maxEntries: 2 });
  for (const key of ['one', 'two', 'three']) await cache.compute(key, async () => value());
  const stats = await cache.gc(); assert.ok(stats.entries <= 2); assert.ok(cache.list().items.length <= 2);
  await assert.rejects(cache.gc({ limit: 0 }));
});

test('oversized results are returned but not retained as reusable entries', async t => {
  const { cache } = await fixture(t, { maxEntryBytes: 1 }); let calls = 0;
  for (let i = 0; i < 2; i++) assert.equal((await cache.compute('large', async () => { calls++; return value(); })).entry.value.result.verdict, 'GREEN');
  assert.equal(calls, 2); assert.equal(cache.get('large'), null);
});

test('cache corruption and invalid identities fail explicitly; read-only misses create nothing', async t => {
  const { root, cache } = await fixture(t);
  assert.equal(readIdentityCache('absent', join(root, 'never-created')), null);
  for (const key of ['', '../bad', 'x'.repeat(129)]) await assert.rejects(cache.compute(key, async () => value()));
  await cache.compute('corrupt', async () => value());
  const db = new DatabaseSync(join(cache.directory, 'cache.sqlite'));
  try { db.prepare("UPDATE cache_entries SET data='{}' WHERE identity='corrupt'").run(); } finally { db.close(); }
  assert.throws(() => cache.get('corrupt'), /integrity/);
});

test('separate Node processes coalesce through the same cache', async t => {
  const { cache } = await fixture(t);
  const module = new URL('../src/cache/index.js', import.meta.url).href;
  const code = `import {openIdentityCache} from ${JSON.stringify(module)}; const c=openIdentityCache({directory:process.argv[1]}); process.send('ready'); const r=await c.compute('process-key',async()=>{process.send('executing');await new Promise(r=>process.once('message',r));return ${JSON.stringify(value())};});process.send({id:r.entry.executionId,kind:r.disposition});await c.close();process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code, cache.directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let executing = false; const received: any[] = []; child.on('message', message => { received.push(message); executing ||= message === 'executing'; });
  await until(() => executing); let joined = false;
  const follower = cache.compute('process-key', async () => { throw Error('duplicate child work'); }, { onState: state => { joined ||= state === 'coalesced'; } });
  await until(() => joined); child.send('finish'); const result = await follower;
  await until(() => received.some(m => typeof m === 'object'));
  assert.equal(result.disposition, 'coalesced'); assert.equal(result.entry.executionId, received.find(m => typeof m === 'object').id);
});

test('a dead process is reclaimed without caching its operational failure', async t => {
  const { cache } = await fixture(t);
  const module = new URL('../src/cache/index.js', import.meta.url).href;
  const code = `import {openIdentityCache} from ${JSON.stringify(module)};const c=openIdentityCache({directory:process.argv[1]});await c.compute('crashed',async()=>{process.send('executing');await new Promise(()=>{});return ${JSON.stringify(value())};});`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code, cache.directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let executing = false; child.on('message', m => { executing ||= m === 'executing'; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await until(() => executing);
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
  let calls = 0; const recovered = await cache.compute('crashed', async () => { calls++; return value(); });
  assert.equal(calls, 1); assert.equal(recovered.disposition, 'executed'); assert.equal(recovered.entry.value.result.verdict, 'GREEN');
});

test('a lost owner cannot publish over a replacement result', async t => {
  const { cache } = await fixture(t), hold = barrier(); let started = false;
  const original = cache.compute('fenced', async () => { started = true; await hold.promise; return value('RED'); });
  const rejected = assert.rejects(original); await until(() => started);
  const db = new DatabaseSync(join(cache.directory, 'cache.sqlite'));
  try { db.exec("BEGIN IMMEDIATE; UPDATE cache_jobs SET state='ERROR',error_code='CACHE_OWNERSHIP_LOST',error_message='controlled fencing' WHERE identity='fenced'; DELETE FROM cache_active WHERE identity='fenced'; COMMIT"); }
  finally { db.close(); }
  await rejected;
  const replacement = await cache.compute('fenced', async () => value());
  hold.release(); await cache.drain();
  assert.equal(cache.get('fenced')!.executionId, replacement.entry.executionId);
  assert.equal(cache.get('fenced')!.value.result.verdict, 'GREEN');
});

test('bounded GC reports remaining execution storage as more work', async t => {
  const { root, cache } = await fixture(t);
  for (const identity of ['one', 'two', 'three']) await cache.compute(identity, async (_signal, id) => { await mkdir(join(root, 'cache', 'executions', id), { recursive: true }); return value(); });
  for (const identity of ['one', 'two', 'three']) await cache.delete(identity);
  assert.equal((await cache.gc({ limit: 1 })).needsMore, true);
  let collected; do collected = await cache.gc({ limit: 1 }); while (collected.needsMore);
  const db = new DatabaseSync(join(root, 'cache', 'cache.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM cache_execution_storage').get()!.n, 0); } finally { db.close(); }
});

test('a cancellation that cannot commit under contention still releases the computation', { timeout: 30000 }, async t => {
  const { root, cache } = await fixture(t);
  const blocker = new DatabaseSync(join(root, 'cache', 'cache.sqlite')); t.after(() => blocker.close());
  const abort = new AbortController(), held = barrier(); let started = false, aborted = false;
  const pending = cache.compute('contended', async signal => { started = true; signal.addEventListener('abort', () => { aborted = true; held.release(); }); await held.promise; return value(); }, { signal: abort.signal });
  await until(() => started);
  blocker.exec('BEGIN IMMEDIATE'); abort.abort(Error('caller canceled'));
  await assert.rejects(pending, /caller canceled/);
  await delay(300); blocker.exec('ROLLBACK');
  const deadline = Date.now() + 10000;
  while (!aborted || blocker.prepare('SELECT count(*) AS n FROM cache_subscribers').get()!.n !== 0) { if (Date.now() > deadline) throw Error('Pending detach was not retried.'); await delay(20); }
  await cache.drain();
  assert.equal(cache.get('contended'), null);
});

test('closing an owner with a remaining subscriber hands the identity over after a bounded drain', { timeout: 30000 }, async t => {
  const { root } = await fixture(t);
  const directory = join(root, 'shared'), owner = openIdentityCache({ directory, drainMs: 100 }), follower = openIdentityCache({ directory });
  t.after(async () => { await follower.close(); });
  let started = false;
  const owned = owner.compute('handover', async signal => { started = true; await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))); return value(); });
  await until(() => started);
  let state = '';
  const joined = follower.compute('handover', async () => value('RED'), { onState(next) { state = next; } });
  await until(() => state === 'coalesced');
  const closing = owner.close();
  await assert.rejects(owned);
  await closing;
  const result = await joined;
  assert.equal(result.entry.value.result.verdict, 'RED'); assert.equal(result.disposition, 'executed');
});
