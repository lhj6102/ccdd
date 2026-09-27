import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openResources, readResourceConfiguration, resourcePaths, validateIdentityWeight } from '../src/resources.js';
import { ownProcessIdentity } from '../src/broker/ownership.js';

async function fixture(t: test.TestContext, config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-resource-test-'));
  const previous = { state: process.env.CCDD_STATE_HOME, config: process.env.CCDD_CONFIG_HOME };
  process.env.CCDD_STATE_HOME = join(root, 'machine'); process.env.CCDD_CONFIG_HOME = join(root, 'config');
  await mkdir(process.env.CCDD_CONFIG_HOME); await writeFile(resourcePaths().config, JSON.stringify(config));
  const stores: ReturnType<typeof openResources>[] = [];
  t.after(async () => { for (const store of stores) store.close(); for (const [name, value] of [['CCDD_STATE_HOME', previous.state], ['CCDD_CONFIG_HOME', previous.config]]) { if (value === undefined) delete process.env[name!]; else process.env[name!] = value; } await rm(root, { recursive: true, force: true }); });
  return { root, store() { const store = openResources(); stores.push(store); return store; } };
}
const options = (signal = new AbortController().signal) => ({ signal, waiting() {} });
const request = (runId: string, provider = 'p', repo = 'repo') => ({ runId, requestId: randomUUID(), kind: 'agent', provider, model: 'm', repo });
async function until(predicate: () => boolean | Promise<boolean>) { const deadline = Date.now() + 5000; while (!await predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for test condition.'); await delay(10); } }
function child(script: string) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '--eval', script], { env: globalThis.process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = ''; process.stdout.on('data', bytes => output += bytes); process.stderr.on('data', bytes => error += bytes);
  const exited = new Promise<number | null>((resolve, reject) => { process.on('error', reject); process.on('exit', resolve); });
  return { process, output: () => output, error: () => error, exited };
}
const moduleUrl = new URL('../src/resources.js', import.meta.url).href;

test('local configuration has finite defaults and strict weight validation in both capacity directions', async t => {
  const fixtureData = await fixture(t);
  assert.deepEqual(readResourceConfiguration(), { identityCapacity: 100, defaultProviderCapacity: 4, providers: {} });
  assert.equal(validateIdentityWeight(), 25);
  await writeFile(resourcePaths().config, JSON.stringify({ identityCapacity: 200, providers: { p: { capacity: 60, models: { m: 10 } } } }));
  assert.equal(readResourceConfiguration().identityCapacity, 200);
  assert.throws(() => validateIdentityWeight(101), /1 to 100/);
  await writeFile(resourcePaths().config, JSON.stringify({ identityCapacity: 10 }));
  assert.throws(() => validateIdentityWeight(), /exceeds local/);
  assert.throws(() => validateIdentityWeight(1.5), /integer/);
  assert.ok(fixtureData.root);
});

test('weighted FIFO reserves the head, cancellation removes it, and unrelated providers remain independent', async t => {
  const data = await fixture(t, { identityCapacity: 100, defaultProviderCapacity: 1 }), store = data.store();
  const identity = (weight: number) => ({ ...request(''), identityWeight: weight });
  const first = await store.acquire(identity(60), options()), order: string[] = [];
  const heavy = store.acquire(identity(60), options()).then(lease => { order.push('heavy'); return lease; });
  const light = store.acquire(identity(10), options()).then(lease => { order.push('light'); return lease; });
  await delay(70); assert.deepEqual(order, []);
  await first.release(); const held = await heavy; await light.then(lease => lease.release()); assert.deepEqual(order, ['heavy', 'light']); await held.release();
  const blocker = await store.acquire(identity(100), options()), controller = new AbortController();
  const canceled = store.acquire(identity(100), options(controller.signal)); const rejected = assert.rejects(canceled);
  controller.abort(new Error('cancel before admission')); await rejected; await blocker.release();
  store.registerSubmission('one'); store.registerSubmission('two');
  const p = await store.acquire(request('one'), options());
  const q = await store.acquire(request('two', 'q'), options()); await q.release(); await p.release();
});

test('final budget and provider slot reservations are atomic and release is token-checked idempotent', async t => {
  const data = await fixture(t, { defaultProviderCapacity: 1 }), a = data.store(), b = data.store();
  a.registerSubmission('budget', 1); b.registerSubmission('budget', 1);
  const first = await a.acquire(request('budget'), options()); first.started(); first.started();
  let acquired = false;
  const pending = b.acquire(request('budget'), options()).then(value => { acquired = true; return value; });
  const rejection = assert.rejects(pending, { code: 'EXECUTION_BUDGET_EXHAUSTED' });
  await delay(60); assert.equal(acquired, false);
  first.terminal(); await first.release(); await first.release(); await rejection;
  assert.equal(a.budget('budget')!.attempts.length, 1); assert.equal(a.budget('budget')!.attempts[0].state, 'terminal');
  assert.throws(() => a.registerSubmission('budget', 2), /immutable/);
  a.registerSubmission('refund', 1); const pre = await a.acquire(request('refund'), options()); await pre.release();
  const next = await b.acquire(request('refund'), options()); assert.notEqual(next.token, pre.token); await next.release();
  assert.equal(a.budget('refund')!.attempts.filter(row => row.state === 'refunded').length, 2);
});

test('live stale heartbeats are not reclaimed and process-start mismatch is reclaimed safely', async t => {
  const data = await fixture(t, { defaultProviderCapacity: 1 }), store = data.store(); store.registerSubmission('live');
  const held = await store.acquire(request('live'), options());
  const db = new DatabaseSync(resourcePaths().database); t.after(() => db.close());
  db.prepare('UPDATE resource_leases SET heartbeat=0 WHERE token=?').run(held.token);
  const abort = new AbortController(); let admitted = false;
  const waiting = store.acquire(request('live'), options(abort.signal)).then(lease => { admitted = true; return lease; });
  const rejected = assert.rejects(waiting); await delay(80); assert.equal(admitted, false); abort.abort(); await rejected;
  db.prepare('UPDATE resource_leases SET process_identity=? WHERE token=?').run('reused-pid', held.token);
  const replacement = await store.acquire(request('live'), options());
  await held.release(); assert.equal(db.prepare("SELECT count(*) AS n FROM resource_leases WHERE state='active'").get()!.n, 1);
  await replacement.release();
  assert.ok(ownProcessIdentity);
});

test('two processes race for the last budget unit and provider slot without over-admission', async t => {
  const data = await fixture(t, { defaultProviderCapacity: 1 }), store = data.store(); store.registerSubmission('race', 1);
  const script = `import {openResources} from ${JSON.stringify(moduleUrl)};const s=openResources();try{const l=await s.acquire(${JSON.stringify(request('race'))},{signal:new AbortController().signal,waiting(){}});l.started();console.log('START');await new Promise(r=>setTimeout(r,80));l.terminal();await l.release();}catch(e){console.log(e.code)}finally{s.close()}`;
  const a = child(script), b = child(script); t.after(() => { a.process.kill('SIGKILL'); b.process.kill('SIGKILL'); });
  assert.deepEqual(await Promise.all([a.exited, b.exited]), [0, 0]);
  const output = a.output() + b.output(); assert.equal(output.match(/START/g)?.length, 1, output); assert.equal(output.match(/EXECUTION_BUDGET_EXHAUSTED/g)?.length, 1, output);
  assert.equal(store.budget('race')!.attempts.length, 1);
});

for (const started of [false, true]) test(`dead process ${started ? 'consumes an ambiguously started' : 'refunds a definitely prestart'} attempt across restart`, async t => {
  const data = await fixture(t, { defaultProviderCapacity: 1 }), store = data.store(); store.registerSubmission('dead', 1);
  const c = child(`import {openResources} from ${JSON.stringify(moduleUrl)};const s=openResources();const l=await s.acquire(${JSON.stringify(request('dead'))},{signal:new AbortController().signal,waiting(){}});${started ? 'l.started();' : ''}console.log('READY');setInterval(()=>{},1000);`);
  t.after(() => c.process.kill('SIGKILL')); await until(() => c.output().includes('READY')); c.process.kill('SIGKILL'); await c.exited;
  if (started) await assert.rejects(store.acquire(request('dead'), options()), { code: 'EXECUTION_BUDGET_EXHAUSTED' });
  else { const lease = await store.acquire(request('dead'), options()); lease.started(); await lease.release(); }
  assert.equal(store.budget('dead')!.attempts.filter(row => row.state === 'started').length, 1);
});

test('dead owner cleanup retains the slot until its tracked child group is no longer running', async t => {
  if (process.platform !== 'linux') return t.skip('Linux process group identity proof');
  const data = await fixture(t, { defaultProviderCapacity: 1 }), store = data.store(); store.registerSubmission('orphan');
  const c = child(`import {spawn} from 'node:child_process';import {openResources} from ${JSON.stringify(moduleUrl)};const s=openResources();const l=await s.acquire(${JSON.stringify(request('orphan'))},{signal:new AbortController().signal,waiting(){}});l.started();const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});l.trackChild(c.pid);console.log(c.pid);setInterval(()=>{},1000);`);
  t.after(() => c.process.kill('SIGKILL')); await until(() => /^\d+/.test(c.output())); const pid = Number(c.output().trim());
  c.process.kill('SIGKILL'); await c.exited;
  const next = await store.acquire(request('orphan'), options());
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
  assert.ok(stat === null || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')); await next.release();
});

test('release waits for tracked child termination and frees next waiter without a second release', async t => {
  const data = await fixture(t, { defaultProviderCapacity: 1 }), store = data.store(); store.registerSubmission('release');
  const lease = await store.acquire(request('release'), options()); lease.started();
  const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  const exited = new Promise<void>(resolve => c.once('exit', () => resolve()));
  lease.trackChild(c.pid!); t.after(() => { try { process.kill(-c.pid!, 'SIGKILL'); } catch {} });
  let admitted = false; const next = store.acquire(request('release'), options()).then(value => { admitted = true; return value; });
  assert.equal(admitted, false); await lease.release(); await exited; await lease.release();
  const held = await next; assert.equal(admitted, true); await held.release();
});
