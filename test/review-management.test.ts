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

test('unstarted submissions cannot lend their execution budget to another request', async t => {
  const data = await fixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] }); await data.identity('a');
  const broker = createBroker({ detail: 'full', ...data, executors: simple }); data.cleanup(() => broker.close());
  const first = await broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 1 });
  await assert.rejects(broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 0 }), /requires 1 new executions/);
  assert.equal(broker.executionBudget(first.id)!.attempts.length, 0);
  await broker.run(first.id);
  const receiver = await broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 0 });
  assert.equal(receiver.requests[0].cacheDisposition, 'hit');
  assert.equal(broker.executionBudget(receiver.id)!.attempts.length, 0);
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
  const reused = await broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 0 }); assert.equal(reused.requests.length, 1); assert.equal(reused.requests[0].cacheDisposition, 'hit');
  const compact = await inspectProject({ ...data }); assert.deepEqual(compact.plan.results[0].executionProvenance, provenance); assert.deepEqual(compact.plan.items[0].result!.executionProvenance, provenance);
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite')); const row = db.prepare('SELECT data FROM requests WHERE id=?').get(first.requests[0].id)!; const header = JSON.parse(String(row.data)); delete header.executionProvenance; db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(header), first.requests[0].id); db.close();
  assert.equal(projectHistory(data.stateDir, { detail: 'full' }).find(entry => entry.requestId === first.requests[0].id)!.executionProvenance, null);
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

test('multi-root union deduplicates selected Critics under one budget while retaining dependency gates', async t => {
  const data = await fixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] }); await data.write('b', { name: 'b', critics: [runtimeCritic()] });
  const broker = createBroker({ detail: 'full', ...data, executors: simple }); data.cleanup(() => broker.close());
  await data.identity('a'); await data.identity('b');
  const selection = { kind: 'critics' as const, criticIds: ['a/check', 'b/check', 'a/check'] };
  const plan = await inspectProject({ detail: 'full', ...data, selection }); assert.deepEqual(plan.plan.selectedCriticIds, ['a/check', 'b/check']);
  await assert.rejects(broker.submitProject({ selection, maxExecutions: 1 }), /requires 2 new executions/);
  const run = await broker.submitProject({ selection, maxExecutions: 2 }); await broker.run(run.id); assert.equal(broker.executionBudget(run.id)!.attempts.length, 2);
  const reuse = await broker.submitProject({ selection, maxExecutions: 0 }); assert.equal(reuse.requests.length, 2); assert.ok(reuse.requests.every(request => request.cacheDisposition === 'hit'));
  await data.write('a/child', { name: 'child', critics: [runtimeCritic()] });
  const gated = await inspectProject({ detail: 'full', ...data, selection: { kind: 'artifacts', artifactIds: ['a', 'b', 'a'] } });
  assert.equal(gated.plan.items.find(item => item.id === 'a/check')!.action, 'WAIT_DEPENDENCY'); assert.equal(gated.plan.items.some(item => item.id === 'child/check'), false);
});

test('CLI forwards zero and finite max-executions before any detached executor start', async t => {
  const data = await fixture(t), marker = join(data.root, 'started');
  await data.write('a', { name: 'a', critics: [runtimeCritic('one'), runtimeCritic('two')] }, { 'check.test.mjs': `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')` });
  for (const cap of ['0', '1']) {
    let output = ''; const code = await main(['verify', '--all', '--max-executions', cap, '--repo', data.repoPath, '--state-dir', data.stateDir, '--json'], { stdout: { write(value) { output += value; } }, stderr: { write(value) { output += value; } } });
    assert.equal(code, 2, output); assert.match(output, /maxExecutions/); await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
});

for (const mode of ['failure', 'cancel']) test(`started ${mode} retains original attempt provenance while retry and prestart remain distinct`, async t => {
  const data = await provenanceFixture(t); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => release = resolve), ready = new Promise<void>(resolve => entered = resolve);
  const broker = createBroker({ ...data, executors: { ...simple, async execute() { entered(); if (mode === 'cancel') await gate; throw new Error('original execution failure'); } } }); data.cleanup(async () => { release(); await broker.close(); });
  const run = await broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 2 }); const running = broker.run(run.id); await ready;
  if (mode === 'cancel') { broker.cancel(run.id); release(); } await running;
  const request = broker.getRun(run.id)!.requests[0]; assert.ok(request.attemptId); assert.ok(request.executionProvenance);
  const changes = broker.changes(run.id)!.changes; const error = changes.find(change => change.status === 'ERROR')!; assert.deepEqual(error.executionProvenance, request.executionProvenance);
  broker.retryRequest(request.id); assert.equal(broker.getRequest(request.id)!.executionProvenance, null);
  await broker.run(run.id); const attempts = broker.executionBudget(run.id)!.attempts; assert.equal(attempts.length, 2); assert.notEqual(attempts[0].token, attempts[1].token); assert.deepEqual(attempts[0].executionProvenance, request.executionProvenance);
  assert.deepEqual(broker.changes(run.id)!.changes.find(change => change.cursor === error.cursor)!.executionProvenance, request.executionProvenance);
});

test('real-project diagnostic preserves graph, runs identities and selected tools with previous-result arguments', async t => {
  const data = await fixture(t), views = fixtureViews();
  views.agentTools!.read.metadata.inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  views.agentTools!.next = { metadata: { description: 'Next controlled diagnostic call.', inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false }, resultKinds: ['json'], observation: 'content' }, script: { command: 'node', args: ['view.mjs'] } };
  const manifest = { name: 'root', views, stale: { kind: 'identity' as const, script: { command: 'node', args: ['identity.mjs'] } }, critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read tools.' } }] };
  const scripts = { 'identity.mjs': "if(Reflect.get(globalThis,Symbol.for('ccdd.offline-guard'))!==true)throw Error('unguarded identity');console.log('stable')", 'view.mjs': "let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify({content:[{type:'json',data:{value:2}}],observation:{kind:'content'}}))" };
  await data.write('', manifest, scripts); await data.write('child', { ...manifest, name: 'child' }, scripts);
  const before = await readFile(join(data.repoPath, 'ccdd.json'));
  const project = { repoPath: data.repoPath, selection: { kind: 'all' as const }, scenario: { steps: [{ operation: 'read', args: {} }, { operation: 'next', argsFrom: { step: 0, pointer: '/content/0/data' } }] } };
  const report = await loadCheck({ project, outputDir: data.root, concurrency: 60 }); assert.equal(report.completed, 2); assert.equal(report.maxActive, 1); assert.equal(report.toolLatencyMs.count, 4); assert.ok(report.changeCount >= 6); assert.ok(report.providerGuard.guardedNodeProcesses >= 7);
  assert.deepEqual(await readFile(join(data.repoPath, 'ccdd.json')), before); await assert.rejects(readFile(join(data.stateDir, 'broker.sqlite')), { code: 'ENOENT' });
  await assert.rejects(loadCheck({ ...{ project: { ...project, scenario: { steps: [{ operation: 'next', argsFrom: { step: 0, pointer: '/content' } }] } } }, outputDir: data.root }), /earlier step/);
  await assert.rejects(loadCheck({ project: { ...project, scenario: { steps: [{ operation: 'missing' }] } }, outputDir: data.root }), /Unknown registered scenario tool/);
});

test('required diagnostic pass payload is explicit and validated before identity or tool work', async t => {
  const data = await fixture(t), marker = join(data.root, 'user-work');
  const views = fixtureViews();
  const definition = { name: 'root', views, stale: { kind: 'identity' as const, script: { command: 'node', args: ['identity.mjs'] } }, critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read.' }, passSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false } }] };
  const scripts = { 'identity.mjs': `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'identity');console.log('same')` };
  await data.write('', definition, scripts); await data.write('child', { ...definition, name: 'child' }, scripts);
  const project = { repoPath: data.repoPath, selection: { kind: 'all' as const }, scenario: { steps: [{ operation: 'read', args: {} }] } };
  for (const syntheticResult of [undefined, { verdict: 'GREEN', reason: 3 }]) {
    await assert.rejects(loadCheck({ project: { ...project, scenario: { ...project.scenario, syntheticResult } }, outputDir: data.root }), /response schema/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
  const report = await loadCheck({ project: { ...project, scenario: { ...project.scenario, syntheticResult: { verdict: 'GREEN', reason: 'Explicit synthetic diagnostic payload, not a review.' } } }, outputDir: data.root });
  assert.equal(report.completed, 2); assert.equal(report.status, 'GREEN'); assert.equal(report.diagnosticOnly, true); assert.equal(report.maxActive, 1);
});

test('cleanup failures retain the original execution error and release custom admission exactly once', async t => {
  const data = await fixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  let released = 0;
  const broker = createBroker({ detail: 'full', ...data, admission: { async acquire() { return { release() { released++; throw new Error('separate cleanup failure'); } }; } }, executors: { ...simple, async execute() { throw new Error('original failure'); } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(run.id);
  const final = broker.getRun(run.id)!; assert.equal(final.requests[0].error, 'original failure'); assert.equal(released, 1); assert.equal(final.events.filter(event => event.type === 'resource.cleanup.error').length, 1);
});

test('forked real-project diagnostics choose private temp roots and filter unrelated environment secrets', async t => {
  const data = await fixture(t), evidence = join(data.root, 'temp-evidence.jsonl'), parentTmp = join(data.root, 'untrusted-parent-temp'); await mkdir(parentTmp);
  const previousTmp = process.env.TMPDIR, previousSecret = process.env.CCDD_TEST_UNRELATED_SECRET;
  process.env.TMPDIR = parentTmp; process.env.CCDD_TEST_UNRELATED_SECRET = 'must-not-reach-diagnostic';
  data.cleanup(() => { for (const [key, value] of [['TMPDIR', previousTmp], ['CCDD_TEST_UNRELATED_SECRET', previousSecret]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; } });
  const record = `import {appendFileSync} from 'node:fs';import {tmpdir} from 'node:os';if(process.env.CCDD_TEST_UNRELATED_SECRET)throw Error('secret leaked');appendFileSync(${JSON.stringify(evidence)},JSON.stringify({tmp:tmpdir(),output:process.env.CCDD_OUTPUT_DIR})+'\\n');`;
  const views = fixtureViews(); views.agentTools!.read.metadata.resultKinds = ['text'];
  await data.write('a', { name: 'a', views, stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } }, critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read.' } }] }, { 'identity.mjs': record + "console.log('same')", 'view.mjs': record + "for await(const c of process.stdin){};console.log(JSON.stringify({content:[{type:'text',text:'diagnostic'}],observation:{kind:'content'}}));" });
  const project = { repoPath: data.repoPath, selection: { kind: 'all' as const }, scenario: { steps: [{ operation: 'read', args: {} }] } };
  const reports = await Promise.all([loadCheck({ project, outputDir: data.root }), loadCheck({ project, outputDir: data.root })]);
  assert.notEqual(reports[0].temporaryRoot, reports[1].temporaryRoot);
  for (const report of reports) { assert.ok(report.temporaryRoot.startsWith(data.root + '/ccdd-load-check-')); assert.notEqual(report.temporaryRoot, parentTmp); assert.equal(report.status, 'GREEN'); assert.ok(await readFile(report.output)); }
  const records = (await readFile(evidence, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.equal(records.length, 4);
  for (const entry of records) { assert.ok(reports.some(report => entry.tmp.startsWith(join(report.output, '..') + '/') || entry.tmp.startsWith(report.temporaryRoot + '/'))); assert.equal(entry.tmp.startsWith(parentTmp), false); }
  assert.ok(await readFile(join(data.repoPath, 'a', 'ccdd.json')));
});

for (const runtime of [false, true]) for (const cancel of ['local', 'remote', 'owner-loss'] as const) test(`prestart ${cancel} during readiness with declared runtime=${runtime} refunds without executor invocation`, async t => {
  const data = await fixture(t), views = fixtureViews();
  if (runtime) { views.agentTools!.read.metadata.executionPaths = ['runtime.txt']; await writeFile(join(data.repoPath, 'runtime.txt'), 'declared runtime'); }
  await data.write('a', { name: 'a', views, critics: [runtimeCritic()] });
  let release!: () => void, entered!: () => void, executing = false, calls = 0;
  const ready = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  const broker = createBroker({ detail: 'full', ...data, executors: { async canExecute() { if (executing) { entered(); await gate; } return { ok: true }; }, async execute() { calls++; return { verdict: 'GREEN' }; } } }); data.cleanup(async () => { release(); await broker.close(); });
  const run = await broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 1 }); executing = true; const pending = broker.run(run.id); await ready;
  if (cancel === 'local') broker.cancel(run.id);
  else if (cancel === 'remote') { const other = createBroker({ detail: 'full', ...data }); try { other.cancel(run.id); } finally { await other.close(); } }
  else { const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite')); db.prepare('DELETE FROM run_owners WHERE run_id=?').run(run.id); db.close(); }
  release(); await pending;
  assert.equal(calls, 0); const budget = broker.executionBudget(run.id)!; assert.equal(budget.attempts.length, 1); assert.equal(budget.attempts[0].state, 'refunded'); assert.equal(Reflect.get(budget.attempts[0], 'started_at'), null);
  assert.equal(broker.getRun(run.id)!.requests[0].attemptId, undefined);
  const machine = new DatabaseSync(resourcePaths().database); assert.equal(machine.prepare('SELECT count(*) n FROM resource_leases WHERE run_id=?').get(run.id)!.n, 0); machine.close();
});

test('failed repository attempt commit never invokes executor but preserves the conservative machine start', async t => {
  const data = await fixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  let ready = false, calls = 0;
  const broker = createBroker({ detail: 'full', ...data, executors: { async canExecute() {
    if (ready) { const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite')); db.exec("CREATE TRIGGER reject_attempt BEFORE UPDATE ON requests WHEN json_extract(NEW.data,'$.attemptId') IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected attempt commit failure'); END"); db.close(); }
    return { ok: true };
  }, async execute() { calls++; return { verdict: 'GREEN' }; } } }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' }, maxExecutions: 1 }); ready = true; await broker.run(run.id);
  assert.equal(calls, 0); assert.match(broker.getRun(run.id)!.requests[0].error!, /injected attempt commit failure/);
  const attempts = broker.executionBudget(run.id)!.attempts; assert.equal(attempts.length, 1); assert.equal(attempts[0].state, 'terminal'); assert.ok(Reflect.get(attempts[0], 'started_at'));
});
