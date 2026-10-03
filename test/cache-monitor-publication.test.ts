import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startMonitor } from '../src/monitor/server.js';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { ownProcessIdentity } from '../src/broker/ownership.js';
import { createBroker } from '../src/broker/index.js';
import { readIdentityCache, identityCacheDirectory } from '../src/cache/index.js';
import { projectRun, projectRequestState } from '../src/project/store.js';
import { createMonitorStore } from '../src/monitor/store.js';
import { projectRunState } from '../src/project/results.js';

const base = tmpdir();
const critic = { id: 'review', title: 'Controlled review', profile: { kind: 'runtime' as const, command: 'node', args: ['--version'], timeoutMs: 5000 }, payload: { instruction: 'Controlled executor.' } };
const until = async (predicate: () => boolean | Promise<boolean>) => {
  const end = Date.now() + 10000;
  while (!await predicate()) { if (Date.now() > end) throw new Error('Barrier timed out.'); await delay(10); }
};
async function rejectedOwner(t: TestContext, pending = false, accepted = false) {
  const root = await fs.mkdtemp(join(base, 'rejected-evidence-'));
  const previous = { state: process.env.CCDD_STATE_HOME, config: process.env.CCDD_CONFIG_HOME };
  process.env.CCDD_STATE_HOME = join(root, 'machine'); process.env.CCDD_CONFIG_HOME = join(root, 'config');
  await fs.mkdir(process.env.CCDD_CONFIG_HOME);
  await fs.writeFile(join(process.env.CCDD_CONFIG_HOME, 'resources.json'), JSON.stringify({ identityCapacity: 100, defaultProviderCapacity: 4 }));
  let release!: () => void, started = false, releaseCleanup!: () => void, cleaning!: () => void;
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const cleanupStarted = new Promise<void>(resolve => { cleaning = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const brokers: ReturnType<typeof createBroker<'full'>>[] = [];
  let db: DatabaseSync | undefined;
  t.after(async () => {
    release(); releaseCleanup(); db?.prepare("DELETE FROM cache_subscribers WHERE id='audit-reader'").run();
    await Promise.all(brokers.map(broker => broker.close())); db?.close();
    for (const [key, value] of [['CCDD_STATE_HOME', previous.state], ['CCDD_CONFIG_HOME', previous.config]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const name of ['owner', 'follower']) {
    await fs.mkdir(join(root, name));
    await fs.writeFile(join(root, name, 'ccdd.json'), JSON.stringify({ name, stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } }, critics: [critic] }));
  }
  const ownerPath = join(root, 'owner'), followerPath = join(root, 'follower');
  await fs.writeFile(join(ownerPath, 'input.txt'), 'audit-identity');
  await fs.writeFile(join(ownerPath, 'identity.mjs'), "import{readFileSync}from'node:fs';console.log(readFileSync('input.txt','utf8'));\n");
  await fs.writeFile(join(followerPath, 'identity.mjs'), "console.log('audit-identity');\n");
  const owner = createBroker({ repoPath: ownerPath, stateDir: join(root, 'owner-state'), repoId: 'owner', detail: 'full',
    admission: { acquire: async () => ({ release: async () => { if (pending) { cleaning(); await cleanupGate; } } }) }, executors: {
    canExecute: () => ({ ok: true }), execute: async () => { started = true; await gate; return { verdict: 'GREEN' }; },
  } });
  const follower = createBroker({ repoPath: followerPath, stateDir: join(root, 'follower-state'), repoId: 'follower', detail: 'full', executors: {
    canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'RED' }),
  } });
  brokers.push(owner, follower);
  const first = await owner.submitProject({ selection: { kind: 'all' } }), runningOwner = owner.run(first.id);
  await until(() => started);
  const second = await follower.submitProject({ selection: { kind: 'all' } }), runningFollower = follower.run(second.id);
  await until(() => follower.getRun(second.id)!.requests[0].cacheDisposition === 'coalesced');
  const source = follower.getRun(second.id)!.requests[0].executionSource!;
  db = new DatabaseSync(join(identityCacheDirectory(), 'cache.sqlite'));
  // A still-attached live reader keeps the rejected execution audit queryable, just as a
  // cross-process subscriber which has not observed/detached the terminal row yet does.
  db.prepare('INSERT INTO cache_subscribers VALUES(?,?,?,?)').run('audit-reader', source.executionId, process.pid, ownProcessIdentity);
  owner.cancel(first.id); await runningOwner;
  if (!accepted) await fs.writeFile(join(ownerPath, 'input.txt'), 'different-identity');
  release();
  if (pending) { await cleanupStarted; return { root, owner, follower, first, second, source, ownerPath, followerPath, releaseCleanup, runningFollower }; }
  await runningFollower;
  if (!accepted) {
    assert.equal(follower.getRun(second.id)!.requests[0].errorCode, 'WORKSPACE_CHANGED');
    assert.equal(readIdentityCache('audit-identity'), null);
    assert.equal(db.prepare('SELECT state FROM cache_jobs WHERE id=?').get(source.executionId)!.state, 'ERROR');
  }
  return { root, owner, follower, first, second, source, ownerPath, followerPath, releaseCleanup, runningFollower };
}


test('monitor distinguishes rejected owner audit from accepted evidence', { timeout: 15000 }, async t => {
  const f = await rejectedOwner(t);
  const publication = projectRun(f.source.stateDir, f.source.runId)!.publication;
  assert.equal(publication!.state, 'rejected');
  const monitor = createMonitorStore({ stateDirs: [f.source.stateDir] });
  const overview = await monitor.overview();
  const request = overview.requests.find(request => request.id === f.source.requestId)!;
  const detail = await monitor.detail(request.projectId, request.id);
  assert.deepEqual(projectRequestState(f.source.stateDir, f.source.requestId)!.publication, publication);
  assert.deepEqual(request.publication, publication);
  assert.equal(request.rawStatus, 'GREEN'); assert.equal(request.status, 'ERROR');
  assert.equal(projectRunState(f.source.stateDir, f.source.runId), 'ERROR');
  assert.equal(overview.laneCounts.success, 0); assert.equal(overview.laneCounts.failure, 1);
  assert.equal(overview.counts.attention, 1); assert.equal(overview.counts.active, 0);
  assert.match(request.waitingReason!, /WORKSPACE_CHANGED/);
  assert.equal((await monitor.overview({ filter: 'attention' })).total, 1);
  assert.equal((await monitor.overview({ lane: 'success' })).total, 0);
  assert.deepEqual((await monitor.runs()).runs[0].publication, publication);
  assert.equal((await monitor.runs()).runs[0].status, 'ERROR');
  assert.deepEqual(detail!.publication, publication); assert.deepEqual(detail!.request.publication, publication);
  assert.deepEqual(Reflect.get((await monitor.request(request.projectId, request.id))!.request, 'publication'), publication);
  const server = await startMonitor({ stateDirs: [f.source.stateDir], port: 0 });
  try {
    const overviewHttp = await fetch(`${server.url}/api/requests`).then(response => response.json()) as typeof overview;
    assert.equal(overviewHttp.laneCounts.success, 0);
    assert.deepEqual(overviewHttp.requests[0].publication, publication);
    const detailHttp = await fetch(`${server.url}/api/requests/${request.projectId}/${request.id}`).then(response => response.json()) as NonNullable<typeof detail>;
    assert.deepEqual(detailHttp.publication, publication);
    assert.equal(detailHttp.result!.verdict, 'GREEN');
  } finally { await server.close(); }
  assert.equal(detail!.result!.verdict, 'GREEN', 'Audit may preserve the reviewer verdict');
  assert.deepEqual(Reflect.get(detail!, 'publication') ?? Reflect.get(detail!.result!, 'publication'), publication, 'The monitor must distinguish a rejected audit verdict from accepted evidence');
});

test('monitor places a pending raw verdict in attention and never counts it as success', { timeout: 15000 }, async t => {
  const f = await rejectedOwner(t, true);
  const monitor = createMonitorStore({ stateDirs: [f.source.stateDir] }), overview = await monitor.overview();
  const request = overview.requests[0], detail = (await monitor.detail(request.projectId, request.id))!;
  assert.equal(request.status, 'RUNNING'); assert.equal(request.rawStatus, 'GREEN');
  assert.equal(projectRunState(f.source.stateDir, f.source.runId), 'RUNNING');
  assert.deepEqual(request.publication, { state: 'pending' });
  assert.equal(overview.laneCounts.success, 0); assert.equal(overview.laneCounts.running, 1);
  assert.equal(overview.counts.attention, 1); assert.equal(overview.counts.active, 1);
  assert.match(request.waitingReason!, /Publication pending/);
  assert.equal(detail.result!.verdict, 'GREEN'); assert.equal(detail.publication!.state, 'pending');
  assert.equal((await monitor.runs()).runs[0].status, 'RUNNING');
  f.releaseCleanup(); await f.runningFollower;
});

test('monitor retains the success lane for an accepted owner verdict', { timeout: 15000 }, async t => {
  const f = await rejectedOwner(t, false, true), monitor = createMonitorStore({ stateDirs: [f.source.stateDir] });
  const overview = await monitor.overview(), request = overview.requests[0];
  assert.equal(request.status, 'GREEN'); assert.deepEqual(request.publication, { state: 'accepted' });
  assert.equal(overview.laneCounts.success, 1); assert.equal(overview.counts.attention, 0);
  assert.equal((await monitor.runs()).runs[0].status, 'GREEN');
  assert.equal((await monitor.detail(request.projectId, request.id))!.result!.verdict, 'GREEN');
});
