import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactFixture, fixtureViews, runtimeCritic } from './helpers/artifacts.js';
import { checkEnvironmentRequirements } from '../src/tools/environment.js';
import { hashExecutionInputs, resolveExecutionInput } from '../src/tools/inputs.js';
import { inspectProject } from '../src/project/index.js';

async function fixture(t: Parameters<typeof artifactFixture>[0], script = 'process.stdout.write("Available");', timeoutMs = 3000) {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), envRequirements: { runtime: { description: 'Install the required runtime.', script: 'environment.mjs', timeoutMs } } }, { 'environment.mjs': script });
  const config = await data.config();
  return { ...data, check: (signal?: AbortSignal) => checkEnvironmentRequirements({ workspacePath: data.repoPath, configManifest: config.configManifest, outputDir: join(data.root, 'checks'), signal }) };
}

test('environment declarations belong to folders and remain inert during discovery and queries', async t => {
  const data = await fixture(t, 'throw new Error("Only explicit preparation executes this.");');
  const config = await data.config(); assert.equal(config.configManifest.envRequirements!['a/runtime'].script, 'a/environment.mjs');
  const { plan } = await inspectProject(data); assert.equal(plan.artifacts[0].status, 'UNREVIEWED');
  assert.equal((await data.check()).ok, false);
});

test('readiness receives reviewer environment but never Provider credentials or Node preload hooks', async t => {
  const secret = process.env.OPENAI_API_KEY, hook = process.env.NODE_OPTIONS;
  process.env.OPENAI_API_KEY = 'PRIVATE_FIXTURE_KEY'; process.env.NODE_OPTIONS = '--invalid-preload';
  t.after(() => { if (secret === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = secret; if (hook === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = hook; });
  const data = await fixture(t, "import assert from 'node:assert/strict';assert.equal(process.env.OPENAI_API_KEY,undefined);assert.equal(process.env.NODE_OPTIONS,undefined);assert.ok(process.env.PATH);assert.ok(process.env.CCDD_OUTPUT_DIR);assert.notEqual(process.cwd(),process.env.TMPDIR);");
  assert.equal((await data.check()).ok, true);
});

test('readiness diagnostics are bounded and failures do not become review verdicts', async t => {
  const data = await fixture(t, 'console.error("Install the missing runtime.");process.exit(5);'), result = await data.check();
  assert.equal(result.ok, false); assert.match(result.checks[0].message, /Install the missing runtime/); assert.ok(!('verdict' in result));
});

test('readiness scripts honor timeout and cancellation', async t => {
  const data = await fixture(t, 'await new Promise(()=>setInterval(()=>{},1000));', 120);
  assert.match((await data.check()).checks[0].message, /timed out/);
  const controller = new AbortController(); const pending = data.check(controller.signal); setTimeout(() => controller.abort(), 30); await assert.rejects(pending);
});

test('changed readiness scripts cannot reconnect to previously recorded inputs', async t => {
  const data = await fixture(t); await writeFile(join(data.repoPath, 'a/environment.mjs'), 'process.exit(0)');
  await assert.rejects(data.check(), { code: 'WORKSPACE_ARTIFACT_MISMATCH' });
});

test('only admitted Artifact readiness checks run during a scoped Human preparation', async t => {
  const data = await fixture(t);
  await data.write('other', { name: 'other', envRequirements: { fail: { description: 'Must not run.', script: 'fail.mjs' } } }, { 'fail.mjs': 'process.exit(2);' });
  const config = await data.config();
  const result = await checkEnvironmentRequirements({ workspacePath: data.repoPath, configManifest: config.configManifest, artifactIds: ['a'], outputDir: join(data.root, 'scoped') });
  assert.deepEqual(result.checks.map(check => check.id), ['a/runtime']); assert.equal(result.ok, true);
});

test('declared runtime material and readiness inputs invalidate only their consuming Artifact graph', async t => {
  const data = await artifactFixture(t), views = fixtureViews(); views.humanTools!.read.metadata.executionPaths = ['runtime'];
  await mkdir(join(data.repoPath, 'runtime')); await writeFile(join(data.repoPath, 'runtime/code.txt'), 'version1');
  await data.write('a', { name: 'a', views, critics: [runtimeCritic()] }); await data.write('b', { name: 'b', critics: [runtimeCritic()] });
  const before = (await inspectProject(data)).snapshot;
  await writeFile(join(data.repoPath, 'runtime/code.txt'), 'version2');
  const after = (await inspectProject(data)).snapshot;
  assert.notEqual(before.inputs['a/check'].key, after.inputs['a/check'].key); assert.equal(before.inputs['b/check'].key, after.inputs['b/check'].key);
});

test('runtime hashing permits internal symlinks and rejects escaping declared material', async t => {
  const data = await artifactFixture(t); await mkdir(join(data.repoPath, 'runtime')); await writeFile(join(data.repoPath, 'runtime/entry'), 'data'); await symlink('entry', join(data.repoPath, 'runtime/link'));
  const hashes = await hashExecutionInputs(data.repoPath, ['runtime']); assert.equal(hashes.length, 1);
  await assert.rejects(resolveExecutionInput(data.repoPath, ['runtime'], 'private'), /declared/);
  await symlink('../../outside', join(data.repoPath, 'runtime/escape')); await assert.rejects(hashExecutionInputs(data.repoPath, ['runtime']), /escape|outside|stay inside|ENOENT/);
});
