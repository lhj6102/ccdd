import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareDemo } from '../scripts/prepare-demo.mjs';
import { prepareReviewRequests } from '../src/requester/index.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-requester-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await prepareDemo({ root });
  return { ...manifest, snapshotCommit: manifest.scenarios[0].commit };
}

test('repo requester sends explicit artifact metadata, committed payload and provider requirements for each ordered review', async t => {
  const data = await fixture(t);
  const requests = await prepareReviewRequests({ ...data, repoId: 'focus-demo' });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(x => x.dependsOn), [null, 'spec-why', 'tests-spec']);
  assert.ok(requests.every(x => x.repoId === 'focus-demo' && x.snapshotCommit === data.snapshotCommit));
  assert.deepEqual(requests[0].artifacts, [{ id: 'why', type: 'markdown', path: 'why.md' }, { id: 'spec', type: 'markdown', path: 'spec.md' }]);
  assert.deepEqual(requests[1].artifacts, [{ id: 'spec', type: 'markdown', path: 'spec.md' }, { id: 'tests', type: 'code', path: 'tests' }]);
  assert.match(requests[0].payload.instruction, /Basis: \{why\}. Target: \{spec\}/);
  assert.equal(requests[0].profile.provider, 'codex');
  assert.equal(requests[0].profile.model, 'gpt-6-astra');
  assert.equal(requests[2].profile.kind, 'runtime');
  assert.deepEqual(requests[2].profile.args, ['--test', 'tests/rank.test.mjs']);
  assert.deepEqual(requests[0].artifactTypes.markdown, { viewer: 'text' });
  assert.ok(!('id' in requests[0]) && !('runId' in requests[0]) && !('status' in requests[0]), 'The requester does not invent broker handles or execution state');
  requests[0].artifactTypes.markdown.viewer = 'changed';
  assert.equal(requests[1].artifactTypes.markdown.viewer, 'text', 'Request envelopes have independent values');
});

test('preparing requests reads the named commit without depending on or rewriting the mutable checkout', async t => {
  const data = await fixture(t);
  const original = await prepareReviewRequests(data);
  const configPath = join(data.repoPath, 'ccdd.config.json');
  const whyPath = join(data.repoPath, 'why.md');
  await writeFile(configPath, '{"uncommitted":"invalid config"}\n');
  await writeFile(whyPath, 'Mutable checkout should remain untouched.\n');
  const git = (...args) => execFileSync('git', ['-C', data.repoPath, ...args], { encoding: 'utf8' });
  const before = git('status', '--porcelain');
  assert.deepEqual(await prepareReviewRequests(data), original);
  assert.equal(git('status', '--porcelain'), before);
  assert.equal(await readFile(configPath, 'utf8'), '{"uncommitted":"invalid config"}\n');
  assert.equal(await readFile(whyPath, 'utf8'), 'Mutable checkout should remain untouched.\n');
  await assert.rejects(prepareReviewRequests({ ...data, snapshotCommit: 'HEAD' }), /full immutable Git commit/);
  await assert.rejects(prepareReviewRequests({ ...data, repoId: '' }), /repoId/);
});

test('selecting one Critic preserves its committed definition and excludes predecessor and downstream envelopes', async t => {
  const data = await fixture(t);
  const chain = await prepareReviewRequests(data);
  assert.deepEqual(await prepareReviewRequests({ ...data, criticId: 'tests-spec' }), [chain[1]]);
  assert.equal(chain[1].dependsOn, 'spec-why');
  assert.deepEqual(await prepareReviewRequests({ ...data, criticId: 'implementation-tests' }), [chain[2]]);
  await assert.rejects(prepareReviewRequests({ ...data, criticId: 'missing' }), /Unknown Critic/);
  for (const criticId of ['', ' ', '../spec-why', null, 1, ['spec-why']]) {
    await assert.rejects(prepareReviewRequests({ ...data, criticId }), /criticId/);
  }
});
