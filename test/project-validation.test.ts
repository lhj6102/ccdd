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
  const broker = createBroker({ detail: 'full', ...data, executors: createExecutorRegistry() }); data.cleanup(() => broker.close());
  const verify = async (options: Parameters<typeof broker.submitProject>[0]) => { const run = await broker.submitProject(options); if (!['GREEN', 'INCOMPLETE'].includes(run.status)) await broker.run(run.id); return projectRun(data.stateDir, run.id)!; };
  return { ...data, broker, verify };
}

test('current queries read only JSON and material and never create a store or execute scripts', async t => {
  const data = await artifactFixture(t), marker = join(data.root, 'executed');
  await data.write('', { name: 'root', views: fixtureViews(), critics: [runtimeCritic()] }, { 'view.mjs': `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'x');` });
  const before = await readdir(data.root);
  const { plan } = await inspectProject({ ...data, detail: 'full' });
  assert.equal(plan.satisfied, false); assert.equal(plan.items[0].action, 'EXECUTE');
  assert.deepEqual(await readdir(data.root), before); await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('individual verification executes selected inputs immediately and preserves PASS when other evidence is missing', async t => {
  const data = await fixture(t, true); await data.identity('a'); await data.identity('b');
  const first = await data.verify({ selection: { kind: 'critic', criticId: 'a/check' } });
  assert.equal(first.status, 'INCOMPLETE'); assert.equal(first.requests.length, 1); assert.equal(first.requests[0].status, 'GREEN');
  assert.equal(first.validation!.critics.find(c => c.id === 'a/check')!.status, 'PASS');
  const second = await data.verify({ selection: { kind: 'artifact', artifactId: 'b' } });
  assert.equal(second.status, 'GREEN'); assert.equal(second.requests.length, 2);
  assert.deepEqual(second.requests.filter(r => r.cacheDisposition !== 'hit').map(r => r.criticId), ['b/check']);
  const current = await inspectProject({ detail: 'full', ...data, selection: { kind: 'artifact', artifactId: 'a' } });
  assert.equal(current.plan.satisfied, true);
  assert.deepEqual(current.plan.critics.map(c => c.id), ['a/check', 'b/check']);
  assert.deepEqual(current.plan.artifacts.map(a => a.id), ['a', 'b']);
  const whole = await inspectProject({ ...data, detail: 'full' });
  assert.equal(whole.plan.critics.find(c => c.id === 'independent/check')!.status, 'STALE');
});

test('recursive verification of a cycle runs real processes without PASS gates and reuses the same actual evidence', async t => {
  const data = await fixture(t, true); await data.identity('a'); await data.identity('b');
  const run = await data.verify({ selection: { kind: 'artifact', artifactId: 'a' }, recursive: true });
  assert.equal(run.status, 'GREEN'); assert.deepEqual(run.requests.map(r => r.criticId).sort(), ['a/check', 'b/check']);
  assert.ok(run.requests.every(r => r.result?.exitCode === 0 && r.validationInput?.version === 4));
  const again = await data.verify({ selection: { kind: 'artifact', artifactId: 'b' }, recursive: true });
  assert.equal(again.status, 'GREEN'); assert.equal(again.requests.length, 2); assert.ok(again.requests.every(r => r.cacheDisposition === 'hit'));
  assert.deepEqual(again.validation!.items.map(c => c.action), ['REUSE', 'REUSE']);
});

test('folder, mount and instruction inputs invalidate consumers while unrelated material preserves reuse', async t => {
  const data = await fixture(t);
  await data.write('a/child', { name: 'child', basis: true });
  await data.write('reference', { name: 'reference', basis: true });
  await data.edit('a', m => { m.mounts = { mounted: 'reference', alias: 'reference' }; });
  await data.verify({ selection: { kind: 'all' }, recursive: true });
  const before = (await inspectProject({ ...data, detail: 'full' })).snapshot;
  await writeFile(join(data.repoPath, 'independent/content.txt'), 'unrelated change');
  let current = (await inspectProject({ ...data, detail: 'full' })).snapshot;
  assert.equal(current.inputs['a/check'].key, before.inputs['a/check'].key);
  for (const path of ['a/child/content.txt', 'reference/content.txt', 'b/content.txt']) {
    const old = current;
    await writeFile(join(data.repoPath, path), `change ${path}`);
    current = (await inspectProject({ ...data, detail: 'full' })).snapshot;
    assert.notEqual(current.inputs['a/check'].key, old.inputs['a/check'].key);
  }
  assert.equal(queryProject(current, projectHistory(data.stateDir, { detail: 'full' }), { stateDir: data.stateDir, detail: 'full' }).critics.find(c => c.id === 'a/check')!.status, 'WAIT_DEPENDENCY');
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
  const { plan } = await inspectProject({ ...data, detail: 'full' });
  assert.equal(plan.satisfied, false);
  assert.deepEqual(Object.fromEntries(plan.artifacts.map(a => [a.id, a.status])), { basis: 'BASIS', empty: 'UNREVIEWED', parent: 'INCOMPLETE' });
  assert.equal((await inspectProject({ detail: 'full', ...data, selection: { kind: 'artifact', artifactId: 'basis' } })).plan.satisfied, true);
});

test('narrow material selection still fingerprints the manifest and script entry implementation', async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', stale: { kind: 'file-hash', paths: ['content.txt'] }, views: fixtureViews(), critics: [runtimeCritic()] });
  const before = (await inspectProject({ ...data, detail: 'full' })).snapshot;
  await writeFile(join(data.repoPath, 'a/view.mjs'), '// changed implementation');
  const changed = (await inspectProject({ ...data, detail: 'full' })).snapshot;
  assert.notEqual(changed.inputs['a/check'].key, before.inputs['a/check'].key);
  await writeFile(join(data.repoPath, 'a/unrelated.txt'), 'not declared');
  assert.equal((await inspectProject({ ...data, detail: 'full' })).snapshot.inputs['a/check'].key, changed.inputs['a/check'].key);
  await writeFile(join(data.repoPath, 'a/check.test.mjs'), '// changed runtime entry');
  assert.notEqual((await inspectProject({ ...data, detail: 'full' })).snapshot.inputs['a/check'].key, changed.inputs['a/check'].key);
});

test('force bypasses only selected Critics and a new owner identity records actual RED', async t => {
  const data = await fixture(t); await data.identity('a'); await data.identity('b',['check.test.mjs']); await data.identity('independent');
  await data.verify({ selection: { kind: 'all' } });
  const forced = await data.verify({ selection: { kind: 'critic', criticId: 'a/check' }, recursive: true, force: true });
  assert.equal(forced.status, 'GREEN'); assert.deepEqual(forced.requests.filter(r => r.cacheDisposition !== 'hit').map(r => r.criticId), ['a/check']);
  await writeFile(join(data.repoPath, 'b/check.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';test('actual failure',()=>assert.equal(1,2));");
  const failing = await data.verify({ selection: { kind: 'artifact', artifactId: 'a' }, recursive: true });
  assert.equal(failing.status, 'RED');
  assert.equal(failing.requests.find(r => r.criticId === 'a/check')!.status, 'GREEN', 'The cached semantic verdict is not rewritten by a dependency gate.');
  assert.equal(failing.validation!.critics.find(r => r.id === 'a/check')!.status, 'BLOCKED');
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



test('CLI config and graph queries expose qualified owners and cyclic relation types without executing', async t => {
  const data = await fixture(t, true); let output = '';
  const code = await main(['graph', 'a', '--repo', data.repoPath, '--state-dir', data.stateDir, '--json'], { stdout: { write: text => { output += text; } }, stderr: { write: text => { throw new Error(text); } } });
  assert.equal(code, 0); const graph = JSON.parse(output); assert.equal(graph.version, 2); assert.equal(graph.critics.length, 2); assert.ok(graph.relations.every((edge: any) => edge.kind === 'instruction'));
  const bytes = await readFile(join(data.stateDir, 'broker.sqlite'));
  await inspectProject({ ...data, detail: 'full' }); assert.deepEqual(await readFile(join(data.stateDir, 'broker.sqlite')), bytes);
});

test('declared timeouts accept twenty minutes consistently and reject Node timer overflow', async t => {
  const { readWorkspaceConfig } = await import('../src/broker/config.js');
  const { agentProfile } = await import('./helpers/artifacts.js');
  const data = await artifactFixture(t);
  for (const timeoutMs of [1, 1_200_000, 86_400_001, 2_147_483_647]) {
    const views = fixtureViews(); views.agentTools!.read.metadata.timeoutMs = timeoutMs;
    await data.write('a', { name: 'a', views, stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] }, timeoutMs },
      envRequirements: { check: { description: 'Check readiness', script: 'check.mjs', timeoutMs } },
      critics: [{ id: 'review', title: 'Review', profile: { ...agentProfile, timeoutMs }, payload: { instruction: 'Inspect.' } }] }, { 'identity.mjs': "console.log('stable');", 'check.mjs': "console.log('ready');" });
    await readWorkspaceConfig(data.repoPath);
    assert.equal((await createExecutorRegistry().canExecute({ profile: { ...agentProfile, timeoutMs } })).ok, true);
    assert.equal((await createExecutorRegistry().canExecute({ profile: { kind: 'runtime', command: 'node', args: ['--test', 'check.test.mjs'], timeoutMs } })).ok, true);
  }
  for (const target of ['profile', 'tool', 'identity', 'environment']) {
    await data.edit('a', manifest => {
      manifest.critics![0].profile = { ...agentProfile, timeoutMs: 1_200_000 };
      manifest.views!.agentTools!.read.metadata.timeoutMs = 1_200_000;
      if (manifest.stale?.kind === 'identity') manifest.stale.timeoutMs = 1_200_000;
      manifest.envRequirements!.check.timeoutMs = 1_200_000;
      if (target === 'profile') manifest.critics![0].profile = { ...agentProfile, timeoutMs: 2_147_483_648 };
      if (target === 'tool') manifest.views!.agentTools!.read.metadata.timeoutMs = 2_147_483_648;
      if (target === 'identity' && manifest.stale?.kind === 'identity') manifest.stale.timeoutMs = 2_147_483_648;
      if (target === 'environment') manifest.envRequirements!.check.timeoutMs = 2_147_483_648;
    });
    await assert.rejects(readWorkspaceConfig(data.repoPath), /timeout/i);
  }
});
