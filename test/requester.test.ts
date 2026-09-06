import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReviewRequests, readStoredArtifactScope } from '../src/requester/index.js';
import { createBroker } from '../src/broker/index.js';
import { validateArtifactType, toolDescription } from '../src/artifacts/types.js';
import { fingerprintWorkspace, prepareWorkspace, removeOwnedWorkspaceTree } from '../src/workspaces/index.js';
import type { RepoConfig, ArtifactDefinition } from '../src/contracts.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-requester-'));
  const repoPath = join(root, 'repo');
  const stateDir = join(root, 'state');
  await mkdir(repoPath);
  await mkdir(join(repoPath, 'tests'));
  await writeFile(join(repoPath, 'why.md'), 'Why');
  await writeFile(join(repoPath, 'spec.md'), 'Spec');
  await writeFile(join(repoPath, 'tests', 'rank.test.mjs'), '');
  const config: Omit<RepoConfig, 'artifacts'> & { artifacts: Record<string, ArtifactDefinition> } = {
    artifacts: { why: { type: 'markdown', path: 'why.md', basis: true }, spec: { type: 'markdown', path: 'spec.md' }, tests: { type: 'code', path: 'tests' } },
    artifactTypes: { markdown: { viewer: 'text', agentTools: { read: {} }, humanTools: { read: {} } }, code: { viewer: 'files', agentTools: { list: {}, read: {} }, humanTools: { list: {}, read: {} } } },
    critics: [
      { id: 'spec-why', title: 'Spec fits Why', target: 'spec', deps: ['why'], profile: { kind: 'agent', provider: 'codex', model: 'gpt-6-astra', reasoning: 'medium' }, payload: { instruction: 'Basis: {why}. Target: {spec}' } },
      { id: 'tests-spec', title: 'Tests fit Spec', target: 'tests', deps: ['spec'], profile: { kind: 'agent', provider: 'codex', model: 'gpt-6-astra', reasoning: 'medium' }, payload: { instruction: 'Compare tests and spec' } },
      { id: 'implementation-tests', title: 'Runtime', target: 'tests', deps: ['spec'], profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/rank.test.mjs'] }, payload: { instruction: 'Run tests' } },
    ],
  };
  await writeFile(join(repoPath, 'ccdd.config.json'), JSON.stringify(config));
  t.after(() => removeOwnedWorkspaceTree(root));
  return { root, repoPath, stateDir, config, snapshotHash: await fingerprintWorkspace(repoPath) };
}

test('requester sends explicit artifact metadata, workspace hash, payload and provider requirements without Git', async t => {
  const data = await fixture(t);
  const requests = await prepareReviewRequests({ ...data, repoId: 'focus-demo' });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(x => [x.target,x.deps]), [['spec',['why']],['tests',['spec']],['tests',['spec']]]);
  assert.ok(requests.every(x => !('dependsOn' in x)));
  assert.ok(requests.every(x => x.repoId === 'focus-demo' && x.snapshotHash === data.snapshotHash && !('snapshotCommit' in x)));
  assert.deepEqual(requests[0].artifacts, [{ id: 'spec', type: 'markdown', path: 'spec.md' }, { id: 'why', type: 'markdown', path: 'why.md' }]);
  assert.match(requests[0].payload.instruction, /Basis: \{why\}. Target: \{spec\}/);
  assert.equal(requests[0].profile.kind, 'agent');
  assert.ok(requests[0].profile.kind === 'agent');
  assert.equal(requests[0].profile.provider, 'codex');
  assert.equal(requests[2].profile.kind, 'runtime');
  assert.ok(!('id' in requests[0]) && !('runId' in requests[0]) && !('status' in requests[0]));
  requests[0].artifactTypes.markdown.viewer = 'files';
  assert.equal(requests[1].artifactTypes.markdown.viewer, 'text');
});

test('requester reads current definitions including edits, and copied definitions remain fixed', async t => {
  const data = await fixture(t);
  const copied = await prepareWorkspace({ ...data, mode: 'copy' });
  t.after(() => copied.close());
  const original = await prepareReviewRequests({ ...data, repoPath: copied.descriptor.path, snapshotHash: copied.descriptor.hash });
  data.config.critics[0].payload.instruction = 'Changed current definition';
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  const current = await prepareReviewRequests({ ...data, snapshotHash: await fingerprintWorkspace(data.repoPath) });
  assert.equal(current[0].payload.instruction, 'Changed current definition');
  assert.notEqual(current[0].snapshotHash, original[0].snapshotHash);
  assert.deepEqual(await prepareReviewRequests({ ...data, repoPath: copied.descriptor.path, snapshotHash: copied.descriptor.hash }), original);
  await writeFile(join(data.repoPath, 'ccdd.config.json'), '{"invalid":true}');
  await assert.rejects(prepareReviewRequests(data), /Config requires/);
  assert.equal(await readFile(join(data.repoPath, 'ccdd.config.json'), 'utf8'), '{"invalid":true}');
  await assert.rejects(prepareReviewRequests({ ...data, snapshotHash: 'HEAD' }), /workspace SHA-256/);
  await assert.rejects(prepareReviewRequests({ ...data, repoId: '' }), /repoId/);
});

test('selecting one Critic preserves its definition and excludes other envelopes', async t => {
  const data = await fixture(t);
  const chain = await prepareReviewRequests(data);
  assert.deepEqual(await prepareReviewRequests({ ...data, criticId: 'tests-spec' }), [chain[1]]);
  assert.equal(chain[1].target, 'tests');
  assert.deepEqual(chain[1].deps, ['spec']);
  await assert.rejects(prepareReviewRequests({ ...data, criticId: 'missing' }), /Unknown Critic/);
  for (const criticId of ['', ' ', '../spec-why', null, 1, ['spec-why']]) await assert.rejects(prepareReviewRequests({ ...data, criticId }), /criticId/);
});

test('configuration rejects unsafe paths and Artifact dependency cycles', async t => {
  const data = await fixture(t);
  data.config.artifacts.why.path = '../outside';
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  await assert.rejects(prepareReviewRequests(data), /safe repository-relative/);
  data.config.artifacts.why.path = 'why.md';
  data.config.critics[0].deps = ['tests'];
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  await assert.rejects(prepareReviewRequests(data), /cycle/);
});

test('legacy Critic config is rejected for admission but its historical Artifact scope remains readable', async t => {
  const data = await fixture(t);
  const historical = { ...data.config, critics: data.config.critics.map((critic, index) => {
    const { target, deps, ...rest } = critic;
    return { ...rest, artifacts: [target, ...deps], dependsOn: index ? data.config.critics[index - 1].id : null };
  }) };
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(historical));
  await assert.rejects(prepareReviewRequests(data), /replaced by target/);
  const scope = await readStoredArtifactScope({ repoPath: data.repoPath, criticId: 'spec-why' });
  assert.deepEqual(scope.artifacts.map(a => a.id), ['spec', 'why']);
  assert.ok(!('target' in scope) && !('deps' in scope));
  historical.artifacts.spec.path = '../private';
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(historical));
  await assert.rejects(readStoredArtifactScope({ repoPath: data.repoPath, criticId: 'spec-why' }), /safe repository-relative/);
});

test('Critic array order has no effect on declared roles and every target/dep receives a tool', async t => {
  const data = await fixture(t);
  data.config.critics.reverse();
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  const selected = (await prepareReviewRequests({ ...data, criticId: 'spec-why' }))[0];
  assert.equal(selected.target, 'spec'); assert.deepEqual(selected.deps, ['why']);
  assert.deepEqual(selected.artifacts.map(a => a.id), ['spec', 'why']);
  data.config.artifacts.why.basis = false;
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  await assert.rejects(prepareReviewRequests(data), /no Critic.*basis/);
});

test('repo-defined types preserve description templates in isolated request envelopes', async t => {
  const data = await fixture(t);
  data.config.artifactTypes = {
    requirements: { viewer: 'text', agentTools: { read: { description: '{artifactName}의 요구사항을 읽고 {artifactName}에서 근거를 찾는다.' } } },
    test_suite: { viewer: 'files', agentTools: { read: {}, list: { description: '{artifactName}의 테스트 파일 목록을 조회한다.' } } },
  };
  data.config.artifacts.why.type = 'requirements';
  data.config.artifacts.spec.type = 'requirements';
  data.config.artifacts.tests.type = 'test_suite';
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  const requests = await prepareReviewRequests({ ...data, snapshotHash: await fingerprintWorkspace(data.repoPath) });
  assert.deepEqual(requests[0].artifactTypes, data.config.artifactTypes);
  assert.deepEqual(requests[1].artifactTypes, data.config.artifactTypes);
  assert.equal(requests[0].artifacts[1].type, 'requirements');
  assert.equal(toolDescription(requests[0].artifactTypes.requirements, 'read', 'spec', 'agent'), 'spec의 요구사항을 읽고 spec에서 근거를 찾는다.');
  assert.equal(toolDescription(requests[0].artifactTypes.requirements, 'read', 'why', 'agent'), 'why의 요구사항을 읽고 why에서 근거를 찾는다.');
  assert.equal(toolDescription(requests[1].artifactTypes.test_suite, 'list', 'tests', 'agent'), 'tests의 테스트 파일 목록을 조회한다.');
  assert.match(toolDescription(requests[1].artifactTypes.test_suite, 'read', 'tests'), /tests.*line ranges/);
  requests[0].artifactTypes.requirements.agentTools!.read!.description = 'Changed envelope';
  assert.equal(requests[1].artifactTypes.requirements.agentTools!.read!.description, data.config.artifactTypes.requirements.agentTools!.read!.description);
});

test('old type definitions keep built-in descriptions and template replacement is literal', () => {
  assert.deepEqual(validateArtifactType('custom_text', { viewer: 'text' }), { viewer: 'text' });
  assert.match(toolDescription({ viewer: 'text' }, 'read', 'spec'), /spec.*line ranges/);
  assert.match(toolDescription({ viewer: 'files', tools: {} }, 'read', 'tests'), /tests/);
  assert.match(toolDescription({ viewer: 'files', tools: {} }, 'list', 'tests'), /tests/);
  const definition = { viewer: 'text', tools: { read: { description: '{artifactName} / {artifactName}' } } };
  assert.equal(toolDescription(definition, 'read', '$&'), '$& / $&');
  assert.equal(toolDescription({ viewer: 'text', tools: { read: { description: 'Read the supplied document.' } } }, 'read', 'spec'), 'Read the supplied document.');
  assert.throws(() => toolDescription({ viewer: 'text' }, 'list', 'spec'), /Unsupported artifact tool/);
});

test('new requests require audience tools on every supplied Artifact while an independent runtime remains selectable', async t => {
  const data = await fixture(t);
  const save = () => writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  data.config.artifactTypes.markdown = { viewer: 'text', humanTools: { read: {} } };
  await save();
  await assert.rejects(prepareReviewRequests({ ...data, criticId: 'spec-why' }), /spec has no agent tools/);
  const runtime = await prepareReviewRequests({ ...data, criticId: data.config.critics[2].id });
  assert.equal(runtime[0].profile.kind, 'runtime');
  data.config.critics[0].profile = { kind: 'human' };
  await save();
  assert.equal((await prepareReviewRequests({ ...data, criticId: 'spec-why' }))[0].profile.kind, 'human');
  data.config.artifacts.spec.type = 'disabled';
  data.config.artifactTypes.disabled = { viewer: 'text', humanTools: {}, agentTools: { read: {} } };
  await save();
  await assert.rejects(prepareReviewRequests({ ...data, criticId: 'spec-why' }), /spec has no human tools/);
  data.config.artifactTypes.disabled = { viewer: 'text', tools: { read: { description: 'Legacy description' } } };
  await save();
  await assert.rejects(prepareReviewRequests({ ...data, criticId: 'spec-why' }), /spec has no human tools/);
});

test('a configured list operation cannot make a file Artifact reviewable', async t => {
  const data = await fixture(t);
  data.config.artifactTypes.markdown = { viewer: 'files', agentTools: { list: {} } };
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  await assert.rejects(prepareReviewRequests({ ...data, criticId: 'spec-why' }), /no usable agent tools/);
});

test('malformed type tool definitions are rejected before Provider checks or request persistence', async t => {
  const data = await fixture(t);
  const calls: string[] = [];
  const broker = createBroker({ repoPath: data.repoPath, stateDir: data.stateDir, executors: {
    canExecute: request => { calls.push(request.criticId); return { ok: true }; },
    execute: async () => { throw new Error('Invalid configuration must not execute.'); },
  } });
  t.after(() => broker.close());
  const invalid = [
    { viewer: 'text', description: 'Unknown type field' },
    { viewer: 'text', tools: null },
    { viewer: 'text', tools: [] },
    { viewer: 'text', tools: { list: { description: 'Not supported for text' } } },
    { viewer: 'files', tools: { write: { description: 'Not a viewer operation' } } },
    { viewer: 'text', tools: { read: null } },
    { viewer: 'text', tools: { read: 'A bare string is not a tool definition' } },
    { viewer: 'text', tools: { read: {} } },
    { viewer: 'text', tools: { read: { description: 'Read', enabled: true } } },
    { viewer: 'text', tools: { read: { description: '' } } },
    { viewer: 'text', tools: { read: { description: ' \n\t ' } } },
    { viewer: 'text', tools: { read: { description: 42 } } },
    { viewer: 'text', tools: { read: { description: 'x'.repeat(4001) } } },
    { viewer: 'text', tools: { read: { description: 'Read {artifactPath}' } } },
    { viewer: 'text', tools: { read: { description: 'Read {artifactName' } } },
    { viewer: 'text', tools: { read: { description: 'Read {{artifactName}}' } } },
  ];
  for (const definition of invalid) {
    Reflect.set(data.config.artifactTypes, 'markdown', definition);
    await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
    await assert.rejects(broker.submit({ requesterId: 'builder', mode: 'copy' }), /artifact (type|.*tool)/i);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(broker.listRuns(), []);
});
