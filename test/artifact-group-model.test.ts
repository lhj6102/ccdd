import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveArtifactScope, validateArtifactDefinitions } from '../src/artifacts/groups.js';
import { readWorkspaceConfig, validateConfig } from '../src/broker/config.js';
import { createGraphDefinition, prerequisiteCriticIds, projectGraph } from '../src/broker/graph.js';
import type { ArtifactEntryDefinition, RepoConfig } from '../src/contracts.js';
import type { ArtifactDefinition, ArtifactGroupDefinition, Config } from '../src/sdk.js';

const leaf: ArtifactDefinition = { type: 'text', path: 'effect.txt' };
const group: ArtifactGroupDefinition = { kind: 'group', members: ['effect', 'preview'] };
const definitions: Record<string, ArtifactEntryDefinition> = {
  effect: leaf,
  preview: { type: 'text', path: 'preview.txt' },
  explosion: group,
  additional: { type: 'text', path: 'additional.txt' },
  bundle: { kind: 'group', members: ['explosion', 'preview', 'additional'] },
  outside: { type: 'text', path: 'outside.txt' },
};
const profile = { kind: 'human' } as const;
const critic = (id: string, target: string, deps: string[] = []) => ({ id, title: id, target, deps, profile, payload: { instruction: 'Review the target.' } });
function config(): RepoConfig {
  return {
    artifacts: structuredClone(definitions),
    artifactTypes: { text: { viewer: 'text', humanTools: { read: {} } } },
    critics: [critic('group-review', 'explosion'), critic('effect-review', 'effect'), critic('preview-review', 'preview'), critic('publish', 'outside', ['explosion'])],
  };
}
const tree = Object.values(definitions).flatMap(artifact => 'path' in artifact ? [{ path: artifact.path, type: 'blob', mode: '100644' }] : []);

test('group references expand into stable deduplicated leaves and preserve independent member IDs', () => {
  const scope = resolveArtifactScope(definitions, ['bundle', 'effect', 'explosion']);
  assert.deepEqual(scope, {
    artifacts: [
      { id: 'effect', type: 'text', path: 'effect.txt' },
      { id: 'preview', type: 'text', path: 'preview.txt' },
      { id: 'additional', type: 'text', path: 'additional.txt' },
    ],
    artifactGroups: [
      { id: 'bundle', members: ['explosion', 'preview', 'additional'] },
      { id: 'explosion', members: ['effect', 'preview'] },
    ],
  });
  assert.deepEqual(resolveArtifactScope(definitions, ['preview']), { artifacts: [{ id: 'preview', type: 'text', path: 'preview.txt' }] });
  assert.throws(() => resolveArtifactScope(definitions, ['missing']), /Unknown Artifact/);
  scope.artifactGroups![1].members.pop();
  assert.deepEqual(group.members, ['effect', 'preview']);
  const sdkConfig: Config = { artifacts: definitions, artifactTypes: {}, critics: [] };
  assert.equal(sdkConfig.artifacts.explosion, group);
});

test('group shape validation rejects unknown, duplicate, empty, and cyclic membership', () => {
  for (const invalid of [
    { ...definitions, explosion: { kind: 'group', members: [] } },
    { ...definitions, explosion: { kind: 'group', members: ['missing'] } },
    { ...definitions, explosion: { kind: 'group', members: ['effect', 'effect'] } },
    { ...definitions, explosion: { kind: 'group', members: ['effect'], path: 'effects' } },
    { ...definitions, explosion: { kind: 'group', members: ['effect'], type: 'text' } },
    { ...definitions, explosion: { kind: 'group', members: ['effect'], basis: 'true' } },
    { ...definitions, effect: { type: 'text', path: 'effect.txt', members: ['preview'] } },
  ]) assert.throws(() => validateArtifactDefinitions(invalid));
  assert.throws(() => validateArtifactDefinitions({ ...definitions, explosion: { kind: 'group', members: ['bundle'] } }), /membership.*cycle/);
  assert.throws(() => validateArtifactDefinitions({ ...definitions, explosion: { kind: 'group', members: ['explosion'] } }), /membership.*cycle/);
});

test('membership changes neither verdicts nor dependency edges; group critics aggregate independently', () => {
  const c = config();
  c.critics.push(critic('group-second-opinion', 'explosion'));
  const graph = createGraphDefinition(c);
  const membersGreen = projectGraph(graph, [
    { id: 'effect-request', criticId: 'effect-review', status: 'GREEN' },
    { id: 'preview-request', criticId: 'preview-review', status: 'GREEN' },
  ]);
  assert.equal(membersGreen.artifacts.find(a => a.id === 'explosion')?.status, 'UNREVIEWED');
  const onePassed = projectGraph(graph, [{ id: 'request-one', criticId: 'group-review', status: 'GREEN' }]);
  assert.equal(onePassed.artifacts.find(a => a.id === 'explosion')?.status, 'UNREVIEWED');
  const allPassed = projectGraph(graph, [
    { id: 'request-one', criticId: 'group-review', status: 'GREEN' },
    { id: 'request-two', criticId: 'group-second-opinion', status: 'GREEN' },
  ]);
  const explosion = allPassed.artifacts.find(a => a.id === 'explosion')!;
  assert.deepEqual(explosion, { id: 'explosion', kind: 'group', members: ['effect', 'preview'], basis: false, status: 'GREEN', criticIds: ['group-review', 'group-second-opinion'], passed: 2, total: 2, included: 2 });
  assert.equal(allPassed.artifacts.find(a => a.id === 'effect')?.status, 'UNREVIEWED');
  assert.equal(allPassed.artifacts.find(a => a.id === 'preview')?.status, 'UNREVIEWED');
  assert.deepEqual(allPassed.edges, [{ source: 'explosion', target: 'outside', criticIds: ['publish'] }]);
  assert.deepEqual(prerequisiteCriticIds(c.critics[0], graph), []);
  assert.deepEqual(prerequisiteCriticIds(c.critics[3], graph), ['group-review', 'group-second-opinion']);
});

test('member prerequisites are explicit and groups follow the existing target, basis and DAG rules', () => {
  const c = config();
  c.critics[0].deps = ['effect'];
  const graph = createGraphDefinition(c);
  assert.deepEqual(prerequisiteCriticIds(c.critics[0], graph), ['effect-review']);
  assert.deepEqual(projectGraph(graph, []).edges.map(({ source, target }) => [source, target]), [['effect', 'explosion'], ['explosion', 'outside']]);
  c.critics[1].deps = ['explosion'];
  assert.throws(() => createGraphDefinition(c), /dependencies.*DAG/);
  const basis = config();
  basis.critics = [critic('publish', 'outside', ['explosion'])];
  assert.throws(() => createGraphDefinition(basis), /Dependency Artifact explosion has no Critic/);
  basis.artifacts.explosion.basis = true;
  const basisGraph = createGraphDefinition(basis);
  assert.equal(projectGraph(basisGraph, []).artifacts.find(a => a.id === 'explosion')?.status, 'BASIS');
  assert.equal(projectGraph(basisGraph, []).artifacts.find(a => a.id === 'effect')?.status, 'UNREVIEWED');
  basis.critics.push(critic('invalid', 'explosion'));
  assert.throws(() => createGraphDefinition(basis), /Basis Artifact explosion cannot also be/);
});

test('workspace config validates leaf files and preserves pathless group definitions', async () => {
  const c = config();
  validateConfig(c, tree);
  const missing = tree.filter(entry => entry.path !== 'effect.txt');
  assert.throws(() => validateConfig(c, missing), /without symlinks: effect/);
  const folder = await mkdtemp(path.join(os.tmpdir(), 'ccdd-group-config-'));
  try {
    await Promise.all(tree.map(entry => writeFile(path.join(folder, entry.path), entry.path)));
    await writeFile(path.join(folder, 'ccdd.config.json'), JSON.stringify(c));
    const loaded = await readWorkspaceConfig(folder);
    assert.deepEqual(loaded.config.artifacts.explosion, group);
    assert.deepEqual(loaded.config.artifacts.bundle, definitions.bundle);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
