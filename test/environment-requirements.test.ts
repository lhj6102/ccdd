import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readWorkspaceConfig } from '../src/broker/config.js';
import { checkEnvironmentRequirements } from '../src/tools/environment.js';
import { hashExecutionInputs, resolveExecutionInput } from '../src/tools/inputs.js';
import { createReviewTools } from '../src/tools/runner.js';
import { createProjectSnapshot } from '../src/project/identity.js';
import type { ConfigManifest, EnvironmentRequirement } from '../src/tools/contracts.js';
import { launchToolProcess } from '../packages/default-tools/src/process.js';
import { prepareWorkspace, removeOwnedWorkspaceTree } from '../src/workspaces/index.js';

const tool = `{ metadata: { description: 'Inspect {artifactName}.', inputSchema: { type: 'object', additionalProperties: false }, resultKinds: ['text'], observation: 'none' }, execute() { return { content: [{ type: 'text', text: 'available' }] }; } }`;

async function fixture(t: TestContext, options: { requirements?: Record<string, EnvironmentRequirement>; script?: string; executionPaths?: string[] } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-environment-'))), root = join(dir, 'project');
  await mkdir(join(root, 'checks'), { recursive: true });
  await mkdir(join(root, 'runtime'));
  await writeFile(join(root, 'spec.txt'), 'Review input');
  await writeFile(join(root, 'runtime', 'viewer'), 'version one');
  await writeFile(join(root, 'checks', 'ready.mjs'), options.script ?? 'console.log("The reviewer environment is ready.");');
  const requirements = options.requirements ?? { runtime: { description: 'Install the required runtime.', script: 'checks/ready.mjs' } };
  const humanTool = options.executionPaths ? tool.replace("observation: 'none'", `observation: 'none', executionPaths: ${JSON.stringify(options.executionPaths)}`) : tool;
  const source = `export default {
    artifacts: { spec: { type: 'text', path: 'spec.txt' } },
    artifactTypes: { text: { humanTools: { inspect: ${humanTool} }, agentTools: { inspect: ${tool} } } },
    envRequirements: ${JSON.stringify(requirements)},
    critics: [
      { id: 'human', title: 'Human review', target: 'spec', deps: [], profile: { kind: 'human' }, payload: { instruction: 'Review spec.' } },
      { id: 'agent', title: 'Agent review', target: 'spec', deps: [], profile: { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' }, payload: { instruction: 'Review spec.' } }
    ]
  };`;
  await writeFile(join(root, 'ccdd.config.ts'), source);
  t.after(() => removeOwnedWorkspaceTree(dir));
  const config = async () => (await readWorkspaceConfig(root)).config;
  const manifest = async () => (await config()).configManifest!;
  const run = async (configManifest?: ConfigManifest, signal?: AbortSignal) => checkEnvironmentRequirements({ workspacePath: root, outputDir: join(dir, 'output'), configManifest: configManifest ?? await manifest(), signal });
  return { dir, root, source, config, manifest, run };
}

test('environment declarations and script hashes persist without executing checks during config or tool preparation', async t => {
  const data = await fixture(t, { script: `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CCDD_OUTPUT_DIR + '/checked', 'yes');` });
  const config = await data.config();
  assert.deepEqual(config.configManifest?.envRequirements, { runtime: { description: 'Install the required runtime.', script: 'checks/ready.mjs' } });
  assert.deepEqual(config.configManifest?.environmentInputs?.map(input => input.path), ['checks/ready.mjs']);
  const registry = await createReviewTools({ worktreePath: data.root, artifacts: [{ id: 'spec', type: 'text', path: 'spec.txt' }], artifactTypes: config.artifactTypes, configManifest: config.configManifest, audience: 'human', runDir: join(data.dir, 'tools') });
  try { assert.equal((await registry.preflight())[0].ok, true); }
  finally { await registry.close(); }
  await assert.rejects(readFile(join(data.dir, 'output', 'runtime', 'checked')), { code: 'ENOENT' });
  assert.equal((await data.run(config.configManifest)).ok, true);
  assert.equal(await readFile(join(data.dir, 'output', 'runtime', 'checked'), 'utf8'), 'yes');
  assert.deepEqual(await checkEnvironmentRequirements({ workspacePath: '/not-needed', outputDir: '/not-needed' }), { ok: true, checks: [] });
});

test('checks use the reviewer PATH and home while rejecting inherited credentials and Node startup hooks', async t => {
  if (process.platform === 'win32') return;
  const data = await fixture(t, { script: `import assert from 'node:assert/strict'; import { spawnSync } from 'node:child_process';
    assert.ok(process.env.HOME); assert.equal(process.env.OPENAI_API_KEY, undefined); assert.equal(process.env.NODE_OPTIONS, undefined);
    const result = spawnSync('reviewer-cargo', ['--version'], { encoding: 'utf8' });
    if (result.status !== 0) { console.error('Install Cargo and add it to PATH.'); process.exit(1); }
    console.log(result.stdout.trim());` });
  const bin = join(data.dir, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'reviewer-cargo'), '#!/bin/sh\nprintf "cargo fixture 1.0\\n"\n', { mode: 0o755 });
  const original = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY, NODE_OPTIONS: process.env.NODE_OPTIONS };
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, OPENAI_API_KEY: 'not-for-project-code', NODE_OPTIONS: '--require=/this-must-never-load.cjs' });
  t.after(() => { for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const result = await data.run();
  assert.equal(result.ok, true);
  assert.match(result.checks[0].message, /cargo fixture 1\.0/);
});

test('failed environment checks return actionable stderr without producing a semantic review verdict', async t => {
  const data = await fixture(t, { script: `console.error('Install Rust with Cargo, then retry this claim.'); process.exit(7);` });
  const result = await data.run();
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].id, 'runtime');
  assert.match(result.checks[0].message, /exit 7.*Install the required runtime[\s\S]*Install Rust with Cargo/);
  assert.equal(Object.hasOwn(result, 'verdict'), false);
});

test('Human tools receive checked home settings only after snapshot configuration is loaded', async t => {
  const data = await fixture(t);
  const previous = process.env.CARGO_HOME;
  process.env.CARGO_HOME = join(data.dir, 'reviewer-cargo');
  t.after(() => { if (previous === undefined) delete process.env.CARGO_HOME; else process.env.CARGO_HOME = previous; });
  await writeFile(join(data.root, 'ccdd.config.ts'), `const configHome = process.env.HOME ?? null;\n${data.source.replaceAll("resultKinds: ['text']", "resultKinds: ['json']").replaceAll("content: [{ type: 'text', text: 'available' }]", "content: [{ type: 'json', data: { configHome, home: process.env.HOME, cargo: process.env.CARGO_HOME } }]")}`);
  const config = await data.config();
  const registry = await createReviewTools({ worktreePath: data.root, artifacts: [{ id: 'spec', type: 'text', path: 'spec.txt' }], artifactTypes: config.artifactTypes, configManifest: config.configManifest, audience: 'human', runDir: join(data.dir, 'tools') });
  try {
    assert.deepEqual((await registry.call('inspect_spec')).content[0].data, { configHome: null, home: process.env.HOME, cargo: process.env.CARGO_HOME });
  } finally { await registry.close(); }
});

test('environment scripts time out, cancel, and retain bounded diagnostics', async t => {
  const timed = await fixture(t, { requirements: { wait: { description: 'Wait check', script: 'checks/ready.mjs', timeoutMs: 50 } }, script: 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);' });
  assert.match((await timed.run()).checks[0].message, /timed out after 50 ms/);
  const cancelled = await fixture(t, { script: `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CCDD_OUTPUT_DIR + '/started', 'yes'); setInterval(() => {}, 1000);` });
  const manifest = await cancelled.manifest(), controller = new AbortController();
  const cancellation = assert.rejects(cancelled.run(manifest, controller.signal), /Claim reservation expired/);
  const deadline = Date.now() + 5000;
  let started = false;
  while (!started && Date.now() < deadline) {
    started = await readFile(join(cancelled.dir, 'output', 'runtime', 'started')).then(() => true, () => false);
    if (!started) await delay(20);
  }
  controller.abort(new Error('Claim reservation expired.'));
  await cancellation;
  assert.equal(started, true, 'Cancellation must stop an actual running check script.');
  const noisy = await fixture(t, { script: 'process.stderr.write("x".repeat(100000)); setInterval(() => {}, 1000);' });
  const result = await noisy.run();
  assert.equal(result.ok, false);
  assert.match(result.checks[0].message, /exceeded 64 KiB/);
  assert.ok(result.checks[0].message.length <= 4000);
});

test('changed environment scripts cannot execute against a recorded manifest', async t => {
  const data = await fixture(t), recorded = await data.manifest();
  await writeFile(join(data.root, 'checks', 'ready.mjs'), 'throw new Error("Changed script must not execute");');
  await assert.rejects(data.run(recorded), /do not match this snapshot/);
  await assert.rejects(checkEnvironmentRequirements({ workspacePath: data.root, configManifest: await data.manifest(), outputDir: join(data.root, 'forbidden') }), /outside reviewed input/);
  await assert.rejects(readFile(join(data.root, 'forbidden')), { code: 'ENOENT' });
});

test('unsafe environment declarations and imports outside the snapshot are rejected', async t => {
  for (const script of ['../outside.mjs', '/tmp/outside.mjs', 'C:/outside.mjs', 'checks/ready.sh']) {
    const data = await fixture(t, { requirements: { check: { description: 'Check environment', script } } });
    await assert.rejects(data.config(), /safe project-relative|Node JavaScript/);
  }
  const data = await fixture(t, { script: `import '../outside.mjs';` });
  // The script is under checks/, so reaching outside the snapshot needs two parent segments.
  await writeFile(join(data.root, 'checks', 'ready.mjs'), `import '../../outside.mjs';`);
  await writeFile(join(data.dir, 'outside.mjs'), 'console.log("outside");');
  const result = await data.run();
  assert.equal(result.ok, false);
  assert.match(result.checks[0].message, /imports must resolve inside the snapshot/);
});

test('environment inputs and bundled runtime bytes invalidate only the relevant effective definitions', async t => {
  const data = await fixture(t, { requirements: { runtime: { description: 'Runtime check', script: 'checks/ready.mjs', inputs: ['checks/version.txt'] } }, executionPaths: ['runtime'] });
  await writeFile(join(data.root, 'checks', 'version.txt'), 'one');
  const capture = async () => createProjectSnapshot(await data.config(), data.root, 'a'.repeat(64));
  const first = await capture();
  await writeFile(join(data.root, 'checks', 'version.txt'), 'two');
  const environmentChanged = await capture();
  assert.notEqual(first.inputs.human.key, environmentChanged.inputs.human.key);
  assert.equal(first.inputs.agent.key, environmentChanged.inputs.agent.key);
  assert.equal(first.artifactHashes.spec, environmentChanged.artifactHashes.spec);
  await writeFile(join(data.root, 'runtime', 'viewer'), 'version two');
  const runtimeChanged = await capture();
  assert.notEqual(environmentChanged.inputs.human.key, runtimeChanged.inputs.human.key);
  assert.equal(environmentChanged.inputs.agent.key, runtimeChanged.inputs.agent.key);
  const relocated = join(data.dir, 'other-computer'); await cp(data.root, relocated, { recursive: true });
  assert.deepEqual((await readWorkspaceConfig(relocated)).config.configManifest, (await data.config()).configManifest);
});

test('bundled runtime resolution permits only declared content and safely hashes internal symlinks', async t => {
  const data = await fixture(t);
  await symlink('viewer', join(data.root, 'runtime', 'alias'));
  const first = await hashExecutionInputs(data.root, ['runtime']);
  assert.equal(await resolveExecutionInput(data.root, ['runtime'], 'runtime/alias'), join(data.root, 'runtime', 'viewer'));
  await assert.rejects(resolveExecutionInput(data.root, ['runtime'], 'spec.txt'), /not declared/);
  await assert.rejects(resolveExecutionInput(data.root, ['runtime'], 'runtime/../spec.txt'), /safe project-relative/);
  await chmod(join(data.root, 'runtime', 'viewer'), 0o755);
  assert.notDeepEqual(await hashExecutionInputs(data.root, ['runtime']), first);
  await symlink('../spec.txt', join(data.root, 'runtime', 'outside'));
  await assert.rejects(hashExecutionInputs(data.root, ['runtime']), /inside their declared execution input/);
  await assert.rejects(resolveExecutionInput(data.root, ['runtime'], 'runtime/outside'), /inside their declared execution input/);
});

test('the default project opener executes the bundled launcher through the snapshot Runner', async t => {
  if (process.platform === 'win32') return;
  const data = await fixture(t);
  const library = dirname(fileURLToPath(import.meta.resolve('@ccdd/default-tools')));
  await cp(library, join(data.root, 'tool-library'), { recursive: true });
  await writeFile(join(data.root, 'runtime', 'viewer'), '#!/bin/sh\nprintf "%s" "$1" > "$CCDD_OUTPUT_DIR/receipt.txt"\nprintf "%s" "$$" > "$CCDD_OUTPUT_DIR/pid"\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  await chmod(join(data.root, 'runtime', 'viewer'), 0o755);
  await symlink('viewer', join(data.root, 'runtime', 'alias'));
  await writeFile(join(data.root, 'ccdd.config.ts'), `import { human } from './tool-library/index.js';\n${data.source.replace(`humanTools: { inspect: ${tool} }`, `humanTools: { inspect: human.project.open({ runtime: 'runtime', executable: 'alias' }) }`)}`);
  const config = await data.config();
  assert.deepEqual(config.configManifest?.types.text.humanTools.inspect.executionPaths, ['runtime']);
  const workspace = await prepareWorkspace({ repoPath: data.root, stateDir: join(data.dir, 'state'), mode: 'copy' });
  const snapshotRoot = workspace.descriptor.path;
  t.after(() => workspace.close());
  const registry = await createReviewTools({ worktreePath: snapshotRoot, artifacts: [{ id: 'spec', type: 'text', path: 'spec.txt' }], artifactTypes: config.artifactTypes, configManifest: config.configManifest, audience: 'human', runDir: join(data.dir, 'launch') });
  let pid: number | undefined;
  t.after(() => { if (pid) try { process.kill(-pid, 'SIGKILL'); } catch { /* The desktop process already exited. */ } });
  try {
    assert.equal((await registry.preflight())[0].ok, true);
    const result = await registry.call('inspect_spec');
    assert.deepEqual(result, { content: [{ type: 'launch', launched: true }] });
    const { readdir } = await import('node:fs/promises');
    const [output] = await readdir(join(data.dir, 'launch'));
    assert.equal(await readFile(join(data.dir, 'launch', output, 'receipt.txt'), 'utf8'), join(snapshotRoot, 'spec.txt'));
    pid = Number(await readFile(join(data.dir, 'launch', output, 'pid'), 'utf8'));
  } finally { await registry.close(); }
  assert.ok(pid && pid > 0);
  process.kill(pid, 0);
  await workspace.assertUnchanged(); await workspace.close();
  await rm(data.root, { recursive: true });
  assert.equal(await readFile(join(snapshotRoot, 'spec.txt'), 'utf8'), 'Review input', 'The desktop application retains its immutable input after the original source is removed.');
});

test('bundled viewers retain reviewer desktop connections with a private writable home', async t => {
  if (process.platform === 'win32') return;
  const data = await fixture(t), reviewerHome = join(data.dir, 'reviewer-home');
  await mkdir(reviewerHome);
  const defaultAuthority = join(reviewerHome, '.Xauthority'), explicitAuthority = join(data.dir, 'reviewer-x11-cookie');
  await writeFile(defaultAuthority, 'Deterministic X11 test fixture');
  await writeFile(explicitAuthority, 'Deterministic explicit X11 test fixture');
  const desktopEnv = { HOME: reviewerHome, XAUTHORITY: explicitAuthority, DISPLAY: ':123', WAYLAND_DISPLAY: 'wayland-test', XDG_RUNTIME_DIR: join(data.dir, 'reviewer-runtime'), DBUS_SESSION_BUS_ADDRESS: 'unix:path=/test/reviewer-bus', OPENAI_API_KEY: 'not-for-project-code' };
  const previous = Object.fromEntries(Object.keys(desktopEnv).map(name => [name, process.env[name]]));
  Object.assign(process.env, desktopEnv);
  t.after(() => { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  await cp(dirname(fileURLToPath(import.meta.resolve('@ccdd/default-tools'))), join(data.root, 'tool-library'), { recursive: true });
  await writeFile(join(data.root, 'runtime', 'viewer'), '#!/bin/sh\nprintf "%s\\n" "$HOME" "$XAUTHORITY" "$DISPLAY" "$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" "$OPENAI_API_KEY" > "$CCDD_OUTPUT_DIR/environment.txt"\nprintf "private settings" > "$HOME/viewer-settings.txt"\n');
  await chmod(join(data.root, 'runtime', 'viewer'), 0o755);
  await writeFile(join(data.root, 'ccdd.config.ts'), `import { human } from './tool-library/index.js';
    if (process.env.HOME !== undefined || process.env.XDG_RUNTIME_DIR !== undefined) throw new Error('Reviewer home and runtime directory must not enter config evaluation.');
    ${data.source.replace(`humanTools: { inspect: ${tool} }`, `humanTools: { inspect: human.project.open({ runtime: 'runtime', executable: 'viewer' }) }`)}`);
  const config = await data.config();
  const launchRoot = join(data.dir, 'launch');
  const registry = await createReviewTools({ worktreePath: data.root, artifacts: [{ id: 'spec', type: 'text', path: 'spec.txt' }], artifactTypes: config.artifactTypes, configManifest: config.configManifest, audience: 'human', runDir: launchRoot });
  try {
    for (const authority of [explicitAuthority, defaultAuthority]) {
      if (authority === defaultAuthority) delete process.env.XAUTHORITY;
      assert.equal((await registry.preflight())[0].ok, true);
      assert.deepEqual(await registry.call('inspect_spec'), { content: [{ type: 'launch', launched: true }] });
      const [output] = await readdir(launchRoot), outputDir = join(launchRoot, output);
      const [home, ...observed] = (await readFile(join(outputDir, 'environment.txt'), 'utf8')).split('\n');
      assert.equal(home, join(outputDir, '.tmp'));
      assert.deepEqual(observed, [authority, desktopEnv.DISPLAY, desktopEnv.WAYLAND_DISPLAY, desktopEnv.XDG_RUNTIME_DIR, desktopEnv.DBUS_SESSION_BUS_ADDRESS, '', '']);
      assert.equal(await readFile(join(home, 'viewer-settings.txt'), 'utf8'), 'private settings');
      await assert.rejects(readFile(join(reviewerHome, 'viewer-settings.txt')), { code: 'ENOENT' });
    }
  } finally { await registry.close(); }
});

test('desktop process handoff reports startup failure and cancellation without leaving an owned process', async t => {
  if (process.platform === 'win32') return;
  const data = await fixture(t), controller = new AbortController();
  const options = { cwd: data.dir, env: { PATH: process.env.PATH }, signal: controller.signal, timeoutMs: 1000 };
  await assert.rejects(launchToolProcess('/not-a-ccdd-program', [], options), /could not be started/);
  await assert.rejects(launchToolProcess('/bin/sh', ['-c', 'exit 7'], options), /failed during startup/);
  const marker = join(data.dir, 'launch-pid');
  const launching = launchToolProcess('/bin/sh', ['-c', 'echo $$ > "$1"; sleep 30', 'launcher', marker], options);
  const cancelled = assert.rejects(launching, /launch was cancelled/);
  let pid: number | undefined;
  for (let attempt = 0; attempt < 40 && !pid; attempt++) {
    pid = await readFile(marker, 'utf8').then(value => Number(value), () => undefined);
    if (!pid) await delay(1);
  }
  controller.abort(); await cancelled;
  assert.ok(pid, 'Cancellation must cover a process that actually started.');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
