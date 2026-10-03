import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { ownProcessIdentity } from '../src/broker/ownership.js';
import { createBroker } from '../src/broker/index.js';
import { openIdentityCache, readIdentityCache, identityCacheDirectory, type CachedReview } from '../src/cache/index.js';
import { projectRun, projectHistory, projectRequests, projectRuns } from '../src/project/store.js';
import { projectRunSummary, projectRequestSummary, projectChanges, streamProjectResults } from '../src/project/results.js';
import { inspectProject, queryProject, planProject } from '../src/project/index.js';
import { listIdentityCache, compareIdentityCache } from '../src/cache/query.js';
import { main as cliMain } from '../src/project/cli.js';

const base = tmpdir();
const critic = { id: 'review', title: 'Controlled review', profile: { kind: 'runtime' as const, command: 'node', args: ['--version'], timeoutMs: 5000 }, payload: { instruction: 'Controlled executor.' } };
const until = async (predicate: () => boolean | Promise<boolean>) => {
  const end = Date.now() + 10000;
  while (!await predicate()) { if (Date.now() > end) throw new Error('Barrier timed out.'); await delay(10); }
};
async function cli(args: string[]) {
  let stdout = '', stderr = '';
  const code = await cliMain(args, { stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  return { code, stdout, stderr };
}
async function ownerFixture(t: TestContext, publication: 'accepted' | 'rejected' | 'pending' = 'rejected', verdict: 'GREEN' | 'RED' = 'GREEN') {
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
    admission: { acquire: async () => ({ release: async () => { if (publication === 'pending') { cleaning(); await cleanupGate; } } }) }, executors: {
    canExecute: () => ({ ok: true }), execute: async () => { started = true; await gate; return { verdict }; },
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
  if (publication === 'rejected') await fs.writeFile(join(ownerPath, 'input.txt'), 'different-identity');
  release();
  if (publication === 'pending') await cleanupStarted;
  else await runningFollower;
  if (publication === 'rejected') {
    assert.equal(follower.getRun(second.id)!.requests[0].errorCode, 'WORKSPACE_CHANGED');
    assert.equal(readIdentityCache('audit-identity'), null);
    assert.equal(db.prepare('SELECT state FROM cache_jobs WHERE id=?').get(source.executionId)!.state, 'ERROR');
  }
  return { root, owner, follower, first, second, source, ownerPath, followerPath, db, releaseCleanup, runningFollower };
}

test('rejected owner audit never supplies a reusable or successful current-input plan', { timeout: 15000 }, async t => {
  const f = await ownerFixture(t);
  const audit = projectRun(f.source.stateDir, f.source.runId)!;
  const history = projectHistory(f.source.stateDir, { detail: 'full' });
  const ownQuery = queryProject(audit.project!.snapshot, history, { runId: audit.id, stateDir: f.source.stateDir, detail: 'full' });
  const ownPlan = planProject(audit.project!.snapshot, history, { runId: audit.id, stateDir: f.source.stateDir, detail: 'full' });
  const show = await cli(['run', 'show', f.source.runId, '--state-dir', f.source.stateDir, '--json']);
  const summary = projectRunSummary(f.source.stateDir, f.source.runId)!;
  const stream = [];
  for await (const result of streamProjectResults(f.source.stateDir, f.source.runId)) stream.push(result);

  const publication = { state: 'rejected', code: 'WORKSPACE_CHANGED', message: 'Shared computation failed; inspect the original execution diagnostics.' };
  assert.equal(audit.status, 'GREEN', 'Keep the original reviewer verdict as audit.');
  assert.deepEqual(audit.publication, publication);
  assert.equal(audit.requests[0].result!.verdict, 'GREEN');
  assert.equal(audit.validation!.satisfied, false);
  assert.equal(audit.validation!.counts.reuse, 0);
  assert.equal(audit.validation!.counts.failed, 1);
  assert.equal(history.length, 1, 'Retain the rejected verdict in audit history.');
  assert.equal(history[0].verdict, 'GREEN');
  assert.deepEqual(history[0].publication, publication);
  assert.equal(ownQuery.satisfied, false, 'a publication-rejected owner verdict must not be accepted as matching successful evidence');
  assert.equal(ownPlan.counts.reuse, 0);
  assert.ok(ownPlan.items.every(item => item.action !== 'REUSE' && item.result === null));
  assert.deepEqual(JSON.parse(show.stdout).publication, publication);
  assert.equal(JSON.parse(show.stdout).validation.satisfied, false);
  assert.equal(summary.status, 'GREEN');
  assert.deepEqual(summary.publication, publication);
  assert.deepEqual(projectRuns(f.source.stateDir)[0].publication, publication);
  assert.deepEqual(projectRequests(f.source.stateDir)[0].publication, publication);
  assert.deepEqual(projectRequests(f.source.stateDir)[0].result!.publication, publication);
  const reopened = createBroker({ repoPath: f.ownerPath, stateDir: f.source.stateDir, repoId: 'cache-execution' });
  try {
    assert.deepEqual(reopened.getRun(f.source.runId)!.publication, publication);
    assert.deepEqual(reopened.getRequest(f.source.requestId)!.publication, publication);
    assert.deepEqual(reopened.changes(f.source.runId)!.publication, publication);
  } finally { await reopened.close(); }
  assert.ok(stream.length > 0);
  for (const result of stream) { assert.deepEqual(result.publication, publication); assert.equal(result.result!.verdict, 'GREEN'); assert.deepEqual(result.result!.publication, publication); }
  const plain = await cli(['run', 'show', f.source.runId, '--state-dir', f.source.stateDir]);
  assert.deepEqual(JSON.parse(plain.stdout).publication, publication);
  assert.deepEqual(projectRequestSummary(f.source.stateDir, f.source.requestId)!.publication, publication);
  assert.deepEqual(projectChanges(f.source.stateDir, f.source.runId)!.publication, publication);
  assert.match((await cli(['history', '--state-dir', f.source.stateDir])).stdout, /publication: rejected \(WORKSPACE_CHANGED\)/);
  const cliStream = await cli(['run', 'stream', f.source.runId, '--state-dir', f.source.stateDir]);
  assert.equal(cliStream.code, 2, 'Rejected audit is not a successful stream outcome.');
  for (const line of cliStream.stdout.trim().split('\n')) assert.deepEqual(JSON.parse(line).publication, publication);
  assert.deepEqual(JSON.parse((await cli(['request', 'show', f.source.requestId, '--state-dir', f.source.stateDir, '--json'])).stdout).publication, publication);
  const compact = projectHistory(f.source.stateDir);
  assert.deepEqual(compact[0].publication, publication);
  const otherProcess = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { projectRun, projectHistory, projectRequests, projectRuns } from ${JSON.stringify(new URL('../src/project/store.js', import.meta.url).href)};
    import { queryProject, planProject } from ${JSON.stringify(new URL('../src/project/query.js', import.meta.url).href)};
    const run=projectRun(${JSON.stringify(f.source.stateDir)},${JSON.stringify(f.source.runId)});
    const history=projectHistory(${JSON.stringify(f.source.stateDir)},{detail:'full'});
    console.log(JSON.stringify({publication:run.publication,validation:run.validation.satisfied,
      satisfied:queryProject(run.project.snapshot,history,{runId:run.id}).satisfied,
      reuse:planProject(run.project.snapshot,history,{runId:run.id}).counts.reuse}));
  `], { encoding: 'utf8', env: { ...process.env, CCDD_STATE_HOME: join(f.root, 'different-reader-state') } }));
  assert.deepEqual(otherProcess, { publication, validation: false, satisfied: false, reuse: 0 });
});

test('subscriber show/summary/stream cache queries status recovery and later joins use publication not owner audit', { timeout: 15000 }, async t => {
  const f = await ownerFixture(t), stateDir = join(f.root, 'follower-state');
  assert.equal(f.follower.getRun(f.second.id)!.status, 'ERROR');
  assert.equal(JSON.parse((await cli(['run', 'show', f.second.id, '--state-dir', stateDir, '--json'])).stdout).status, 'ERROR');
  assert.equal(projectRunSummary(stateDir, f.second.id)!.status, 'ERROR');
  for await (const result of streamProjectResults(stateDir, f.second.id)) { assert.notEqual(result.status, 'GREEN'); assert.equal(result.result, null); }
  assert.equal(listIdentityCache().items.length, 0);
  assert.equal(compareIdentityCache('audit-identity', 'different-identity').left, null);
  const plan = await inspectProject({ repoPath: f.followerPath, stateDir, selection: { kind: 'all' }, detail: 'full' });
  assert.equal(plan.plan.counts.reuse, 0); assert.equal(plan.plan.counts.execute, 1); assert.equal(plan.plan.satisfied, false);
  assert.equal((await cli(['status', '--all', '--state-dir', stateDir, '--json'])).code, 1);
  assert.equal((await cli(['verify', '--all', '--max-executions', '0', '--state-dir', stateDir, '--json'])).code, 2);
  const showCache = await cli(['cache', 'show', 'audit-identity', '--json']);
  assert.equal(showCache.code, 4); assert.equal(JSON.parse(showCache.stdout), null);
  const resume = await cli(['run', 'resume', f.second.id, '--state-dir', stateDir, '--json']);
  assert.equal(JSON.parse(resume.stdout).status, 'ERROR');
  await assert.rejects(f.follower.submitProject({ selection: { kind: 'all' }, maxExecutions: 0 }), { code: 'EXECUTION_BUDGET_EXCEEDED' });
  assert.equal(readIdentityCache('audit-identity'), null);
  const retry = await f.follower.submitProject({ selection: { kind: 'all' } }); await f.follower.run(retry.id);
  assert.equal(f.follower.getRun(retry.id)!.status, 'RED');
  assert.notEqual(f.follower.getRun(retry.id)!.requests[0].executionSource?.executionId, f.source.executionId);
  assert.equal(readIdentityCache('audit-identity')!.value.result.verdict, 'RED');
});

test('a busy publication retry reruns acceptance and rejects an identity changed during backoff', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(join(base, 'accept-retry-'));
  const cache = openIdentityCache({ directory: root });
  const writer = new DatabaseSync(join(root, 'cache.sqlite'));
  let accepts = 0, identity = 'original', locked = false, started = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => { release(); if (locked) writer.exec('ROLLBACK'); await cache.close(); writer.close(); await fs.rm(root, { recursive: true, force: true }); });
  const value: CachedReview = { result: { verdict: 'GREEN' }, profile: critic.profile, origin: { runId: 'controlled', requestId: 'controlled' }, attemptId: null, executionProvenance: null };
  const computation = cache.compute('retry-key', async () => { started = true; await gate; return value; }, { accept: async () => {
    accepts++;
    if (identity !== 'original') throw Object.assign(new Error('Controlled change'), { code: 'WORKSPACE_CHANGED' });
    if (accepts === 1) { writer.exec('BEGIN IMMEDIATE'); locked = true; }
  } });
  const rejected = assert.rejects(computation, { code: 'WORKSPACE_CHANGED' });
  await until(() => started); release();
  await until(() => accepts === 1); identity = 'changed'; writer.exec('ROLLBACK'); locked = false;
  await rejected;
  assert.equal(accepts, 2); assert.equal(cache.get('retry-key'), null);
});

for (const verdict of ['GREEN', 'RED'] as const) test(`accepted ${verdict} owner audit remains eligible evidence after cache reopen`, { timeout: 15000 }, async t => {
  const f = await ownerFixture(t, 'accepted', verdict);
  await f.owner.close();
  f.db.prepare("DELETE FROM cache_subscribers WHERE id='audit-reader'").run();
  const cache = openIdentityCache();
  try { assert.equal((await cache.gc()).needsMore, false, 'Retained accepted audits must not create an endless GC backlog.'); } finally { await cache.close(); }
  const audit = projectRun(f.source.stateDir, f.source.runId)!, history = projectHistory(f.source.stateDir, { detail: 'full' });
  assert.deepEqual(audit.publication, { state: 'accepted' });
  assert.deepEqual(history[0].publication, { state: 'accepted' });
  assert.equal(history[0].verdict, verdict);
  const plan = planProject(audit.project!.snapshot, history, { runId: audit.id, stateDir: f.source.stateDir });
  assert.equal(plan.counts.reuse, 1);
  assert.equal(plan.satisfied, verdict === 'GREEN');
});

test('a raw owner verdict stays pending until publication and cannot satisfy or reuse', { timeout: 15000 }, async t => {
  const f = await ownerFixture(t, 'pending');
  const audit = projectRun(f.source.stateDir, f.source.runId)!, history = projectHistory(f.source.stateDir, { detail: 'full' });
  assert.equal(audit.requests[0].result!.verdict, 'GREEN');
  assert.deepEqual(audit.publication, { state: 'pending' });
  assert.deepEqual(history[0].publication, { state: 'pending' });
  assert.equal(audit.validation!.satisfied, false);
  assert.equal(audit.validation!.counts.active, 1);
  assert.equal(queryProject(audit.project!.snapshot, history, { runId: audit.id, stateDir: f.source.stateDir }).satisfied, false);
  assert.equal(planProject(audit.project!.snapshot, history, { runId: audit.id, stateDir: f.source.stateDir }).counts.reuse, 0);
  assert.equal(projectRunSummary(f.source.stateDir, f.source.runId)!.publication!.state, 'pending');
  const pendingResults = [];
  for await (const result of streamProjectResults(f.source.stateDir, f.source.runId)) pendingResults.push(result);
  assert.equal(pendingResults.length, 1);
  assert.equal(pendingResults[0].publication!.state, 'pending');
  f.releaseCleanup(); await f.runningFollower;
  assert.deepEqual(projectRun(f.source.stateDir, f.source.runId)!.publication, { state: 'accepted' });
});

test('a dead publication owner is rejected without mutating its raw verdict or cache', { timeout: 15000 }, async t => {
  const f = await ownerFixture(t, 'pending');
  f.db.prepare('UPDATE cache_jobs SET pid=2147483647,process_identity=NULL WHERE id=?').run(f.source.executionId);
  const audit = projectRun(f.source.stateDir, f.source.runId)!, history = projectHistory(f.source.stateDir, { detail: 'full' });
  assert.equal(audit.requests[0].result!.verdict, 'GREEN');
  assert.equal(audit.publication!.state, 'rejected');
  assert.equal(audit.publication!.code, 'COMPUTE_OWNER_EXITED');
  assert.equal(audit.validation!.satisfied, false);
  assert.equal(planProject(audit.project!.snapshot, history, { runId: audit.id, stateDir: f.source.stateDir }).counts.reuse, 0);
  assert.equal(f.db.prepare('SELECT state FROM cache_jobs WHERE id=?').get(f.source.executionId)!.state, 'RUNNING', 'Audit reads do not reconcile or write.');
  f.db.prepare('UPDATE cache_jobs SET pid=?,process_identity=? WHERE id=?').run(process.pid, ownProcessIdentity, f.source.executionId);
  f.releaseCleanup(); await f.runningFollower;
});

test('unavailable publication metadata fails closed without erasing audit history', { timeout: 15000 }, async t => {
  const f = await ownerFixture(t, 'accepted');
  f.db.prepare('DELETE FROM cache_jobs WHERE id=?').run(f.source.executionId);
  f.db.prepare('DELETE FROM cache_entries WHERE identity=?').run('audit-identity');
  const audit = projectRun(f.source.stateDir, f.source.runId)!, history = projectHistory(f.source.stateDir, { detail: 'full' });
  assert.equal(audit.publication!.state, 'pending');
  assert.equal(audit.publication!.code, 'PUBLICATION_UNAVAILABLE');
  assert.equal(history[0].verdict, 'GREEN');
  assert.equal(history[0].publication!.code, 'PUBLICATION_UNAVAILABLE');
  assert.equal(queryProject(audit.project!.snapshot, history, { runId: audit.id, stateDir: f.source.stateDir }).satisfied, false);
});

test('a rejected job survives subscriber detach until its audit storage is retired', { timeout: 15000 }, async t => {
  const f = await ownerFixture(t);
  await f.owner.close();
  f.db.prepare("DELETE FROM cache_subscribers WHERE id='audit-reader'").run();
  assert.equal(f.db.prepare('SELECT state FROM cache_jobs WHERE id=?').get(f.source.executionId)!.state, 'ERROR');
  assert.equal(projectRun(f.source.stateDir, f.source.runId)!.publication!.code, 'WORKSPACE_CHANGED');
  const cache = openIdentityCache();
  try { await cache.gc(); } finally { await cache.close(); }
  assert.equal(f.db.prepare('SELECT state FROM cache_jobs WHERE id=?').get(f.source.executionId), undefined);
  await assert.rejects(fs.access(f.source.stateDir), { code: 'ENOENT' });
});
