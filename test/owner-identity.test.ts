import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactFixture, fixtureViews, runtimeCritic } from './helpers/artifacts.js';
import { inspectProject, createProjectSnapshot } from '../src/project/index.js';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { projectRun } from '../src/project/store.js';
import { main } from '../src/project/cli.js';
import { inputHash } from '../src/project/identity.js';
import { packageVersion } from '../src/runtime-paths.js';

async function fixture(t: Parameters<typeof artifactFixture>[0], script = 'import {readFileSync} from "node:fs";process.stdout.write(readFileSync("value.txt"));') {
  const data = await artifactFixture(t), views = fixtureViews();
  views.agentTools!.read.metadata.executionPaths = ['runtime.txt'];
  await writeFile(join(data.repoPath, 'runtime.txt'), 'runtime one');
  await data.write('a', { name: 'a', views, stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] }, inputs: ['rule.txt'] }, critics: [runtimeCritic()] }, { 'identity.mjs': script, 'value.txt': 'equivalent-v1\n', 'rule.txt': 'rule one' });
  return data;
}

async function cli(data: { repoPath: string; stateDir: string }, args: string[]) {
  let output = '', error = '';
  const code = await main([...args, '--repo', data.repoPath, '--state-dir', data.stateDir], { stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } } });
  return { code, output, error };
}

test('owner identity reuses actual evidence across runtime and material changes, unless forced, and records its value', async t => {
  const data = await fixture(t), broker = createBroker({ ...data, executors: createExecutorRegistry() });
  data.cleanup(() => broker.close());
  const verify = async (force = false) => {
    const run = await broker.submitProject({ selection: { kind: 'artifact', artifactId: 'a' }, force });
    if (run.status !== 'GREEN') await broker.run(run.id);
    return projectRun(data.stateDir, run.id)!;
  };
  const first = await verify();
  assert.equal(first.status, 'GREEN'); assert.equal(first.requests.length, 1);
  const initial = first.requests[0].validationInput!;
  await writeFile(join(data.repoPath, 'runtime.txt'), 'runtime two');
  await writeFile(join(data.repoPath, 'a/content.txt'), 'different material');
  await writeFile(join(data.repoPath, 'a/view.mjs'), '// different view implementation');
  const second = await verify();
  assert.equal(second.status, 'GREEN'); assert.equal(second.requests.length, 0);
  assert.equal(second.validation!.items[0].action, 'REUSE');
  assert.equal(second.validation!.items[0].result!.requestId, first.requests[0].id);
  assert.deepEqual(second.project!.snapshot.artifactIdentities, { a: { identity: 'script', value: 'equivalent-v1' } });
  assert.notEqual(second.snapshotHash, first.snapshotHash);
  for (const args of [['plan', 'a'], ['status', '--critic', 'a/check'], ['run', 'show', second.id]]) {
    const plain = await cli(data, args); assert.equal(plain.code, 0); assert.match(plain.output, /identity: script · value: equivalent-v1/);
    const json = JSON.parse((await cli(data, [...args, '--json'])).output);
    const artifact = (json.validation ?? json).artifacts.find((a: { id: string }) => a.id === 'a');
    assert.equal(artifact.identity, 'script'); assert.equal(artifact.value, 'equivalent-v1');
  }
  const forced = await verify(true);
  assert.equal(forced.status, 'GREEN'); assert.equal(forced.requests.length, 1);
  assert.notEqual(forced.requests[0].id, first.requests[0].id);
  assert.equal(forced.requests[0].validationInput!.key, initial.key);
  await writeFile(join(data.repoPath, 'a/value.txt'), 'equivalent-v2');
  const changed = await verify();
  assert.equal(changed.requests.length, 1); assert.notEqual(changed.requests[0].validationInput!.key, initial.key);
  assert.equal(changed.requests[0].validationInput!.criticHash, initial.criticHash);
});

test('identity entry, declared inputs, definitions, environment inputs and dependency components still invalidate', async t => {
  const data = await fixture(t);
  await data.write('basis', { name: 'basis', basis: true });
  await data.edit('a', manifest => { manifest.mounts = { basis: 'basis' }; manifest.envRequirements = { ready: { description: 'Ready', script: 'ready.mjs' } }; });
  await writeFile(join(data.repoPath, 'a/ready.mjs'), 'process.exit(0)');
  let before = (await inspectProject(data)).snapshot;
  for (const [path, contents] of [['a/identity.mjs', 'console.log("equivalent-v1");'], ['a/rule.txt', 'rule two'], ['a/ready.mjs', '// changed environment'], ['basis/content.txt', 'dependency change']]) {
    await writeFile(join(data.repoPath, path), contents);
    const after = (await inspectProject(data)).snapshot;
    assert.notEqual(after.inputs['a/check'].key, before.inputs['a/check'].key, path);
    before = after;
  }
  await data.edit('a', manifest => { manifest.views!.agentTools!.read.metadata.description = 'Changed tool contract'; });
  assert.notEqual((await inspectProject(data)).snapshot.inputs['a/check'].key, before.inputs['a/check'].key);
});

test('identity discovery is inert, while invalid output and exits fail queries without fallback or leaked diagnostics', async t => {
  const data = await fixture(t);
  for (const output of ['', 'two\nlines', 'space here', 'a\n\n', 'a\r\n', 'a'.repeat(129), 'é', 'a\u0000']) {
    await writeFile(join(data.repoPath, 'a/identity.mjs'), `process.stdout.write(${JSON.stringify(output)});`);
    await assert.rejects(inspectProject(data), /Identity script for Artifact a stdout must be one line/);
  }
  await writeFile(join(data.repoPath, 'a/identity.mjs'), 'console.log("valid");console.error("PRIVATE_DIAGNOSTIC");process.exit(5);');
  assert.equal((await cli(data, ['config', 'check'])).code, 0);
  assert.equal((await cli(data, ['graph'])).code, 0);
  await assert.rejects(inspectProject(data), error => {
    assert.match(String(error), /Identity script for Artifact a failed \(exit 5\)/);
    assert.doesNotMatch(String(error), /PRIVATE_DIAGNOSTIC/); return true;
  });
  const broker = createBroker({ ...data, executors: createExecutorRegistry() }); data.cleanup(() => broker.close());
  await assert.rejects(broker.submitProject({ selection: { kind: 'all' } }), /Identity script/);
  assert.equal(broker.listRuns().length, 0);
});

test('identity scripts honor timeout, cancellation, bounded output and unchanged workspace integrity', async t => {
  const data = await fixture(t, 'await new Promise(()=>setInterval(()=>{},1000));');
  await data.edit('a', manifest => { if (manifest.stale?.kind === 'identity') manifest.stale.timeoutMs = 120; });
  await assert.rejects(inspectProject(data), /Identity script for Artifact a timed out after 120 ms/);
  await data.edit('a', manifest => { if (manifest.stale?.kind === 'identity') manifest.stale.timeoutMs = 5000; });
  const controller = new AbortController(), pending = inspectProject({ ...data, signal: controller.signal });
  setTimeout(() => controller.abort(), 80); await assert.rejects(pending);
  await writeFile(join(data.repoPath, 'a/identity.mjs'), 'process.stdout.write("a".repeat(70000));');
  await assert.rejects(inspectProject(data), /output exceeded 64 KiB/);
  await writeFile(join(data.repoPath, 'a/identity.mjs'), 'import {writeFileSync} from "node:fs";writeFileSync("content.txt","mutation");console.log("valid");');
  await assert.rejects(inspectProject(data), /workspace changed|aborted/i);
});

test('identity scripts use owner cwd, entry arguments, safe environment and optional inputs without leaving state', async t => {
  const data = await fixture(t, 'import assert from "node:assert/strict";import {readFileSync} from "node:fs";assert.equal(process.argv[2],"argument");assert.equal(process.env.NODE_OPTIONS,undefined);assert.equal(process.env.OPENAI_API_KEY,undefined);assert.ok(process.env.CCDD_OUTPUT_DIR);assert.equal(readFileSync("rule.txt","utf8"),"rule one");console.log("A".repeat(128));');
  await data.edit('a', manifest => { if (manifest.stale?.kind === 'identity') { delete manifest.stale.inputs; manifest.stale.script.args.push('argument'); } });
  const before = await readdir(data.root);
  assert.equal((await inspectProject(data)).plan.artifacts[0].value, 'A'.repeat(128));
  assert.deepEqual(await readdir(data.root), before);
  if (process.platform !== 'win32') {
    await writeFile(join(data.repoPath, 'a/identity.sh'), '#!/bin/sh\nprintf executable-value');
    await chmod(join(data.repoPath, 'a/identity.sh'), 0o755);
    await data.edit('a', manifest => { manifest.stale = { kind: 'identity', script: { command: 'identity.sh', args: [] } }; });
    assert.equal((await inspectProject(data)).plan.artifacts[0].value, 'executable-value');
  }
});

test('identity schema rejects unknown fields, unsafe paths, inline commands and invalid timeouts', async t => {
  const data = await fixture(t);
  const valid = { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } };
  for (const stale of [
    { ...valid, extra: true }, { ...valid, paths: [] }, { ...valid, script: { ...valid.script, timeoutMs: 1 } },
    ...[0, 900001, 1.5, '100'].map(timeoutMs => ({ ...valid, timeoutMs })),
    ...['../escape', '/absolute', 'a/../escape'].map(input => ({ ...valid, inputs: [input] })),
    { ...valid, inputs: ['rule.txt', 'rule.txt'] },
    ...[[], ['-e', 'console.log(1)'], ['../identity.mjs']].map(args => ({ ...valid, script: { command: 'node', args } })),
    { ...valid, script: { command: '/bin/sh', args: [] } },
  ]) {
    await data.edit('a', manifest => { manifest.stale = stale as any; });
    await assert.rejects(data.config(), /ccdd.json:/);
  }
});

test('default, file-hash and always identities match the pre-feature byte-for-byte baselines', async t => {
  const data = await artifactFixture(t);
  for (const name of ['default', 'narrow', 'always']) {
    await data.write(name, { name, critics: [runtimeCritic()], ...(name === 'narrow' ? { stale: { kind: 'file-hash' as const, paths: ['content.txt'] } } : name === 'always' ? { stale: { kind: 'always' as const } } : {}) }, { 'view.mjs': 'fixed entry' });
  }
  const config = await data.config(), snapshot = await createProjectSnapshot(config, data.repoPath, 'a'.repeat(64));
  // Captured with origin/main (89384fa) identity.ts against this exact fixture.
  const hashes = {
    always: '632fb55d9f199e7e342207fbbb46cfebdff63b13dc2e26fc857148e07ca3e7b4',
    default: 'fa548bfffb4c8e721f23ce26367749ae4d123a5a70ed5343b90bb1cf74c62fbe',
    narrow: 'b2d25300564240f21264c45f315a3247f6ac381020cd6c786695a532176cfc26',
  };
  assert.deepEqual(snapshot.artifactHashes, hashes);
  assert.equal(snapshot.artifactIdentities, undefined);
  for (const critic of config.critics) {
    const criticHash = inputHash({ version: 2, executorVersion: packageVersion, critic, workspaceIntegrity: 'content', runtime: { node: process.versions.node, platform: process.platform, arch: process.arch } });
    const target = { id: critic.target, hash: hashes[critic.target as keyof typeof hashes] };
    assert.deepEqual(snapshot.inputs[critic.id], { version: 2, key: inputHash({ criticHash, target, deps: [] }), criticHash, target, deps: [], reusable: critic.target !== 'always', workspaceIntegrity: 'content' });
  }
});
