import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecutorRegistry } from '../src/executors/index.js';
import { diagnoseProject } from '../src/doctor/index.js';
import { fingerprintWorkspace, removeOwnedWorkspaceTree } from '../src/workspaces/index.js';
import { errorCode, errorMessage } from '../src/executors/errors.js';
import type { AgentProfile, RuntimeProfile, ReviewEnvelope, RepoConfig, ExecutionContext, ExecutionEvent, ProbeResult, ArtifactToolCall } from '../src/contracts.js';
import type { StreamFn } from '../src/executors/pi.js';
import { artifactStream, type ArtifactStreamOptions } from './pi-fixture.js';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-doctor-test-'));
  t.after(() => removeOwnedWorkspaceTree(dir));
  const worktreePath = join(dir, 'repo');
  await mkdir(join(worktreePath, 'tests'), { recursive: true });
  await writeFile(join(worktreePath, 'why.md'), 'Current why.');
  await writeFile(join(worktreePath, 'spec.md'), 'Current spec.');
  await writeFile(join(worktreePath, 'tests/check.test.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('SHOULD_NOT_RUN','bad'); throw new Error('doctor must not run this');");
  const profile: AgentProfile = { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium', timeoutMs: 3_000 };
  const config: RepoConfig = {
    artifacts: { why: { type: 'markdown', path: 'why.md' }, spec: { type: 'markdown', path: 'spec.md' }, tests: { type: 'code', path: 'tests' } },
    artifactTypes: { markdown: { viewer: 'text' }, code: { viewer: 'files' } },
    critics: [
      { id: 'first', title: 'first', dependsOn: null, artifacts: ['why'], profile, payload: { instruction: 'Review why' } },
      { id: 'second', title: 'second', dependsOn: 'first', artifacts: ['spec'], profile: { timeoutMs: 3_000, reasoning: 'medium', model: 'gpt-6-astra', provider: 'openai-codex', kind: 'agent' }, payload: { instruction: 'Review spec' } },
      { id: 'runtime', title: 'runtime', dependsOn: 'second', artifacts: ['tests'], profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/check.test.mjs'] }, payload: { instruction: 'Run tests' } },
      { id: 'human', title: 'human', dependsOn: 'runtime', artifacts: ['spec'], profile: { kind: 'human' }, payload: { instruction: 'Human review' } },
    ],
  };
  await writeFile(join(worktreePath, 'ccdd.config.json'), JSON.stringify(config));
  const snapshotHash = await fingerprintWorkspace(worktreePath);
  const request: ReviewEnvelope = { repoId: 'test-repo', title: 'Doctor fixture', criticId: 'first', snapshotHash, profile, dependsOn: null, payload: { instruction: 'Review why' }, artifacts: [{ id: 'why', ...config.artifacts.why }], artifactTypes: config.artifactTypes };
  return { dir, worktreePath, repoPath: worktreePath, runDir: join(dir, 'run'), stateDir: join(dir, 'state'), snapshotHash, request, config };
}

test('Agent readiness uses Pi with the exact profile and observed Artifact nonce', async t => {
  const data = await fixture(t);
  let firstContext = '', observedNonce = '';
  const profileCalls: Array<{ provider: string; model: string; reasoning?: string }> = [];
  const registry = createExecutorRegistry({ streamFn: artifactStream({ onRequest: ({model, context, options}) => {
    firstContext ||= JSON.stringify(context);
    profileCalls.push({ provider: model.provider, model: model.id, reasoning: options?.reasoning });
    for (const message of context.messages) {
      if (message.role !== 'toolResult') continue;
      const block = message.content.find(item => item.type === 'text');
      if (block?.type === 'text') {
        const data: unknown = JSON.parse(block.text);
        if (data && typeof data === 'object' && 'content' in data && typeof data.content === 'string') observedNonce = data.content.trim();
      }
    }
  } }) });
  const events: ExecutionEvent[] = [];
  const result = await registry.probe(data.request, { ...data, onEvent: event => { events.push(event); } });
  assert.equal(result.ok, true);
  assert.equal(result.details.operation, 'provider-artifact-roundtrip');
  assert.equal(result.details.authenticationVerified, true);
  assert.equal(result.details.modelAccessVerified, true);
  assert.equal(result.details.artifactToolsVerified, true);
  const toolCalls = observedCalls(result);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].observation.lineCount, 1);
  assert.match(toolCalls[0].name, /^read_ccdd_probe_/);
  assert.equal('verdict' in result, false);
  assert.doesNotMatch(JSON.stringify({ result, events }), /PRIVATE_REASONING|SECRET_TOKEN|sk-secret/);
  assert.ok(profileCalls.length >= 2);
  assert.ok(profileCalls.every(call => call.provider === 'openai-codex' && call.model === 'gpt-6-astra' && call.reasoning === 'medium'));
  assert.match(observedNonce, /^[0-9a-f]{64}$/);
  assert.equal(firstContext.includes(observedNonce), false);
  assert.equal((await readdir(data.worktreePath)).some(name => name.startsWith('.ccdd-doctor-')), false);
});

function observedCalls(result: ProbeResult): ArtifactToolCall[] {
  assert.ok(Array.isArray(result.details.toolCalls));
  return result.details.toolCalls as ArtifactToolCall[];
}

test('readiness identifies explicit auth, model and network errors without exposing Provider output', async t => {
  const expected: Array<[ArtifactStreamOptions['mode'], string]> = [['auth-error', 'AUTHENTICATION_FAILED'], ['model-error', 'MODEL_ACCESS_FAILED'], ['network-error', 'PROVIDER_CONNECTION_FAILED'], ['unknown-error', 'PROVIDER_EXECUTION_FAILED']];
  for (const [mode, code] of expected) {
    const data = await fixture(t);
    const registry = createExecutorRegistry({ streamFn: artifactStream({ mode }) });
    await assert.rejects(registry.probe(data.request, data), error => {
      assert.equal(errorCode(error), code);
      assert.ok(error && typeof error === 'object' && 'remedy' in error && error.remedy);
      assert.doesNotMatch(errorMessage(error), /SECRET_TOKEN|PRIVATE_REASONING/);
      return true;
    });
    assert.equal((await readdir(data.runDir)).some(name => name.startsWith('diagnostic-input-')), false);
  }
});

test('a fabricated nonce, unaudited response or hung provider cannot pass readiness', async t => {
  const modes: ArtifactStreamOptions['mode'][] = ['no-tools', 'wrong-nonce', 'beyond-eof', 'hang'];
  for (const mode of modes) {
    const data = await fixture(t);
    const registry = createExecutorRegistry({ streamFn: artifactStream({ mode, result: { ready: true, nonce: 'fabricated' } }) });
    const request: ReviewEnvelope = mode === 'hang' ? { ...data.request, profile: { ...data.request.profile, kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium', timeoutMs: 120 } } : data.request;
    await assert.rejects(registry.probe(request, data), error => errorCode(error) === (mode === 'hang' ? 'PROVIDER_TIMEOUT' : 'ARTIFACT_ROUNDTRIP_FAILED'));
    assert.equal((await readdir(data.runDir)).some(name => name.startsWith('diagnostic-input-')), false);
  }
});

test('runtime readiness starts Node and checks declared test paths without executing project tests', async t => {
  const data = await fixture(t);
  const registry = createExecutorRegistry();
  const request: ReviewEnvelope & {profile: RuntimeProfile} = { ...data.request, profile: {kind: 'runtime', command: 'node', args: ['--test', 'tests/check.test.mjs']}, artifacts: [{ id: 'tests', ...data.config.artifacts.tests }] };
  const result = await registry.probe(request, data);
  assert.equal(result.ok, true);
  assert.equal(result.details.testsExecuted, false);
  await assert.rejects(access(join(data.worktreePath, 'SHOULD_NOT_RUN')));
  await assert.rejects(registry.probe({ ...request, profile: { ...request.profile, args: ['--test', 'tests/missing.mjs'] } }, data), error => errorCode(error) === 'RUNTIME_TEST_PATH_UNAVAILABLE');
  await assert.rejects(registry.probe({ ...request, profile: { ...request.profile, args: ['--test', 'why.md'] } }, data), error => errorCode(error) === 'RUNTIME_TEST_PATH_OUTSIDE_ARTIFACTS');
});

test('Human readiness is explicitly registration-only and never sends a notification', async t => {
  const data = await fixture(t);
  const request: ReviewEnvelope = { ...data.request, profile: { kind: 'human' } };
  await assert.rejects(createExecutorRegistry().probe(request, data), error => errorCode(error) === 'HUMAN_ALARM_MISSING');
  let notified = false;
  const result = await createExecutorRegistry({ alarmMethods: [{ id: 'inbox', notify: () => { notified = true; } }] }).probe(request, data);
  assert.equal(result.ok, true);
  assert.equal(result.details.deliveryVerified, false);
  assert.equal(result.details.notificationsSent, false);
  assert.equal(notified, false);
});

test('copy doctor diagnoses current files without Git, deduplicates profiles and leaves no review state', async t => {
  const data = await fixture(t);
  await writeFile(join(data.repoPath, 'why.md'), 'Current edited why.');
  await writeFile(join(data.repoPath, 'new-file.txt'), 'A new untracked file.');
  const expectedHash = await fingerprintWorkspace(data.repoPath);
  const probes: ReviewEnvelope[] = [], paths: string[] = [], events: ExecutionEvent[] = [];
  const executors = { probe: async (request: ReviewEnvelope, options: ExecutionContext): Promise<ProbeResult> => {
    probes.push(request);
    paths.push(options.worktreePath);
    assert.equal(request.snapshotHash, expectedHash);
    assert.notEqual(options.worktreePath, data.repoPath);
    assert.equal(await readFile(join(options.worktreePath, 'why.md'), 'utf8'), 'Current edited why.');
    assert.equal(await readFile(join(options.worktreePath, 'new-file.txt'), 'utf8'), 'A new untracked file.');
    // Builders may edit the original after capture; the doctor sees one stable copy.
    await writeFile(join(data.repoPath, 'why.md'), 'Builder continues.');
    return { ok: true, message: 'unit probe', details: { operation: 'unit-test-probe' } };
  } };
  const report = await diagnoseProject({ ...data, executors, onEvent: event => { events.push(event); } });
  assert.equal(report.status, 'READY', JSON.stringify(report));
  assert.deepEqual(report.scope, { kind: 'chain' });
  assert.equal(report.mode, 'copy');
  assert.equal(report.snapshotHash, expectedHash);
  assert.equal(probes.length, 3);
  assert.equal(report.checks.find(check => check.kind === 'artifacts')?.details?.readLimitLinesPerFile, 80);
  assert.equal(new Set(paths).size, 1);
  assert.deepEqual(report.checks.find(check => check.kind === 'agent')?.criticIds, ['first', 'second']);
  assert.equal(events.filter(event => event.type === 'doctor.check').length, report.checks.length);
  assert.equal(await readFile(join(data.repoPath, 'why.md'), 'utf8'), 'Builder continues.');
  assert.equal((await readdir(data.repoPath)).includes('.ccdd'), false);
  assert.equal((await readdir(data.stateDir)).some(name => /sqlite|run|history/.test(name)), false);
  assert.equal(JSON.stringify(report).includes('verdict'), false);
});

test('selected doctor scope probes only that Critic and returns actionable NOT_READY failures', async t => {
  const data = await fixture(t);
  const probes: string[] = [];
  const report = await diagnoseProject({ ...data, criticId: 'second', executors: { probe: async (request: ReviewEnvelope) => { probes.push(request.criticId); throw Object.assign(new Error('Authentication required'), { code: 'AUTHENTICATION_FAILED', remedy: 'Login again' }); } } });
  assert.equal(report.status, 'NOT_READY');
  assert.deepEqual(report.scope, { kind: 'critic', criticId: 'second' });
  assert.deepEqual(probes, ['second'], JSON.stringify(report));
  assert.equal(report.checks.at(-1)?.details?.code, 'AUTHENTICATION_FAILED');
  const missing = await diagnoseProject({ ...data, criticId: 'unknown', executors: { probe: () => { throw new Error('must not probe'); } } });
  assert.equal(missing.ok, false);
  assert.match(missing.checks.find(check => check.id === 'workspace-config')!.message, /Unknown Critic/);
});

test('project doctor rejects unavailable credentials and unsupported profiles before provider execution', async t => {
  const data = await fixture(t);
  const report = await diagnoseProject({ ...data, criticId: 'first', executors: createExecutorRegistry({ piOptions: { authFile: join(data.dir, 'missing-auth.json') } }) });
  assert.equal(report.status, 'NOT_READY');
  assert.equal(report.checks.at(-1)?.details?.code, 'AUTHENTICATION_FAILED');
  await assert.rejects(createExecutorRegistry().probe({ ...data.request, profile: { kind: 'agent', provider: 'unregistered', model: 'gpt-6-astra', reasoning: 'medium' } }, data), error => errorCode(error) === 'PROVIDER_NOT_REGISTERED');
  await assert.rejects(createExecutorRegistry().probe({ ...data.request, profile: { kind: 'agent', provider: 'openai-codex', model: 'missing-model', reasoning: 'medium' } }, data), error => errorCode(error) === 'MODEL_NOT_REGISTERED');
});

test('identical runtime commands are checked for each Critic artifact scope', async t => {
  const data = await fixture(t);
  const profile = data.config.critics[2].profile;
  data.config.critics = [
    { ...data.config.critics[0], profile, artifacts: ['tests'] },
    { ...data.config.critics[1], profile, artifacts: ['why'] },
  ];
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  const report = await diagnoseProject({ ...data, executors: createExecutorRegistry() });
  const runtimeChecks = report.checks.filter(check => check.kind === 'runtime');
  assert.equal(runtimeChecks.length, 2, JSON.stringify(report));
  assert.equal(runtimeChecks[0].status, 'PASS');
  assert.equal(runtimeChecks[1].status, 'FAIL');
  assert.equal(runtimeChecks[1].details?.code, 'RUNTIME_TEST_PATH_OUTSIDE_ARTIFACTS');
});

test('lock doctor checks full Agent profiles and rejects workspace changes outside Artifact scope', async t => {
  const data = await fixture(t);
  const secondProfile = data.config.critics[1].profile;
  assert.ok(secondProfile.kind === 'agent');
  secondProfile.timeoutMs = 2_500;
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  const probes: string[] = [];
  const report = await diagnoseProject({ ...data, mode: 'lock', executors: { probe: async (request: ReviewEnvelope, options: ExecutionContext): Promise<ProbeResult> => {
    probes.push(request.criticId);
    assert.equal(await readFile(join(options.worktreePath, 'why.md'), 'utf8'), 'Current why.');
    if (request.criticId === 'human') await writeFile(join(options.worktreePath, 'unrelated-new-file.txt'), 'Changed during diagnosis.');
    return { ok: true, message: 'unit-test probe', details: {} };
  } } });
  assert.equal(probes.length, 4);
  assert.equal(report.status, 'NOT_READY');
  assert.equal(report.checks.at(-1)?.details?.code, 'WORKSPACE_CHANGED');
});

test('doctor nonce lives in private scratch and does not alter a readonly input', async t => {
  const data = await fixture(t);
  const before = await fingerprintWorkspace(data.worktreePath);
  await chmod(data.worktreePath, 0o500);
  const transport = artifactStream();
  let diagnosticPath = '';
  const streamFn: StreamFn = async (model, context, options) => {
    const name = (await readdir(data.runDir)).find(entry => entry.startsWith('diagnostic-input-'));
    assert.ok(name);
    diagnosticPath = join(data.runDir, name);
    const files = await readdir(diagnosticPath);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\.ccdd-doctor-/);
    assert.equal(context.tools?.length, 1);
    assert.match(context.tools![0].name, /^read_ccdd_probe_/);
    return transport(model, context, options);
  };
  const result = await createExecutorRegistry({ streamFn }).probe(data.request, data);
  assert.equal(result.ok, true);
  assert.equal(await fingerprintWorkspace(data.worktreePath), before);
  assert.notEqual(diagnosticPath, data.worktreePath);
  await assert.rejects(access(diagnosticPath));
});

test('doctor cleans ephemeral copy and diagnostic outputs when no state directory is supplied', async t => {
  const data = await fixture(t);
  let input: string | undefined, output: string | undefined;
  const report = await diagnoseProject({ repoPath: data.repoPath, criticId: 'first', executors: { probe: async (_request: ReviewEnvelope, options: ExecutionContext): Promise<ProbeResult> => {
    input = options.worktreePath;
    output = options.runDir;
    return { ok: true, message: 'unit-test probe', details: {} };
  } } });
  assert.equal(report.status, 'READY', JSON.stringify(report));
  assert.ok(input); assert.ok(output);
  await assert.rejects(access(input));
  await assert.rejects(access(output));
});

test('doctor validates executor workspace prerequisites before publishing any copied input', async t => {
  const data = await fixture(t);
  let checked = '', probed = false;
  const report = await diagnoseProject({ ...data, executors: {
    validateWorkspace: async repoPath => {
      checked = repoPath;
      throw Object.assign(new Error('An explicit auth file is inside the reviewed workspace'), { code: 'AUTHENTICATION_INSIDE_WORKSPACE', remedy: 'Move the auth file outside the workspace' });
    },
    probe: async () => { probed = true; return { ok: true, message: 'must not run', details: {} }; },
  } });
  assert.equal(checked, data.repoPath);
  assert.equal(probed, false);
  assert.equal(report.status, 'NOT_READY');
  assert.equal(report.snapshotHash, undefined);
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].id, 'workspace-preflight');
  assert.equal(report.checks[0].details?.code, 'AUTHENTICATION_INSIDE_WORKSPACE');
  await assert.rejects(access(data.stateDir));
});
