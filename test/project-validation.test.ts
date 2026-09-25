import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactFixture, runtimeCritic, fixtureViews } from './helpers/artifacts.js';
import { inspectProject, createProjectSnapshot, queryProject, planProject } from '../src/project/index.js';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { projectHistory, projectRun } from '../src/project/store.js';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../src/project/cli.js';

async function fixture(t: TestContext, cycle = false) {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', critics: [runtimeCritic('check', 'Check {b}.')] });
  await data.write('b', { name: 'b', critics: [runtimeCritic('check', cycle ? 'Check {a}.' : 'Check this Artifact.')] });
  await data.write('independent', { name: 'independent', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, executors: createExecutorRegistry() }); data.cleanup(() => broker.close());
  const verify = async (options: Parameters<typeof broker.submitProject>[0]) => { const run = await broker.submitProject(options); if (!['GREEN', 'INCOMPLETE'].includes(run.status)) await broker.run(run.id); return projectRun(data.stateDir, run.id)!; };
  return { ...data, broker, verify };
}

test('current queries read only JSON and material and never create a store or execute scripts', async t => {
  const data = await artifactFixture(t), marker = join(data.root, 'executed');
  await data.write('', { name: 'root', views: fixtureViews(), critics: [runtimeCritic()] }, { 'view.mjs': `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'x');` });
  const before = await readdir(data.root);
  const { plan } = await inspectProject(data);
  assert.equal(plan.satisfied, false); assert.equal(plan.items[0].action, 'EXECUTE');
  assert.deepEqual(await readdir(data.root), before); await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('individual verification executes selected inputs immediately and preserves PASS when other evidence is missing', async t => {
  const data = await fixture(t, true);
  const first = await data.verify({ selection: { kind: 'critic', criticId: 'a/check' } });
  assert.equal(first.status, 'INCOMPLETE'); assert.equal(first.requests.length, 1); assert.equal(first.requests[0].status, 'GREEN');
  assert.equal(first.validation!.critics.find(c => c.id === 'a/check')!.status, 'PASS');
  const second = await data.verify({ selection: { kind: 'artifact', artifactId: 'b' } });
  assert.equal(second.status, 'GREEN'); assert.equal(second.requests.length, 1);
  const current = await inspectProject({ ...data, selection: { kind: 'artifact', artifactId: 'a' } });
  assert.equal(current.plan.satisfied, true);
  assert.deepEqual(current.plan.critics.map(c => c.id), ['a/check', 'b/check']);
  assert.deepEqual(current.plan.artifacts.map(a => a.id), ['a', 'b']);
  const whole = await inspectProject(data);
  assert.equal(whole.plan.critics.find(c => c.id === 'independent/check')!.status, 'UNREVIEWED');
});

test('recursive verification of a cycle runs real processes without PASS gates and reuses the same actual evidence', async t => {
  const data = await fixture(t, true);
  const run = await data.verify({ selection: { kind: 'artifact', artifactId: 'a' }, recursive: true });
  assert.equal(run.status, 'GREEN'); assert.deepEqual(run.requests.map(r => r.criticId).sort(), ['a/check', 'b/check']);
  assert.ok(run.requests.every(r => r.result?.exitCode === 0 && r.validationInput?.version === 2));
  const again = await data.verify({ selection: { kind: 'artifact', artifactId: 'b' }, recursive: true });
  assert.equal(again.status, 'GREEN'); assert.equal(again.requests.length, 0);
  assert.deepEqual(again.validation!.items.map(c => c.action), ['REUSE', 'REUSE']);
});

test('folder, mount and instruction inputs invalidate consumers while unrelated material preserves reuse', async t => {
  const data = await fixture(t);
  await data.write('a/child', { name: 'child', basis: true });
  await data.write('reference', { name: 'reference', basis: true });
  await data.edit('a', m => { m.mounts = { mounted: 'reference', alias: 'reference' }; });
  await data.verify({ selection: { kind: 'all' }, recursive: true });
  const before = (await inspectProject(data)).snapshot;
  await writeFile(join(data.repoPath, 'independent/content.txt'), 'unrelated change');
  let current = (await inspectProject(data)).snapshot;
  assert.equal(current.inputs['a/check'].key, before.inputs['a/check'].key);
  for (const path of ['a/child/content.txt', 'reference/content.txt', 'b/content.txt']) {
    const old = current;
    await writeFile(join(data.repoPath, path), `change ${path}`);
    current = (await inspectProject(data)).snapshot;
    assert.notEqual(current.inputs['a/check'].key, old.inputs['a/check'].key);
  }
  assert.equal(queryProject(current, projectHistory(data.stateDir)).critics.find(c => c.id === 'a/check')!.status, 'STALE');
});

test('SCC identity is finite and independent of evidence IDs, completion times and definition discovery order', async t => {
  const data = await fixture(t, true), config = await data.config();
  const before = await createProjectSnapshot(config, data.repoPath, 'a'.repeat(64));
  const reversed = structuredClone(config); reversed.artifacts = Object.fromEntries(Object.entries(reversed.artifacts).reverse()); reversed.relations.reverse();
  const after = await createProjectSnapshot(reversed, data.repoPath, 'b'.repeat(64));
  assert.deepEqual(before.inputs, after.inputs);
  await data.verify({ selection: { kind: 'artifact', artifactId: 'a' }, recursive: true });
  const completed = await createProjectSnapshot(config, data.repoPath, 'c'.repeat(64));
  assert.deepEqual(completed.inputs, before.inputs);
  await writeFile(join(data.repoPath, 'b/content.txt'), 'cycle changed');
  const changed = await createProjectSnapshot(config, data.repoPath, 'd'.repeat(64));
  assert.notEqual(changed.artifactHashes.a, before.artifactHashes.a); assert.notEqual(changed.artifactHashes.b, before.artifactHashes.b);
  assert.equal(changed.artifactHashes.independent, before.artifactHashes.independent);
});

test('no-Critic Artifacts remain UNREVIEWED except explicit basis, including recursive scope', async t => {
  const data = await artifactFixture(t);
  await data.write('empty', { name: 'empty' }); await data.write('basis', { name: 'basis', basis: true });
  await data.write('parent', { name: 'parent', basis: true, mounts: { input: 'empty' } });
  const { plan } = await inspectProject(data);
  assert.equal(plan.satisfied, false);
  assert.deepEqual(Object.fromEntries(plan.artifacts.map(a => [a.id, a.status])), { basis: 'BASIS', empty: 'UNREVIEWED', parent: 'INCOMPLETE' });
  assert.equal((await inspectProject({ ...data, selection: { kind: 'artifact', artifactId: 'basis' } })).plan.satisfied, true);
});

test('narrow material selection still fingerprints the manifest and script entry implementation', async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', stale: { kind: 'file-hash', paths: ['content.txt'] }, views: fixtureViews(), critics: [runtimeCritic()] });
  const before = (await inspectProject(data)).snapshot;
  await writeFile(join(data.repoPath, 'a/view.mjs'), '// changed implementation');
  const changed = (await inspectProject(data)).snapshot;
  assert.notEqual(changed.inputs['a/check'].key, before.inputs['a/check'].key);
  await writeFile(join(data.repoPath, 'a/unrelated.txt'), 'not declared');
  assert.equal((await inspectProject(data)).snapshot.inputs['a/check'].key, changed.inputs['a/check'].key);
  await writeFile(join(data.repoPath, 'a/check.test.mjs'), '// changed runtime entry');
  assert.notEqual((await inspectProject(data)).snapshot.inputs['a/check'].key, changed.inputs['a/check'].key);
});

test('force replaces evidence only for selected Critics and a later actual RED supersedes old PASS', async t => {
  const data = await fixture(t);
  await data.verify({ selection: { kind: 'all' } });
  const forced = await data.verify({ selection: { kind: 'critic', criticId: 'a/check' }, recursive: true, force: true });
  assert.equal(forced.status, 'GREEN'); assert.deepEqual(forced.requests.map(r => r.criticId), ['a/check']);
  await writeFile(join(data.repoPath, 'b/check.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';test('actual failure',()=>assert.equal(1,2));");
  const failing = await data.verify({ selection: { kind: 'artifact', artifactId: 'a' }, recursive: true });
  assert.equal(failing.status, 'RED'); assert.equal(failing.requests.find(r => r.criticId === 'a/check')!.status, 'GREEN');
  assert.equal(failing.requests.find(r => r.criticId === 'b/check')!.status, 'RED');
  assert.equal(failing.validation!.satisfied, false);
});

test('always reviews once per request and metadata-integrity evidence cannot satisfy strict input', async t => {
  const data = await fixture(t, true); await data.edit('a', m => { m.stale = { kind: 'always' }; });
  for (let i = 0; i < 2; i++) {
    const run = await data.verify({ selection: { kind: 'artifact', artifactId: 'a' }, recursive: true });
    assert.equal(run.status, 'GREEN'); assert.equal(run.requests.length, 2);
  }
  const config = await data.config(), content = await createProjectSnapshot(config, data.repoPath, 'a'.repeat(64)), metadata = await createProjectSnapshot(config, data.repoPath, 'a'.repeat(64), undefined, 'metadata');
  assert.notEqual(content.inputs['a/check'].key, metadata.inputs['a/check'].key);
});

test('historical evidence is result-only and old unfinished runs cannot resume', async t => {
  const data = await fixture(t), run = await data.broker.submitProject({ selection: { kind: 'all' } });
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite'));
  const saved = JSON.parse(String(db.prepare('SELECT data FROM runs WHERE id=?').get(run.id)!.data)); saved.project.version = 1; saved.project.snapshot.version = 1;
  db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(saved), run.id); db.close();
  assert.ok(projectRun(data.stateDir, run.id)); assert.equal(projectRun(data.stateDir, run.id)!.validation, undefined);
  await assert.rejects(data.broker.run(run.id), /Historical Runs cannot be resumed/);
  const snapshot = (await inspectProject(data)).snapshot;
  const history = [{ requestId: 'old', runId: 'old', criticId: 'a/check', input: { ...snapshot.inputs['a/check'], version: 1 }, completedAt: new Date().toISOString(), verdict: 'GREEN', summary: 'Controlled historical fixture', evidence: ['Fixture'] }] as any;
  assert.equal(queryProject(snapshot, history).critics.find(c => c.id === 'a/check')!.result, null);
});

test('CLI config and graph queries expose qualified owners and cyclic relation types without executing', async t => {
  const data = await fixture(t, true); let output = '';
  const code = await main(['graph', 'a', '--repo', data.repoPath, '--state-dir', data.stateDir, '--json'], { stdout: { write: text => { output += text; } }, stderr: { write: text => { throw new Error(text); } } });
  assert.equal(code, 0); const graph = JSON.parse(output); assert.equal(graph.version, 2); assert.equal(graph.critics.length, 2); assert.ok(graph.relations.every((edge: any) => edge.kind === 'instruction'));
  const bytes = await readFile(join(data.stateDir, 'broker.sqlite'));
  await inspectProject(data); assert.deepEqual(await readFile(join(data.stateDir, 'broker.sqlite')), bytes);
});
