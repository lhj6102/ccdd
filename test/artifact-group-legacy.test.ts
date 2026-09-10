import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroker } from '../src/broker/index.js';
import { projectGraph } from '../src/broker/graph.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { removeOwnedWorkspaceTree } from '../src/workspaces/index.js';
import type { RepoConfig } from '../src/contracts.js';

test('JSON Human group review resumes from its copied composition and reads leaf tools after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-group-legacy-'));
  const repoPath = join(dir, 'repo'), stateDir = join(dir, 'state');
  const brokers: ReturnType<typeof createBroker>[] = [];
  t.after(async () => { for (const broker of brokers) await broker.close(); await removeOwnedWorkspaceTree(dir); });
  await mkdir(repoPath);
  for (const [id, content] of Object.entries({ why: 'Original purpose.', spec: 'Original specification.', preview: 'Original preview notes.', outside: 'Outside the requested review.' })) {
    await writeFile(join(repoPath, `${id}.md`), content);
  }
  const config: RepoConfig = {
    artifacts: {
      why: { type: 'markdown', path: 'why.md', basis: true },
      spec: { type: 'markdown', path: 'spec.md' },
      preview: { type: 'markdown', path: 'preview.md' },
      outside: { type: 'markdown', path: 'outside.md' },
      pair: { kind: 'group', members: ['spec', 'preview'] },
      bundle: { kind: 'group', members: ['pair', 'spec'] },
    },
    artifactTypes: { markdown: { viewer: 'text', agentTools: { read: {} }, humanTools: { read: {} } } },
    critics: [{ id: 'group-review', title: 'Review the document group', target: 'bundle', deps: ['why'], profile: { kind: 'human' }, payload: { instruction: 'Compare {bundle} with {why}.' } }],
  };
  const configPath = join(repoPath, 'ccdd.config.json');
  await writeFile(configPath, JSON.stringify(config));
  let notifications = 0;
  const executors = createExecutorRegistry({ alarmMethods: [async () => { notifications++; }] });
  const open = () => {
    const broker = createBroker({ repoPath, stateDir, executors });
    brokers.push(broker); return broker;
  };
  const first = open(), submitted = await first.submit({ mode: 'copy', requesterId: 'builder' });
  await first.run(submitted.id);
  const waiting = first.getRun(submitted.id)!;
  assert.equal(waiting.status, 'WAITING_HUMAN');
  assert.equal(waiting.owner, null);
  assert.equal(notifications, 1);
  const request = waiting.requests[0];
  const groups = [{ id: 'bundle', members: ['pair', 'spec'] }, { id: 'pair', members: ['spec', 'preview'] }];
  assert.equal(request.configManifest, undefined, 'This regression exercises the JSON Viewer compatibility path');
  assert.deepEqual(request.artifactGroups, groups);
  assert.deepEqual(request.artifacts.map(artifact => artifact.id), ['spec', 'preview', 'why']);
  await first.close();

  // A resumed copy review must retain the submitted grouping and file contents.
  config.artifacts.bundle = { kind: 'group', members: ['outside'] };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(join(repoPath, 'spec.md'), 'Builder has a newer specification.');
  const resumed = open();
  assert.deepEqual(resumed.getRequest(request.id)?.artifactGroups, groups);
  await assert.rejects(resumed.executeHumanTool(request.id, { reviewerId: 'reviewer', toolName: 'read_spec' }), /reviewer who claimed/);
  await resumed.claimHuman(request.id, 'reviewer');
  for (const [id, content] of [['spec', 'Original specification.'], ['preview', 'Original preview notes.'], ['why', 'Original purpose.']]) {
    const result = await resumed.executeHumanTool(request.id, { reviewerId: 'reviewer', toolName: `read_${id}` });
    assert.ok('content' in result);
    assert.equal(result.content, content);
  }
  await assert.rejects(resumed.executeHumanTool(request.id, { reviewerId: 'reviewer', toolName: 'read_bundle' }), /Unknown/);
  await assert.rejects(resumed.executeHumanTool(request.id, { reviewerId: 'reviewer', toolName: 'read_outside' }), /Unknown/);
  assert.equal(resumed.getRequest(request.id)?.status, 'WAITING_HUMAN');
  assert.equal(resumed.getRequest(request.id)?.result, null);
  assert.deepEqual(resumed.getRequest(request.id)?.artifactGroups, groups);
  await resumed.completeHuman(request.id, { reviewerId: 'reviewer', result: {
    verdict: 'GREEN', summary: 'Reviewed the submitted document group.', evidence: ['The original specification and preview notes match the purpose.'],
  } });
  await resumed.close();

  const completed = open().getRun(submitted.id)!;
  assert.equal(completed.status, 'GREEN');
  assert.deepEqual(completed.requests[0].artifactGroups, groups);
  const graph = projectGraph(completed.graph!, completed.requests);
  assert.equal(graph.artifacts.find(artifact => artifact.id === 'bundle')?.status, 'GREEN');
  for (const id of ['pair', 'spec', 'preview']) assert.equal(graph.artifacts.find(artifact => artifact.id === id)?.status, 'UNREVIEWED');
  assert.equal(notifications, 1, 'Resuming the saved Human review must not send another alarm');
});
