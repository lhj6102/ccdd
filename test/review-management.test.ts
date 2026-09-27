import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { artifactFixture, fixtureViews, agentProfile, runtimeCritic } from './helpers/artifacts.js';
import { createBroker } from '../src/broker/index.js';
import { inspectProject, queryProject } from '../src/project/index.js';
import { projectHistory } from '../src/project/store.js';
import { createReviewTools } from '../src/tools/runner.js';
import { resourcePaths } from '../src/resources.js';
import { loadCheck } from '../src/project/load-check.js';
import { readWorkerConfiguration } from '../src/worker-client.js';
import { main } from '../src/project/cli.js';

async function fixture(t: test.TestContext) {
  const data = await artifactFixture(t);
  const previous = { state: process.env.CCDD_STATE_HOME, config: process.env.CCDD_CONFIG_HOME };
  process.env.CCDD_STATE_HOME = join(data.root, 'machine'); process.env.CCDD_CONFIG_HOME = join(data.root, 'config'); await mkdir(process.env.CCDD_CONFIG_HOME);
  await writeFile(resourcePaths().config, JSON.stringify({ defaultProviderCapacity: 4 }));
  data.cleanup(() => { for (const [name, value] of [['CCDD_STATE_HOME', previous.state], ['CCDD_CONFIG_HOME', previous.config]]) { if (value === undefined) delete process.env[name!]; else process.env[name!] = value; } });
  return data;
}
const simple = { canExecute: () => ({ ok: true as const }), execute: async () => ({ verdict: 'GREEN' as const }) };

test('durable submission budget survives retry and zero permits only existing reuse/coalescing', async t => {
  const data = await fixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  let starts = 0;
  const broker = createBroker({ detail: 'full', ...data, executors: { ...simple, execute: async () => { starts++; throw new Error('operational failure'); } } }); data.cleanup(() => broker.close());
  await assert.rejects(broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 0 }), /Plan requires 1/); assert.equal(broker.listRuns().length, 0);
  const run = await broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 1 }); await broker.run(run.id);
  assert.equal(starts, 1); assert.equal(broker.executionBudget(run.id)!.attempts[0].state, 'terminal');
  broker.retryRequest(broker.getRun(run.id)!.requests[0].id); await broker.run(run.id);
  assert.equal(starts, 1); assert.equal(broker.getRun(run.id)!.requests[0].errorCode, 'EXECUTION_BUDGET_EXHAUSTED');
});

test('coalescing expiry charges receiver budget instead of reusing source allowance', async t => {
  const data = await fixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ detail: 'full', ...data, coalescingGraceMs: 80, executors: simple }); data.cleanup(() => broker.close());
  await broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 1 });
  const receiver = await broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 0 });
  assert.equal(receiver.requests.length, 0); await delay(100); await broker.run(receiver.id);
  assert.equal(broker.getRun(receiver.id)!.requests[0].errorCode, 'EXECUTION_BUDGET_EXHAUSTED'); assert.equal(broker.executionBudget(receiver.id)!.attempts.length, 0);
});

test('custom admission is only a precondition and cannot bypass the machine cap or budget', async t => {
  const data = await fixture(t); await writeFile(resourcePaths().config, JSON.stringify({ defaultProviderCapacity: 1 }));
  await data.write('a', { name: 'a', critics: [runtimeCritic('one'), runtimeCritic('two')] });
  let active = 0, peak = 0, admissions = 0;
  const broker = createBroker({ ...data, admission: { async acquire() { admissions++; return { release() {} }; } }, executors: { ...simple, async execute() { active++; peak = Math.max(active, peak); await delay(30); active--; return { verdict: 'GREEN' }; } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 2 }); await broker.run(run.id);
  assert.equal(peak, 1); assert.equal(admissions, 2);
});

test('root policy consistently controls inspect, query, submission and readiness without changing SCC behavior', async t => {
  const data = await fixture(t);
  await data.write('', { name: 'root', reviewPolicy: { dependencyGates: 'ignore', maxConcurrentExecutors: 1 }, critics: [runtimeCritic()] });
  await data.write('child', { name: 'child', critics: [runtimeCritic()] });
  const inspection = await inspectProject({ detail: 'full', ...data }); assert.equal(inspection.plan.counts.execute, 2); assert.equal(inspection.plan.counts.gated, 0);
  assert.equal(queryProject(inspection.snapshot, [], { stateDir: data.stateDir }).critics.find(critic => critic.id === 'root/check')!.canExecute, true);
  const gated = await inspectProject({ detail: 'full', ...data, ignoreGates: false }); assert.equal(gated.plan.counts.gated, 1);
  let active = 0, peak = 0;
  const broker = createBroker({ detail: 'full', ...data, executors: { ...simple, async execute() { active++; peak = Math.max(peak, active); await delay(30); active--; return { verdict: 'GREEN' }; } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); assert.equal(run.project!.ignoreGates, true); await broker.run(run.id); assert.equal(peak, 1);
});

test('capacity and owner weight never alter semantic keys and oversize fails before any script', async t => {
  const data = await fixture(t), marker = join(data.root, 'script-ran');
  await data.write('a', { name: 'a', stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } }, critics: [runtimeCritic()] }, { 'identity.mjs': `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'yes');console.log('semantic');` });
  await data.write('plain', { name: 'plain', critics: [runtimeCritic()] });
  const before = (await inspectProject({ detail: 'full', ...data })).snapshot;
  await data.edit('a', value => { if (value.stale?.kind === 'identity') value.stale.weight = 100; });
  await writeFile(resourcePaths().config, JSON.stringify({ identityCapacity: 200, defaultProviderCapacity: 60 }));
  const after = (await inspectProject({ detail: 'full', ...data })).snapshot;
  assert.equal(before.inputs['a/check'].key, after.inputs['a/check'].key); assert.equal(before.inputs['plain/check'].key, after.inputs['plain/check'].key);
  await rm(marker); await writeFile(resourcePaths().config, JSON.stringify({ identityCapacity: 50 }));
  await assert.rejects(inspectProject({ ...data }), /exceeds local identityCapacity/); await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.throws(() => createBroker({ ...data, identityConcurrency: 4 }), /was removed/);
});

async function provenanceFixture(t: test.TestContext) {
  const data = await fixture(t), views = fixtureViews();
  views.agentTools!.read.metadata.resultKinds = ['text'];
  views.agentTools!.read.script.args = ['../runtime/view.mjs']; views.agentTools!.read.metadata.executionPaths = ['runtime'];
  await mkdir(join(data.repoPath, 'runtime'));
  const source = `import {readFileSync} from 'node:fs';for await(const chunk of process.stdin){};console.log(JSON.stringify({content:[{type:'text',text:readFileSync(new URL('./binary',import.meta.url),'utf8')}],observation:{kind:'content'}}));`;
  await writeFile(join(data.repoPath, 'runtime/view.mjs'), source); await writeFile(join(data.repoPath, 'runtime/binary'), 'original binary'); await chmod(join(data.repoPath, 'runtime/binary'), 0o755);
  await data.write('a', { name: 'a', views, stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } }, critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read content.' } }] }, { 'identity.mjs': "console.log('stable-semantic')" });
  return data;
}

test('actual pinned bytes produce immutable raw/structural provenance across compact changes and old reuse', async t => {
  const data = await provenanceFixture(t); let observed = '';
  const broker = createBroker({ detail: 'full', ...data, executors: { ...simple, async execute(request, context) {
    const tools = await createReviewTools({ ...request, ...context, audience: 'agent' });
    try { const result = await tools.call('read_a', {}); observed = result.content[0].type === 'text' ? result.content[0].text : ''; return { verdict: 'GREEN', toolCalls: tools.toolCalls }; } finally { await tools.close(); }
  } } }); data.cleanup(() => broker.close());
  const first = await broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 1 }); await broker.run(first.id); assert.equal(broker.getRun(first.id)!.status, 'GREEN', JSON.stringify(broker.getRun(first.id)!.requests.map(request => ({error:request.error,code:request.errorCode})))); assert.equal(observed, 'original binary');
  const provenance = broker.getRun(first.id)!.requests[0].executionProvenance!; const raw = provenance.files.find(file => file.path === 'runtime/binary')!;
  assert.equal(raw.rawContentSha256, createHash('sha256').update('original binary').digest('hex')); assert.equal(raw.executable, 0o111);
  assert.notEqual(provenance.inputs[0].structuralSha256, raw.rawContentSha256);
  const changes = broker.changes(first.id)!.changes.filter(change => change.result); assert.deepEqual(changes.at(-1)!.result!.executionProvenance, provenance);
  await writeFile(join(data.repoPath, 'runtime/binary'), 'new session binary');
  const reused = await broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 0 }); assert.equal(reused.requests.length, 0);
  const compact = await inspectProject({ ...data }); assert.deepEqual(compact.plan.results[0].executionProvenance, provenance); assert.deepEqual(compact.plan.items[0].result!.executionProvenance, provenance);
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite')); const row = db.prepare('SELECT data FROM requests WHERE id=?').get(first.requests[0].id)!; const header = JSON.parse(String(row.data)); delete header.executionProvenance; db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(header), first.requests[0].id); db.close();
  assert.equal(projectHistory(data.stateDir)[0].executionProvenance, null);
});

test('runtime replacement after capture never runs changed bytes under the original provenance', async t => {
  const data = await provenanceFixture(t); let observed = '';
  const broker = createBroker({ detail: 'full', ...data, executors: { ...simple, async execute(request, context) {
    const tools = await createReviewTools({ ...request, ...context, audience: 'agent' });
    try {
      await writeFile(join(data.repoPath, 'runtime/binary'), 'replacement');
      const result = await tools.call('read_a', {}); observed = result.content[0].type === 'text' ? result.content[0].text : ''; return { verdict: 'GREEN', toolCalls: tools.toolCalls };
    } finally { await tools.close(); }
  } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(run.id);
  assert.notEqual(observed, 'replacement'); assert.notEqual(broker.getRun(run.id)!.status, 'GREEN');
});

test('runtime declaration rejects external symlinks instead of recording invented file hashes', async t => {
  const data = await provenanceFixture(t); await rm(join(data.repoPath, 'runtime/binary')); await symlink('/bin/sh', join(data.repoPath, 'runtime/binary'));
  await assert.rejects(inspectProject({ ...data }), /symlink.*stay inside/);
});

test('old workers cannot resume and obsolete CLI identity options fail actionably', async t => {
  const data = await fixture(t); await mkdir(join(data.stateDir, 'runs', 'old'), { recursive: true });
  await writeFile(join(data.stateDir, 'runs', 'old', 'worker.json'), JSON.stringify({ humanInbox: false, maxConcurrentExecutors: 4 }));
  await assert.rejects(readWorkerConfiguration(data.stateDir, 'old'), /Old saved worker configuration/);
  let error = ''; assert.equal(await main(['plan', '--all', '--identity-concurrency', '4'], { stdout: { write() {} }, stderr: { write(value) { error += value; } } }), 2); assert.match(error, /identityCapacity/);
});

test('offline load-check performs real guarded tool calls and cannot supply production evidence', async t => {
  const data = await fixture(t); const report = await loadCheck({ concurrency: 4, requests: 8, outputDir: data.root });
  assert.equal(report.completed, 8); assert.equal(report.maxActive, 4); assert.equal(report.providerGuard.guardedToolCalls, 8); assert.equal(report.providerGuard.driverNetworkBlocked, true);
  assert.throws(() => projectHistory(report.stateDir), /diagnostic state/);
  assert.throws(() => createBroker({ repoPath: join(report.stateDir, '..', 'fixture'), stateDir: report.stateDir }), /diagnostic state/);
});
