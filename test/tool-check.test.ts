import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseArtifactTools } from '../src/artifacts/tool-check.js';
import { removeOwnedWorkspaceTree } from '../src/workspaces/index.js';
import type { ArtifactTypeDefinition } from '../src/artifacts/types.js';
import type { CriticProfile } from '../src/contracts.js';

async function fixture(t: TestContext, script = "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],process.argv[3]);") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-tool-check-')));
  t.after(() => removeOwnedWorkspaceTree(dir));
  const repoPath = join(dir, 'repo');
  const stateDir = join(dir, 'state');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'why.md'), 'First line.\nSecond line.\n');
  const program = join(dir, 'viewer.mjs');
  const output = join(dir, 'launch.txt');
  await writeFile(program, script);
  const type: ArtifactTypeDefinition = { viewer: 'text', agentTools: { read: {} }, humanTools: { open: { description: 'Open {artifactName}.', command: process.execPath, args: [program, output, '{artifactPath}'] } } };
  const writeConfig = async (artifactType = type, profile: CriticProfile = { kind: 'human' }) => writeFile(join(repoPath, 'ccdd.config.json'), JSON.stringify({ artifacts: { why: { type: 'markdown', path: 'why.md' } }, artifactTypes: { markdown: artifactType }, critics: [{ id: 'review', title: 'Review Why', target: 'why', deps: [], profile, payload: { instruction: 'Review the supplied Artifact.' } }] }));
  await writeConfig();
  return { dir, repoPath, stateDir, program, output, type, writeConfig };
}

test('tool diagnosis defaults to a reusable copy and preflights without launching, Provider calls, or review records', async t => {
  const data = await fixture(t);
  await writeFile(join(data.repoPath, 'why.md'), Buffer.from([0, 1, 255]));
  await data.writeConfig({ viewer: 'files', humanTools: data.type.humanTools });
  const report = await diagnoseArtifactTools(data);
  assert.equal(report.status, 'READY', JSON.stringify(report));
  assert.equal(report.mode, 'copy');
  assert.ok(report.snapshotHash);
  assert.notEqual(report.workspacePath, data.repoPath);
  assert.equal(report.result, undefined);
  await assert.rejects(readFile(data.output), { code: 'ENOENT' });
  assert.deepEqual(await readdir(data.stateDir), ['workspaces']);
  assert.deepEqual(await readFile(join(report.workspacePath!, 'why.md')), Buffer.from([0, 1, 255]));
  assert.equal(JSON.stringify(report).includes(data.program), false);
});

test('explicit Human tool diagnosis uses the same registered command and retains the copied input for the launched viewer', async t => {
  const data = await fixture(t);
  const report = await diagnoseArtifactTools({ ...data, artifactId: 'why', audience: 'human', toolName: 'open_why', execute: true });
  assert.equal(report.status, 'READY', JSON.stringify(report));
  assert.ok(report.result && 'kind' in report.result && report.result.kind === 'launch');
  assert.equal(await readFile(data.output, 'utf8'), join(report.workspacePath!, 'why.md'));
  assert.equal(await readFile(join(report.workspacePath!, 'why.md'), 'utf8'), 'First line.\nSecond line.\n');
  assert.equal(await readFile(join(data.repoPath, 'why.md'), 'utf8'), 'First line.\nSecond line.\n');
  assert.deepEqual(await readdir(data.stateDir), ['workspaces']);
});

test('explicit Agent tool diagnosis uses strict scoped registry arguments without running an Agent review', async t => {
  const data = await fixture(t);
  const options = { ...data, artifactId: 'why', audience: 'agent' as const, toolName: 'read_why', execute: true };
  const report = await diagnoseArtifactTools({ ...options, arguments: { startLine: 2, lineCount: 1 } });
  assert.equal(report.status, 'READY', JSON.stringify(report));
  assert.ok(report.result && 'content' in report.result && report.result.content === 'Second line.\n');
  for (const args of [{ path: '../private' }, { startLine: '2' }, { command: 'anything' }]) {
    const invalid = await diagnoseArtifactTools({ ...options, arguments: args });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.result, undefined);
  }
  assert.deepEqual(await readdir(data.stateDir), ['workspaces']);
});

test('actual tool diagnosis never accepts a mutated snapshot as a successful launch', async t => {
  const data = await fixture(t, "import {chmodSync,writeFileSync} from 'node:fs'; chmodSync(process.argv[3],0o644); writeFileSync(process.argv[3],'changed'); setInterval(()=>{},1000);");
  const report = await diagnoseArtifactTools({ ...data, artifactId: 'why', audience: 'human', toolName: 'open_why', execute: true });
  assert.equal(report.ok, false);
  assert.equal(report.result, undefined);
  assert.ok(report.checks.some(check => /workspace changed/i.test(check.message)), JSON.stringify(report));
  assert.equal(await readFile(join(data.repoPath, 'why.md'), 'utf8'), 'First line.\nSecond line.\n');
});

test('tool diagnosis rejects empty and legacy-only Critic audiences including ineffective file-list registrations', async t => {
  const data = await fixture(t);
  const types: ArtifactTypeDefinition[] = [{ viewer: 'text' }, { viewer: 'text', humanTools: {} }, { viewer: 'files', humanTools: { list: {} } }];
  for (const type of types) {
    await data.writeConfig(type);
    const report = await diagnoseArtifactTools(data);
    assert.equal(report.ok, false, JSON.stringify(report));
  }
});

test('execution requires explicit selection and output errors are sanitized', async t => {
  const data = await fixture(t, "process.stderr.write('fake-secret-should-not-leak'); process.exit(1);");
  const incomplete = await diagnoseArtifactTools({ ...data, execute: true, audience: 'human' });
  assert.equal(incomplete.ok, false);
  await assert.rejects(readdir(data.stateDir), { code: 'ENOENT' });
  const failure = await diagnoseArtifactTools({ ...data, execute: true, artifactId: 'why', audience: 'human', toolName: 'open_why' });
  assert.equal(failure.ok, false);
  assert.equal(JSON.stringify(failure).includes('fake-secret'), false);
  assert.equal(failure.result, undefined);
});

test('tool diagnosis accepts short names only with an explicit Artifact and keeps published names canonical', async t => {
  const data = await fixture(t);
  for (const [audience, toolName] of [['human', 'open'], ['human', 'open_why'], ['agent', 'read'], ['agent', 'read_why']] as const) {
    const report = await diagnoseArtifactTools({ ...data, artifactId: 'why', audience, toolName, execute: true });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.tools[0].name, audience === 'human' ? 'open_why' : 'read_why');
    assert.equal(report.checks.at(-1)?.toolName, report.tools[0].name);
  }
  const preflight = await diagnoseArtifactTools({ ...data, artifactId: 'why', audience: 'human', toolName: 'open' });
  assert.equal(preflight.ok, true, JSON.stringify(preflight));
  for (const options of [{ artifactId: 'why', toolName: 'missing' }, { toolName: 'open' }]) {
    const report = await diagnoseArtifactTools({ ...data, ...options, audience: 'human' });
    assert.equal(report.ok, false);
    assert.equal(report.result, undefined);
  }
});
