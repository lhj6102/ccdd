import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReviewRequests } from '../src/requester/index.mjs';
import { fingerprintWorkspace, prepareWorkspace, removeOwnedWorkspaceTree } from '../src/workspaces/index.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-requester-'));
  const repoPath = join(root, 'repo');
  const stateDir = join(root, 'state');
  await mkdir(repoPath);
  await mkdir(join(repoPath, 'tests'));
  await writeFile(join(repoPath, 'why.md'), 'Why');
  await writeFile(join(repoPath, 'spec.md'), 'Spec');
  await writeFile(join(repoPath, 'tests', 'rank.test.mjs'), '');
  const config = {
    artifacts: { why: { type: 'markdown', path: 'why.md' }, spec: { type: 'markdown', path: 'spec.md' }, tests: { type: 'code', path: 'tests' } },
    artifactTypes: { markdown: { viewer: 'text' }, code: { viewer: 'files' } },
    critics: [
      { id: 'spec-why', title: 'Spec fits Why', dependsOn: null, artifacts: ['why', 'spec'], profile: { kind: 'agent', provider: 'codex', model: 'gpt-6-astra', reasoning: 'medium' }, payload: { instruction: 'Basis: {why}. Target: {spec}' } },
      { id: 'tests-spec', title: 'Tests fit Spec', dependsOn: 'spec-why', artifacts: ['spec', 'tests'], profile: { kind: 'agent', provider: 'codex', model: 'gpt-6-astra', reasoning: 'medium' }, payload: { instruction: 'Compare tests and spec' } },
      { id: 'implementation-tests', title: 'Runtime', dependsOn: 'tests-spec', artifacts: ['tests'], profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/rank.test.mjs'] }, payload: { instruction: 'Run tests' } },
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
  assert.deepEqual(requests.map(x => x.dependsOn), [null, 'spec-why', 'tests-spec']);
  assert.ok(requests.every(x => x.repoId === 'focus-demo' && x.snapshotHash === data.snapshotHash && !('snapshotCommit' in x)));
  assert.deepEqual(requests[0].artifacts, [{ id: 'why', type: 'markdown', path: 'why.md' }, { id: 'spec', type: 'markdown', path: 'spec.md' }]);
  assert.match(requests[0].payload.instruction, /Basis: \{why\}. Target: \{spec\}/);
  assert.equal(requests[0].profile.provider, 'codex');
  assert.equal(requests[2].profile.kind, 'runtime');
  assert.ok(!('id' in requests[0]) && !('runId' in requests[0]) && !('status' in requests[0]));
  requests[0].artifactTypes.markdown.viewer = 'changed';
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
  assert.equal(chain[1].dependsOn, 'spec-why');
  await assert.rejects(prepareReviewRequests({ ...data, criticId: 'missing' }), /Unknown Critic/);
  for (const criticId of ['', ' ', '../spec-why', null, 1, ['spec-why']]) await assert.rejects(prepareReviewRequests({ ...data, criticId }), /criticId/);
});

test('configuration rejects unsafe paths and preserves the strictly linear Critic graph', async t => {
  const data = await fixture(t);
  data.config.artifacts.why.path = '../outside';
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  await assert.rejects(prepareReviewRequests(data), /safe repository-relative/);
  data.config.artifacts.why.path = 'why.md';
  data.config.critics[2].dependsOn = 'spec-why';
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  await assert.rejects(prepareReviewRequests(data), /strictly linear/);
});
