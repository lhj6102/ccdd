import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { artifactFixture, fixtureViews, runtimeCritic } from './helpers/artifacts.js';
import { inspectProject, createProjectSnapshot } from '../src/project/index.js';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { projectRun } from '../src/project/store.js';
import { main } from '../src/project/cli.js';
import { inputHash } from '../src/project/identity.js';

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
  const data = await fixture(t), broker = createBroker({ detail: 'full', ...data, executors: createExecutorRegistry() });
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
    const plain = await cli(data, args); assert.equal(plain.code, 0); if (args[0] === 'run') assert.equal(JSON.parse(plain.output).validation.artifacts[0].value, 'equivalent-v1');
    else assert.match(plain.output, /identity: script · value: equivalent-v1/);
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

test('owner values ignore entry, definitions and environment changes but retain dependency identities', async t => {
  const data = await fixture(t);
  await data.write('basis', { name: 'basis', basis: true });
  await data.edit('a', manifest => { manifest.mounts = { basis: 'basis' }; manifest.envRequirements = { ready: { description: 'Ready', script: 'ready.mjs' } }; });
  await writeFile(join(data.repoPath, 'a/ready.mjs'), 'process.exit(0)');
  let before = (await inspectProject({ ...data, detail: 'full' })).snapshot;
  for (const [path, contents] of [['a/identity.mjs', 'console.log("equivalent-v1");'], ['a/rule.txt', 'rule two'], ['a/ready.mjs', '// changed environment'], ['basis/content.txt', 'dependency change']]) {
    await writeFile(join(data.repoPath, path), contents);
    const after = (await inspectProject({ ...data, detail: 'full' })).snapshot;
    if (path.startsWith('basis/')) assert.notEqual(after.inputs['a/check'].key, before.inputs['a/check'].key, path);
    else assert.equal(after.inputs['a/check'].key, before.inputs['a/check'].key, path);
    before = after;
  }
  await data.edit('a', manifest => { manifest.views!.agentTools!.read.metadata.description = 'Changed tool contract'; });
  assert.equal((await inspectProject({ ...data, detail: 'full' })).snapshot.inputs['a/check'].key, before.inputs['a/check'].key);
});

test('identity discovery is inert, while invalid output and exits fail queries without fallback or leaked diagnostics', async t => {
  const data = await fixture(t);
  for (const output of ['', 'two\nlines', 'space here', 'a\n\n', 'a\r\n', 'a'.repeat(129), 'é', 'a\u0000']) {
    await writeFile(join(data.repoPath, 'a/identity.mjs'), `process.stdout.write(${JSON.stringify(output)});`);
    await assert.rejects(inspectProject({ ...data, detail: 'full' }), /Identity script for Artifact a stdout must be one line/);
  }
  await writeFile(join(data.repoPath, 'a/identity.mjs'), 'console.log("valid");console.error("PRIVATE_DIAGNOSTIC");process.exit(5);');
  assert.equal((await cli(data, ['config', 'check'])).code, 0);
  assert.equal((await cli(data, ['graph'])).code, 0);
  await assert.rejects(inspectProject({ ...data, detail: 'full' }), error => {
    assert.match(String(error), /Identity script for Artifact a failed \(exit 5\)/);
    assert.doesNotMatch(String(error), /PRIVATE_DIAGNOSTIC/); return true;
  });
  const broker = createBroker({ detail: 'full', ...data, executors: createExecutorRegistry() }); data.cleanup(() => broker.close());
  await assert.rejects(broker.submitProject({ selection: { kind: 'all' } }), /Identity script/);
  assert.equal(broker.listRuns().length, 0);
});

test('identity scripts honor timeout, cancellation, bounded output and unchanged workspace integrity', async t => {
  const data = await fixture(t, 'await new Promise(()=>setInterval(()=>{},1000));');
  await data.edit('a', manifest => { if (manifest.stale?.kind === 'identity') manifest.stale.timeoutMs = 120; });
  await assert.rejects(inspectProject({ ...data, detail: 'full' }), /Identity script for Artifact a timed out after 120 ms/);
  await data.edit('a', manifest => { if (manifest.stale?.kind === 'identity') manifest.stale.timeoutMs = 5000; });
  const controller = new AbortController(), pending = inspectProject({ detail: 'full', ...data, signal: controller.signal });
  setTimeout(() => controller.abort(), 80); await assert.rejects(pending);
  await writeFile(join(data.repoPath, 'a/identity.mjs'), 'process.stdout.write("a".repeat(70000));');
  await assert.rejects(inspectProject({ ...data, detail: 'full' }), /output exceeded 64 KiB/);
  await writeFile(join(data.repoPath, 'a/identity.mjs'), 'import {writeFileSync} from "node:fs";writeFileSync("content.txt","mutation");console.log("valid");');
  await assert.rejects(inspectProject({ ...data, detail: 'full' }), /workspace changed|aborted/i);
});

test('identity scripts use owner cwd, entry arguments, safe environment and optional inputs without leaving state', async t => {
  const data = await fixture(t, 'import assert from "node:assert/strict";import {readFileSync} from "node:fs";assert.equal(process.argv[2],"argument");assert.equal(process.env.NODE_OPTIONS,undefined);assert.equal(process.env.OPENAI_API_KEY,undefined);assert.ok(process.env.CCDD_OUTPUT_DIR);assert.equal(readFileSync("rule.txt","utf8"),"rule one");console.log("A".repeat(128));');
  await data.edit('a', manifest => { if (manifest.stale?.kind === 'identity') { delete manifest.stale.inputs; manifest.stale.script.args.push('argument'); } });
  const before = await readdir(data.root);
  assert.equal((await inspectProject({ ...data, detail: 'full' })).plan.artifacts[0].value, 'A'.repeat(128));
  assert.deepEqual(await readdir(data.root), before);
  if (process.platform !== 'win32') {
    await writeFile(join(data.repoPath, 'a/identity.sh'), '#!/bin/sh\nprintf executable-value');
    await chmod(join(data.repoPath, 'a/identity.sh'), 0o755);
    await data.edit('a', manifest => { manifest.stale = { kind: 'identity', script: { command: 'identity.sh', args: [] } }; });
    assert.equal((await inspectProject({ ...data, detail: 'full' })).plan.artifacts[0].value, 'executable-value');
  }
});


test('selected queries and verification never execute or display unrelated identities, but include every dependency', async t => {
  const data = await fixture(t), marker = join(data.root, 'b-ran');
  await data.write('b', { name: 'b', stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } }, critics: [runtimeCritic()] }, {
    'identity.mjs': `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'ran');process.exit(7);`,
  });
  for (const command of ['verify', 'plan', 'status']) {
    await rm(marker, { force: true });
    for (const selection of [['a'], ['--critic', 'a/check']]) {
      for (const format of [[], ['--json']]) {
        const result = await cli(data, [command, ...selection, ...(command === 'verify' ? ['--wait'] : []), ...format]);
        assert.equal(result.code, 0, result.error || result.output);
        if (format.length) {
          const value = JSON.parse(result.output), plan = value.validation ?? value;
          assert.deepEqual(plan.artifacts.map((artifact: { id: string }) => artifact.id), ['a']);
          assert.deepEqual(plan.critics.map((critic: { id: string }) => critic.id), ['a/check']);
          assert.equal(plan.artifacts[0].value, 'equivalent-v1');
        } else {
          assert.match(result.output, /Artifact a:.*identity: script · value: equivalent-v1/);
          assert.doesNotMatch(result.output, /Artifact b:|b\/check/);
        }
        await assert.rejects(readFile(marker), { code: 'ENOENT' });
      }
    }
    for (const selection of [['b'], ['--critic', 'b/check'], ['--all']]) {
      const result = await cli(data, [command, ...selection]);
      assert.equal(result.code, 2);
      assert.match(result.error, /Identity script for Artifact b failed \(exit 7\)/);
    }
  }
  await data.edit('a', manifest => { manifest.mounts = { dependency: 'b' }; });
  for (const command of ['plan', 'status', 'verify']) {
    const result = await cli(data, [command, 'a']);
    assert.equal(result.code, 2);
    assert.match(result.error, /Identity script for Artifact b failed \(exit 7\)/);
  }
});

test('scoped snapshots preserve whole-project hashes, including dependency cycles and legacy identities', async t => {
  const data = await fixture(t);
  await data.write('b', { name: 'b', mounts: { a: 'a' }, stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } }, critics: [runtimeCritic()] }, { 'identity.mjs': 'console.log("b-value");' });
  await data.write('unrelated', { name: 'unrelated', critics: [runtimeCritic()] });
  await data.write('basis', { name: 'basis', basis: true, stale: { kind: 'file-hash', paths: ['content.txt'] } });
  await data.edit('a', manifest => { manifest.mounts = { b: 'b', basis: 'basis' }; });
  const whole = (await inspectProject({ ...data, detail: 'full' })).snapshot;
  for (const selection of [{ kind: 'artifact', artifactId: 'a' }, { kind: 'critic', criticId: 'a/check' }] as const) {
    const scoped = (await inspectProject({ detail: 'full', ...data, selection })).snapshot;
    assert.deepEqual(scoped.config, whole.config);
    assert.equal(scoped.snapshotHash, whole.snapshotHash);
    assert.deepEqual(Object.keys(scoped.artifactHashes).sort(), ['a', 'b', 'basis']);
    assert.deepEqual(Object.keys(scoped.inputs).sort(), ['a/check', 'b/check']);
    for (const [id, hash] of Object.entries(scoped.artifactHashes)) assert.equal(hash, whole.artifactHashes[id]);
    for (const [id, input] of Object.entries(scoped.inputs)) assert.deepEqual(input, whole.inputs[id]);
    assert.deepEqual(scoped.artifactIdentities, whole.artifactIdentities);
  }
});

for (const entrypoint of ['../src/project/cli.js', '../src/cli.js']) {
  for (const command of ['plan', 'status', 'verify']) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      test(`${entrypoint} ${command} cleans up identity processes and output on ${signal}`, { skip: process.platform === 'win32', timeout: 20000 }, async t => {
        await interruptedIdentity(t, entrypoint, command, signal);
      });
    }
  }
}
test('foreground identity timeout still terminates the child and removes temporary output', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  await interruptedIdentity(t, '../src/project/cli.js', 'plan');
});

async function interruptedIdentity(t: Parameters<typeof fixture>[0], entrypoint: string, command: string, signal?: 'SIGINT' | 'SIGTERM') {
  const data = await fixture(t), marker = join(data.root, 'identity-started');
  await writeFile(join(data.repoPath, 'a/identity.mjs'), `import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e','console.log("ready");setInterval(()=>{},1000);'],{stdio:['ignore','pipe','ignore']});
child.stdout.once('data',()=>writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,childPid:child.pid,outputDir:process.env.CCDD_OUTPUT_DIR})));
setInterval(()=>{},1000);`);
  await data.edit('a', manifest => { if (manifest.stale?.kind === 'identity') manifest.stale.timeoutMs = signal ? 15000 : 1000; });
  const child = spawn(process.execPath, [fileURLToPath(new URL(entrypoint, import.meta.url)), command, 'a', '--repo', data.repoPath, '--state-dir', data.stateDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let identity: { pid: number; childPid: number; outputDir: string } | undefined;
  try {
    const deadline = Date.now() + 10000;
    while (!identity && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      const contents = await readFile(marker, 'utf8').catch(() => '');
      if (contents) identity = JSON.parse(contents);
      else await delay(20);
    }
    assert.ok(identity, stderr || 'Identity did not start.');
    assert.match(identity.outputDir, /ccdd-identity-/);
    await readdir(identity.outputDir);
    if (signal) child.kill(signal);
    const result = await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => { throw new Error('Identity cancellation or timeout did not finish.'); })]);
    assert.deepEqual(result, { code: 2, signal: null }, stderr);
    assert.match(stderr, signal ? /Project validation cancelled\./ : /Identity script for Artifact a timed out after 1000 ms/);
    assert.throws(() => process.kill(identity!.pid, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(identity!.childPid, 0), { code: 'ESRCH' });
    await assert.rejects(readdir(identity.outputDir), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (identity) {
      try { process.kill(-identity.pid, 'SIGKILL'); } catch { /* Already cleaned up. */ }
      await rm(identity.outputDir, { recursive: true, force: true });
    }
    await exited;
  }
}

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

test('default identities use the new format without package or runtime version signals', async t => {
  const data = await artifactFixture(t);
  for (const name of ['default', 'narrow', 'always']) await data.write(name, { name, critics: [runtimeCritic()], ...(name === 'narrow' ? { stale: { kind: 'file-hash' as const, paths: ['content.txt'] } } : name === 'always' ? { stale: { kind: 'always' as const } } : {}) });
  const config = await data.config(), before = await createProjectSnapshot(config, data.repoPath, 'a'.repeat(64));
  const node = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
  try {
    Object.defineProperty(process.versions, 'node', { ...node, value: '99.0.0' });
    const after = await createProjectSnapshot(config, data.repoPath, 'b'.repeat(64));
    assert.deepEqual(after.inputs, before.inputs);
  } finally { Object.defineProperty(process.versions, 'node', node); }
  // CCDD package metadata is external to these Artifact roots and is not an identity signal.
  await writeFile(join(data.repoPath, 'package.json'), JSON.stringify({ version: '999.0.0' }));
  assert.deepEqual((await createProjectSnapshot(config, data.repoPath, 'c'.repeat(64))).inputs, before.inputs);
  for (const critic of config.critics) {
    const target = { id: critic.target, hash: before.artifactHashes[critic.target] };
    assert.equal(before.inputs[critic.id].version, 3);
    assert.equal(before.inputs[critic.id].key, inputHash({ version: 3, criticId: critic.id, target, deps: [] }));
  }
});
