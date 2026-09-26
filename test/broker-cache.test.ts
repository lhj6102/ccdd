import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker, brokerTestHooks } from '../src/broker/index.js';
import { artifactFixture, runtimeCritic, readTool } from './helpers/artifacts.js';

async function remote(data: { repoPath: string; stateDir: string }, body: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createBroker } from ${JSON.stringify(new URL('../src/broker/index.js', import.meta.url).href)};
    const broker = createBroker(${JSON.stringify({ repoPath: data.repoPath, stateDir: data.stateDir })});
    try { ${body} } finally { await broker.close(); }
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', value => { errors += value; });
  assert.equal((await once(child, 'exit'))[0], 0, errors);
}

test('cached runs immediately observe remote cancellation', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, detail: 'full', executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } });
  data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  assert.equal(broker.getRun(run.id)!.status, 'QUEUED');
  await remote(data, `broker.cancel(${JSON.stringify(run.id)});`);
  assert.equal(broker.getRun(run.id)!.status, 'ERROR');
  assert.equal(broker.getRun(run.id)!.requests[0].status, 'ERROR');
});

test('rollback discards locally saved run and attempt cache entries', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, detail: 'full', executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } });
  data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  const database = new DatabaseSync(join(data.stateDir, 'broker.sqlite')); t.after(() => database.close());
  database.exec("CREATE TRIGGER reject_error_event BEFORE INSERT ON events WHEN NEW.type = 'run.error' BEGIN SELECT RAISE(ABORT, 'injected rollback'); END");
  assert.throws(() => broker.cancel(run.id), /injected rollback/);
  // No intervening external commit: data_version cannot repair a stale local cache.
  assert.equal(broker.getRun(run.id)!.status, 'QUEUED');
  assert.equal(broker.getRun(run.id)!.requests[0].status, 'QUEUED');
  assert.equal((await broker.run(run.id))!.status, 'GREEN');
});

test('remote Human claims and source completion refresh a cached coalesced follower', { timeout: 15000 }, async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: { humanTools: { read: readTool() } }, critics: [{ id: 'human', title: 'Review', profile: { kind: 'human' }, payload: { instruction: 'Inspect.' } }] });
  const broker = createBroker({ ...data, detail: 'full', executors: { canExecute: () => ({ ok: true }), execute: async () => { throw new Error('Human only'); }, notifyHuman: async () => {} } });
  data.cleanup(() => broker.close());
  const source = await broker.submitProject({ selection: { kind: 'all' } }), running = broker.run(source.id);
  for (let n = 0; !broker.getRequest(source.requests[0].id)!.notifiedAt; n++) { assert.ok(n < 100); await delay(10); }
  const follower = await broker.submitProject({ selection: { kind: 'all' } }), waiting = broker.run(follower.id);
  assert.equal(follower.requests.length, 0);
  await remote(data, `await broker.claimHuman(${JSON.stringify(source.requests[0].id)}, 'remote');`);
  assert.equal(broker.getRequest(source.requests[0].id)!.claimedBy, 'remote');
  await remote(data, `await broker.completeHuman(${JSON.stringify(source.requests[0].id)}, { reviewerId: 'remote', result: { verdict: 'GREEN' } });`);
  assert.equal((await running)!.status, 'GREEN');
  assert.equal((await waiting)!.status, 'GREEN');
});

test('real dispatch and completion hydrate linear metadata rather than every immutable manifest per transition', async t => {
  const data = await artifactFixture(t), count = 18;
  for (let n = 0; n < count; n++) {
    const tool = readTool(); tool.metadata.inputSchema = { type: 'object', properties: { value: { type: 'string', description: 'x'.repeat(24000) } } };
    await data.write(`a${n}`, { name: `a${n}`, views: { agentTools: { read: tool } }, critics: [runtimeCritic()] });
  }
  const broker = createBroker({ ...data, maxConcurrentExecutors: 6, executors: { canExecute: () => ({ ok: true }), execute: async () => { await delay(5); return { verdict: 'GREEN' }; } } });
  data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' }, force: true });
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite'));
  const stored = Number(db.prepare('SELECT sum(length(CAST(data AS BLOB))) AS bytes FROM requests').get()!.bytes); db.close();
  let bytes = 0; brokerTestHooks.onHydrate = value => { bytes += value; };
  t.after(() => { delete brokerTestHooks.onHydrate; });
  assert.equal((await broker.run(run.id))!.status, 'GREEN');
  assert.ok(bytes < stored * 20, `${bytes} hydrated bytes for ${stored} request bytes`);
  t.diagnostic(`Actual lifecycle: ${bytes} hydrated bytes / ${stored} persisted request bytes, ${count} Critics.`);
});

test('rolled-back completion never leaks cached semantic evidence into a later submission', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, detail: 'full', executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } });
  data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  const database = new DatabaseSync(join(data.stateDir, 'broker.sqlite')); t.after(() => database.close());
  // The GREEN request has already been read into the evidence cache when its
  // Run status event fails. No external commit may clear that cache afterward.
  database.exec("CREATE TRIGGER reject_green_event BEFORE INSERT ON events WHEN NEW.type = 'run.status' AND json_extract(NEW.data, '$.status') = 'GREEN' BEGIN SELECT RAISE(ABORT, 'injected completion rollback'); END");
  assert.equal((await broker.run(run.id))!.status, 'ERROR');
  assert.equal(broker.getRun(run.id)!.requests[0].result, null);
  const next = await broker.submitProject({ selection: { kind: 'all' } });
  assert.equal(next.status, 'QUEUED');
  assert.equal(next.requests.length, 1);
});

// Corrupt every nested JSON field, not just scope: snapshots, manifests, request
// attempts and results must all be detached at the public boundary.
function mutateView(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') mutateView(child);
    else (value as Record<string, unknown>)[key] = typeof child === 'number' ? -1 : typeof child === 'boolean' ? !child : 'forged';
  }
}

for (const method of ['submitProject', 'getRun', 'listRuns', 'run', 'terminalRun', 'cancel', 'failRun'] as const) {
  test(`mutating a full ${method} view cannot change cached reads or persisted state`, async t => {
    const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
    const broker = createBroker({ ...data, detail: 'full', executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } });
    data.cleanup(() => broker.close());
    const submitted = await broker.submitProject({ selection: { kind: 'all' } }), id = submitted.id;
    const view = method === 'submitProject' ? submitted : method === 'getRun' ? broker.getRun(id) : method === 'listRuns' ? broker.listRuns()[0] :
      method === 'run' ? await broker.run(id) : method === 'terminalRun' ? (await broker.run(id), await broker.run(id)) :
      method === 'cancel' ? broker.cancel(id) : broker.failRun(id, new Error('controlled failure'));
    const expected = structuredClone(broker.getRun(id)!);
    mutateView(view);
    assert.deepEqual(broker.getRun(id), expected, 'returned objects do not own cached state');
    broker.cancel(id); // Persist still-active cached Runs after the attempted mutation.
    const database = new DatabaseSync(join(data.stateDir, 'broker.sqlite'), { readOnly: true });
    try {
      const stored = JSON.parse(String(database.prepare('SELECT data FROM runs WHERE id = ?').get(id)!.data));
      for (const key of ['scope', 'workspace', 'graph'] as const) assert.deepEqual(stored[key], expected[key], key);
      for (const key of ['snapshot', 'selection', 'templates'] as const) assert.deepEqual(stored.project[key], expected.project![key], key);
    } finally { database.close(); }
    if (expected.status === 'GREEN') {
      const reused = await broker.submitProject({ selection: { kind: 'all' } });
      assert.equal(reused.status, 'GREEN', 'mutated returned results do not corrupt evidence');
      assert.equal(reused.requests.length, 0);
    }
  });
}

test('workspace adapter cannot mutate a cached Run descriptor', async t => {
  const { prepareWorkspace, reopenWorkspace } = await import('../src/workspaces/index.js');
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, detail: 'full', workspaceAdapter: { prepareWorkspace, async reopenWorkspace(descriptor, options) {
    const workspace = await reopenWorkspace(descriptor, options);
    descriptor.hash = 'forged';
    return workspace;
  } }, executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } });
  data.cleanup(() => broker.close());
  const submitted = await broker.submitProject({ selection: { kind: 'all' } });
  assert.equal((await broker.run(submitted.id))!.status, 'GREEN');
  assert.deepEqual(broker.getRun(submitted.id)!.workspace, submitted.workspace);
  const database = new DatabaseSync(join(data.stateDir, 'broker.sqlite'), { readOnly: true });
  try { assert.deepEqual(JSON.parse(String(database.prepare('SELECT data FROM runs WHERE id = ?').get(submitted.id)!.data)).workspace, submitted.workspace); }
  finally { database.close(); }
});
