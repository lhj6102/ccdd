import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from '../src/broker/index.js';
import { inspectProject } from '../src/project/index.js';
import { artifactFixture, runtimeCritic } from './helpers/artifacts.js';

for (const red of [false, true]) test(`dependency chain ${red ? 'RED blocks' : 'GREEN releases'} descendants`, async t => {
  const data = await artifactFixture(t), calls: string[] = [];
  for (const [id, dependency] of [['a',''],['b','a'],['c','b'],['d','c']]) await data.write(id, { name: id, critics: [runtimeCritic('check', dependency ? `Inspect {${dependency}}.` : 'Inspect.')] });
  const broker = createBroker({ ...data, maxConcurrentExecutors: 60, executors: { canExecute: () => ({ ok: true }), execute: async request => {
    calls.push(request.target); await delay(5); return { verdict: red && request.target === 'a' ? 'RED' : 'GREEN' };
  } } }); data.cleanup(() => broker.close());
  const plan = (await inspectProject(data)).plan;
  assert.equal(plan.counts.execute, 1); assert.equal(plan.counts.gated, 3);
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  assert.equal(run.requests.filter(r => r.status === 'QUEUED').length, 1);
  assert.equal((await broker.run(run.id))!.status, red ? 'RED' : 'GREEN');
  assert.deepEqual(calls, red ? ['a'] : ['a','b','c','d']);
  if (red) assert.ok(broker.getRun(run.id)!.requests.filter(r => r.target !== 'a').every(r => r.status === 'BLOCKED'));
});

test('ignoreGates explicitly executes all selected Critics after dependency RED', async t => {
  const data = await artifactFixture(t), calls: string[] = [];
  await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  await data.write('b', { name: 'b', critics: [runtimeCritic('check', 'Inspect {a}.')] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async request => { calls.push(request.target); return { verdict: 'RED' }; } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' }, ignoreGates: true });
  await broker.run(run.id); assert.deepEqual(calls.sort(), ['a','b']);
  assert.equal((await inspectProject({ ...data, force: true, ignoreGates: true })).plan.counts.execute, 2);
});

test('operational failure waits without a child verdict and same-input retry releases the child', async t => {
  const data = await artifactFixture(t), calls: string[] = []; let fail = true;
  await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  await data.write('b', { name: 'b', critics: [runtimeCritic('check', 'Inspect {a}.')] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async request => {
    calls.push(request.target); if (request.target === 'a' && fail) throw new Error('controlled operational failure'); return { verdict: 'GREEN' };
  } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(run.id);
  const waiting = broker.getRun(run.id)!;
  assert.equal(waiting.requests.find(r => r.target === 'b')!.status, 'WAIT_DEPENDENCY');
  assert.equal(waiting.requests.find(r => r.target === 'b')!.result, null);
  fail = false; broker.retryRequest(waiting.requests.find(r => r.target === 'a')!.id);
  assert.equal((await broker.run(run.id))!.status, 'GREEN'); assert.deepEqual(calls, ['a','a','b']);
});

test('independent chains start in parallel while SCC peers have no internal gate', async t => {
  const data = await artifactFixture(t); let active = 0, maximum = 0; const calls: string[] = [];
  for (const [id, dependency] of [['a','b'],['b','a'],['c',''],['d','c']]) await data.write(id, { name: id, critics: [runtimeCritic('check', dependency ? `Inspect {${dependency}}.` : 'Inspect.')] });
  const broker = createBroker({ ...data, maxConcurrentExecutors: 60, executors: { canExecute: () => ({ ok: true }), execute: async request => {
    calls.push(request.target); maximum = Math.max(maximum, ++active); await delay(20); active--; return { verdict: 'GREEN' };
  } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); assert.equal((await broker.run(run.id))!.status, 'GREEN');
  assert.ok(maximum >= 3); assert.ok(calls.indexOf('d') > calls.indexOf('c'));
});

test('reused descendant evidence is blocked by current RED and changed input replans automatically', async t => {
  const data = await artifactFixture(t); let red = false;
  await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  await data.write('b', { name: 'b', critics: [runtimeCritic('check', 'Inspect {a}.')] });
  const calls: string[] = [];
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async request => { calls.push(request.target); return { verdict: red && request.target === 'a' ? 'RED' : 'GREEN' }; } } }); data.cleanup(() => broker.close());
  let run = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(run.id);
  red = true; run = await broker.submitProject({ selection: { kind: 'critic', criticId: 'a/check' }, force: true }); await broker.run(run.id);
  const plan = (await inspectProject(data)).plan;
  assert.equal(plan.items.find(item => item.id === 'b/check')!.action, 'BLOCKED');
  assert.equal(plan.items.find(item => item.id === 'b/check')!.result, null);
  red = false; const { writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
  await writeFile(join(data.repoPath, 'a/content.txt'), 'Changed immutable input.');
  calls.length = 0; run = await broker.submitProject({ selection: { kind: 'all' } });
  assert.equal((await broker.run(run.id))!.status, 'GREEN'); assert.deepEqual(calls, ['a','b']);
});

test('CLI ignore-gates quote reports executable descendants instead of gated reviews', async t => {
  const { main } = await import('../src/project/cli.js');
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  await data.write('b', { name: 'b', critics: [runtimeCritic('check', 'Inspect {a}.')] });
  let output = '';
  assert.equal(await main(['plan','--all','--ignore-gates','--repo',data.repoPath,'--state-dir',data.stateDir,'--json'], { stdout: { write(s) { output += s; } }, stderr: { write(s) { throw new Error(s); } } }), 0);
  assert.equal(JSON.parse(output).counts.execute, 2); assert.equal(JSON.parse(output).counts.gated, 0);
});

test('coalesced chains observe source gates and never invoke duplicate descendants', async t => {
  const data = await artifactFixture(t); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const calls: string[] = [];
  await data.write('a', { name: 'a', critics: [runtimeCritic()] }); await data.write('b', { name: 'b', critics: [runtimeCritic('check', 'Inspect {a}.')] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async request => { calls.push(request.target); if (request.target === 'a') await gate; return { verdict: 'GREEN' }; } } });
  data.cleanup(async () => { release(); await broker.close(); });
  const source = await broker.submitProject({ selection: { kind: 'all' } }), running = broker.run(source.id);
  const follower = await broker.submitProject({ selection: { kind: 'all' } }), following = broker.run(follower.id);
  await delay(20); assert.deepEqual(calls, ['a']); release();
  assert.equal((await running)!.status, 'GREEN'); assert.equal((await following)!.status, 'GREEN');
  assert.equal(calls.filter(c => c === 'b').length, 1);
});

test('gate readiness does not depend on discovery order', async t => {
  const data = await artifactFixture(t), calls: string[] = [];
  await data.write('z', { name: 'z', critics: [runtimeCritic()] });
  await data.write('a', { name: 'a', critics: [runtimeCritic('check', 'Inspect {z}.')] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async request => { calls.push(request.target); return { verdict: 'GREEN' }; } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); assert.equal((await broker.run(run.id))!.status, 'GREEN'); assert.deepEqual(calls, ['z','a']);
});

test('force respects gates and basis or no-Critic inputs do not gate', async t => {
  const data = await artifactFixture(t), calls: string[] = [];
  await data.write('empty', { name: 'empty' }); await data.write('basis', { name: 'basis', basis: true });
  await data.write('a', { name: 'a', critics: [runtimeCritic('check', 'Inspect {empty} and {basis}.')] });
  await data.write('b', { name: 'b', critics: [runtimeCritic('check', 'Inspect {a}.')] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async request => { calls.push(request.target); return { verdict: request.target === 'a' ? 'RED' : 'GREEN' }; } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' }, force: true }); await broker.run(run.id);
  assert.deepEqual(calls, ['a']); assert.equal(broker.getRun(run.id)!.requests.find(r => r.target === 'b')!.status, 'BLOCKED');
});

test('forced ancestor releases a reused chain in reverse discovery order', async t => {
  const data = await artifactFixture(t), calls: string[] = [];
  for (const [id, dependency] of [['z',''],['m','z'],['a','m']]) await data.write(id, { name: id, critics: [runtimeCritic('check', dependency ? `Inspect {${dependency}}.` : 'Inspect.')] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async request => { calls.push(request.target); return { verdict: 'GREEN' }; } } }); data.cleanup(() => broker.close());
  let run = await broker.submitProject({ selection: { kind: 'all' } }); assert.equal((await broker.run(run.id))!.status, 'GREEN');
  calls.length = 0; run = await broker.submitProject({ selection: { kind: 'critic', criticId: 'z/check' }, force: true });
  assert.equal((await broker.run(run.id))!.status, 'GREEN'); assert.deepEqual(calls, ['z']);
  const again = await broker.submitProject({ selection: { kind: 'all' } }); assert.equal(again.status, 'GREEN'); assert.equal(again.requests.length, 0);
});

test('a gated follower cannot adopt satisfaction early from an ignore-gates source', async t => {
  const data = await artifactFixture(t); let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  await data.write('a', { name: 'a', critics: [runtimeCritic()] }); await data.write('b', { name: 'b', critics: [runtimeCritic('check', 'Inspect {a}.')] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async request => { if (request.target === 'a') await hold; return { verdict: 'GREEN' }; } } });
  data.cleanup(async () => { release(); await broker.close(); });
  const source = await broker.submitProject({ selection: { kind: 'all' }, ignoreGates: true }), running = broker.run(source.id);
  const follower = await broker.submitProject({ selection: { kind: 'all' } }), following = broker.run(follower.id);
  await delay(30);
  const plan = broker.getRun(follower.id)!.validation!;
  assert.equal(plan.items.find(item => item.id === 'b/check')!.status, 'WAIT_DEPENDENCY');
  release(); assert.equal((await running)!.status, 'GREEN'); assert.equal((await following)!.status, 'GREEN');
});

test('direct SCC gate construction visits dense edges once without transitive expansion', async t => {
  const { criticGates, gateTestHooks } = await import('../src/project/gates.js');
  const { createGraphDefinition } = await import('../src/broker/graph.js');
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const base = await data.config();
  const count = 120, ids = Array.from({ length: count }, (_, n) => `n${n}`);
  const config = { ...base, artifacts: Object.fromEntries(ids.map(id => [id, { ...base.artifacts.a, name: id, path: id }])),
    critics: ids.map(id => ({ ...base.critics[0], id: `${id}/check`, target: id, deps: [] })),
    relations: ids.flatMap((target, n) => ids.slice(0, n).map(source => ({ source, target, kind: 'mount' as const }))) };
  createGraphDefinition(config, false);
  let visits = 0; gateTestHooks.edge = () => visits++; t.after(() => { delete gateTestHooks.edge; });
  const dense = criticGates({ config });
  assert.equal(visits, config.relations.length);
  assert.equal([...dense.values()].reduce((n, deps) => n + deps.length, 0), config.relations.length);
  config.relations = ids.slice(1).map((target, n) => ({ source: ids[n], target, kind: 'mount' as const }));
  visits = 0; const chain = criticGates({ config });
  assert.equal(visits, count - 1); assert.equal([...chain.values()].reduce((n, deps) => n + deps.length, 0), count - 1);
  assert.deepEqual(chain.get('n119/check'), ['n118/check']);
  config.relations.push({ source: 'n119', target: 'n118', kind: 'mount' });
  const cycle = criticGates({ config });
  assert.deepEqual(cycle.get('n118/check'), ['n117/check']); assert.deepEqual(cycle.get('n119/check'), ['n117/check']);
});
